import path from "node:path";
import { config } from "./config.mjs";
import { loadPrompt, renderPrompt, runClaude } from "./claude.mjs";
import {
  extractFindings,
  findCodexReview,
  findingsFingerprint,
  isCleanReview,
} from "./codex.mjs";
import * as git from "./git.mjs";
import * as github from "./github.mjs";
import * as linear from "./linear.mjs";
import { note, runDir, transition, worktreePath } from "./state.mjs";
import { renderThreads, splitThreads } from "./threads.mjs";
import { escalate, FOOTER } from "./actions.mjs";
import { CODE_TOOLS, readJson } from "./implement.mjs";
import { gatedPush } from "./e2e.mjs";

// After a push, Codex's review takes up to 30 minutes. Wait this long for a
// review of the current head before proceeding on CI and human threads alone.
const CODEX_WAIT_MS = 2 * 60 * 60_000;

/**
 * Decide what the review loop should do for the PR's current head. Pure.
 * Returns { action: 'wait' | 'done' | 'draft_ready' | 'fix' | 'escalate', problems, why }.
 *
 * `done` needs all of: CI reported success, a clean Codex review of this head,
 * no unresolved review thread (neither fresh ones nor ones the bot answered
 * and a human has yet to resolve). A head with no checks reported (`none`) or
 * no Codex review is "not reported yet"; after the wait window that escalates
 * instead of finishing, since this repository runs both on every PR.
 */
export function assessHead({
  pr,
  codex,
  ci,
  threads,
  awaitingHuman = [],
  headSeenAt,
  now = Date.now(),
}) {
  const problems = [];
  if (ci === "failure") problems.push("ci");
  if (codex && !isCleanReview(codex.body)) problems.push("codex");
  if (threads.length) problems.push("threads");
  if (problems.length) return { action: "fix", problems };

  const waited = headSeenAt ? now - new Date(headSeenAt).getTime() : 0;
  if (ci === "pending")
    return { action: "wait", problems, why: "CI still running" };
  if (ci !== "success") {
    if (waited < CODEX_WAIT_MS)
      return { action: "wait", problems, why: "no CI result reported yet" };
    return {
      action: "escalate",
      problems,
      why: "no CI result was reported for this head within the wait window",
    };
  }
  if (awaitingHuman.length) {
    return {
      action: "wait",
      problems,
      why: `${awaitingHuman.length} thread(s) answered by the bot await a human`,
    };
  }
  if (pr.isDraft) return { action: "draft_ready", problems };
  if (!codex) {
    if (waited < CODEX_WAIT_MS)
      return { action: "wait", problems, why: "waiting for the Codex review" };
    return {
      action: "escalate",
      problems,
      why: "no Codex review arrived for this head within the wait window",
    };
  }
  return {
    action: "done",
    problems,
    why: "Codex clean, CI green, no open threads",
  };
}

export async function review(issue, record) {
  const pr = await github.viewPr(record.pr.number);
  record.pr.draft = pr.isDraft;
  if (pr.state === "MERGED") {
    await git.removeWorktree(worktreePath(record.identifier));
    return transition(record, "done", `PR merged ${pr.url}`);
  }
  if (pr.state === "CLOSED") {
    return transition(record, "done", `PR closed without merge ${pr.url}`);
  }

  const sha = pr.headRefOid;
  record.review ??= { rounds: 0 };
  if (record.review.headSha !== sha) {
    record.review.headSha = sha;
    record.review.headSeenAt = new Date().toISOString();
  }
  const ci = github.ciStatus(pr.statusCheckRollup);
  const { fresh: threads, awaitingHuman } = splitThreads(
    await github.reviewThreads(pr.number),
  );
  const codex = pr.isDraft ? null : findCodexReview(pr.comments, sha);
  const verdict = assessHead({
    pr,
    codex,
    ci,
    threads,
    awaitingHuman,
    headSeenAt: record.review.headSeenAt,
  });
  note(
    record,
    `review check ${sha.slice(0, 8)}`,
    `ci=${ci} codex=${codex ? (isCleanReview(codex.body) ? "clean" : "findings") : "none"} threads=${threads.length}+${awaitingHuman.length} -> ${verdict.action}`,
  );

  if (verdict.action === "wait") return;
  if (verdict.action === "escalate") {
    return escalate(
      record,
      `review 循环无法继续：${verdict.why}。PR: ${pr.url}`,
    );
  }
  if (verdict.action === "draft_ready") {
    if (!record.review.draftNotified) {
      record.review.draftNotified = true;
      await linear.comment(
        record,
        `**Draft PR 已就绪，等待 Windows 验证** ${pr.url}\n\nCI 通过且没有未处理的评论。请在 Windows 上验证后把 PR 转为 ready for review，机器人会继续跟进 Codex review。\n\n${FOOTER}`,
      );
    }
    return;
  }
  if (verdict.action === "done") {
    if (["Backlog", "Todo", "In Progress"].includes(record.linearState)) {
      await linear.setState(record, config.linearStatePendingReview);
    }
    await linear.comment(
      record,
      `**review 意见已清零** ${pr.url}\n\n${verdict.why}。等待人工合并。\n\n${FOOTER}`,
    );
    return transition(record, "done", verdict.why);
  }

  // action === 'fix'
  const round = (record.review.rounds ?? 0) + 1;
  const fingerprint =
    codex && !isCleanReview(codex.body)
      ? findingsFingerprint(codex.body)
      : null;
  if (round > config.maxReviewRounds) {
    return escalate(
      record,
      `review 循环已达到 ${config.maxReviewRounds} 轮上限，仍有未解决的意见（${verdict.problems.join(", ")}）。`,
    );
  }
  if (fingerprint && fingerprint === record.review.lastFingerprint) {
    return escalate(
      record,
      `连续两轮 Codex review 的意见相同，机器人没有取得进展。最近一轮：\n\n${extractFindings(codex.body).slice(0, 2500)}`,
    );
  }

  const dir = worktreePath(record.identifier);
  await git.ensureWorktree(dir, record.branch);
  await git.installDeps(dir);
  try {
    await git.mergeBase(dir);
  } catch (err) {
    return escalate(
      record,
      `合并 ${config.remote}/${config.baseBranch} 时发生冲突，需要人工处理：\n\n\`\`\`\n${String(err.message).slice(0, 2000)}\n\`\`\``,
    );
  }
  const before = await git.headSha(dir);
  const out = runDir(record.identifier, `review-${round}`);
  const prompt = renderPrompt(loadPrompt("review-fix"), {
    prNumber: pr.number,
    prUrl: pr.url,
    branch: record.branch,
    baseBranch: `${config.remote}/${config.baseBranch}`,
    packageDir: config.packageDir,
    outDir: out,
    issue: linear.renderIssue(issue),
    codexFindings: codex ? extractFindings(codex.body) : "(none for this head)",
    humanThreads: threads.length ? renderThreads(threads) : "(none)",
    ciText: ci === "failure" ? await github.checksText(pr.number) : `(${ci})`,
  });
  const res = await runClaude({
    prompt,
    cwd: dir,
    runDir: out,
    label: "review-fix",
    allowedTools: CODE_TOOLS,
    addDirs: [out],
    budgetUsd: config.reviewBudgetUsd,
    timeoutMs: config.reviewTimeoutMs,
  });
  note(
    record,
    `review round ${round} run finished`,
    `cost $${res.costUsd ?? "?"}`,
  );

  const result = readJson(path.join(out, "result.json")) ?? {
    status: "fixed",
    summary: res.text,
    replies: [],
  };
  if (result.status === "blocked") {
    return escalate(
      record,
      `review 意见需要人工决定：\n\n${result.summary ?? "(no summary)"}`,
    );
  }
  if (await git.isDirty(dir)) {
    return escalate(
      record,
      `review 修复结束时工作树有未提交的改动，已停止。worktree: \`${dir}\``,
    );
  }
  const committed = (await git.headSha(dir)) !== before;
  if (
    !committed &&
    result.status === "fixed" &&
    verdict.problems.some((p) => p !== "threads")
  ) {
    return escalate(
      record,
      `review 修复声称已修复但没有新的提交。\n\n${String(result.summary ?? "").slice(0, 1500)}`,
    );
  }
  if (committed) {
    try {
      await gatedPush(dir, record.branch);
    } catch (err) {
      return escalate(
        record,
        `review 修复后 push 或推送前的 E2E 失败：\n\n\`\`\`\n${String(err.message).slice(0, 2500)}\n\`\`\``,
      );
    }
    note(record, "pushed review fix", await git.recentLog(dir, before));
  }

  const summary = String(result.summary ?? "").trim();
  if (summary) {
    await github.commentOnPr(
      pr.number,
      `### Review round ${round}${result.status === "disputed" ? " (partially disputed)" : ""}\n\n${summary}`,
    );
  }
  const threadIds = new Set(threads.map((t) => t.id));
  for (const reply of Array.isArray(result.replies) ? result.replies : []) {
    if (!threadIds.has(reply.threadId) || !reply.body) continue;
    await github.replyToThread(reply.threadId, String(reply.body));
    if (reply.resolve === true) await github.resolveThread(reply.threadId);
  }

  record.review.rounds = round;
  record.review.lastFingerprint = fingerprint;
  record.review.lastStatus = result.status;
  note(record, `review round ${round} posted`, result.status);
}
