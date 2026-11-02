import path from "node:path";
import { config } from "./config.mjs";
import { loadPrompt, renderPrompt } from "./claude.mjs";
import {
  classifyReview,
  extractFindings,
  findCodexReview,
  findingsFingerprint,
  isCleanReview,
} from "./codex.mjs";
import * as git from "./git.mjs";
import * as github from "./github.mjs";
import * as linear from "./linear.mjs";
import {
  note,
  runDir,
  save,
  transition,
  usagePausedUntil,
  worktreePath,
} from "./state.mjs";
import {
  freshPrComments,
  renderPrComments,
  renderThreads,
  splitThreads,
} from "./threads.mjs";
import { escalate, FOOTER } from "./actions.mjs";
import { readJson, runCodeClaude } from "./implement.mjs";
import { e2eWarning, flushE2eComment, gatedPush, recordE2e } from "./e2e.mjs";

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
  prComments = [],
  headSeenAt,
  now = Date.now(),
}) {
  const problems = [];
  if (ci === "failure") problems.push("ci");
  if (codex && !isCleanReview(codex.body)) problems.push("codex");
  if (threads.length) problems.push("threads");
  if (prComments.length) problems.push("comments");
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

/**
 * Describe feedback that arrived on a finished PR, or null when there is none.
 * Pure. `threads` are the fresh unresolved review threads, `prComments` the
 * conversation comments newer than the bot's baseline.
 */
export function pendingFeedback(threads, prComments) {
  const parts = [];
  if (threads.length) parts.push(`${threads.length} review thread(s)`);
  if (prComments.length) parts.push(`${prComments.length} comment(s)`);
  return parts.length ? parts.join(", ") : null;
}

/**
 * A `done` ticket is finished only until a human comments on its PR again.
 * While the PR is open, look for new review threads or conversation comments
 * and put the ticket back into the review loop when there are any. Once the PR
 * is merged or closed, remember that and stop asking GitHub.
 */
export async function watchDone(record) {
  if (!record.pr?.number || record.pr.state) return false;
  const pr = await github.viewPr(record.pr.number);
  if (pr.state !== "OPEN") {
    record.pr.state = pr.state;
    save(record);
    return false;
  }
  const { fresh } = splitThreads(await github.reviewThreads(pr.number));
  const prComments = freshPrComments(
    pr.comments,
    record.review?.commentsSeenAt ?? "",
  );
  const feedback = pendingFeedback(fresh, prComments);
  if (!feedback) return false;
  record.review ??= { rounds: 0 };
  transition(
    record,
    "in_review",
    `new feedback on the finished PR ${pr.url}: ${feedback}`,
  );
  return true;
}

export async function review(issue, record) {
  const pr = await github.viewPr(record.pr.number);
  record.pr.draft = pr.isDraft;
  if (pr.state === "MERGED") {
    record.pr.state = pr.state;
    await git.removeWorktree(worktreePath(record.identifier));
    return transition(record, "done", `PR merged ${pr.url}`);
  }
  if (pr.state === "CLOSED") {
    record.pr.state = pr.state;
    return transition(record, "done", `PR closed without merge ${pr.url}`);
  }
  await flushE2eComment(record, pr.number);

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
  const codexComment = pr.isDraft ? null : findCodexReview(pr.comments, sha);
  const inconclusive =
    codexComment && classifyReview(codexComment.body) === "inconclusive";
  const codex = inconclusive ? null : codexComment;
  if (inconclusive) {
    note(
      record,
      "codex review inconclusive",
      extractFindings(codexComment.body).slice(0, 300),
    );
  }
  // Conversation comments are answered once: everything up to the newest one
  // handled so far has been seen. The baseline is set when the PR is created
  // (publish) or adopted (tick); a record without one sees every comment.
  record.review.commentsSeenAt ??= "";
  const prComments = freshPrComments(pr.comments, record.review.commentsSeenAt);
  const assessed = assessHead({
    pr,
    codex,
    ci,
    threads,
    awaitingHuman,
    prComments,
    headSeenAt: record.review.headSeenAt,
  });
  // Fixing needs Claude. Everything else (merged, done, draft ready) does not,
  // so the check itself keeps running through a usage pause.
  const verdict =
    assessed.action === "fix" && usagePausedUntil()
      ? { ...assessed, action: "wait" }
      : assessed;
  note(
    record,
    `review check ${sha.slice(0, 8)}`,
    `ci=${ci} codex=${codex ? (isCleanReview(codex.body) ? "clean" : "findings") : "none"} threads=${threads.length}+${awaitingHuman.length} comments=${prComments.length} -> ${verdict.action}`,
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
        `**Draft PR 已就绪，等待 Windows 验证** ${pr.url}\n\nCI 通过且没有未处理的评论。请在 Windows 上验证后把 PR 转为 ready for review，机器人会继续跟进 Codex review。${e2eWarning(record, sha)}\n\n${FOOTER}`,
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
      `**review 意见已清零** ${pr.url}\n\n${verdict.why}。等待人工合并。${e2eWarning(record, sha)}\n\n${FOOTER}`,
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
  const sync = await git.syncWorktreeToRemote(dir, record.branch);
  if (sync === "reset-to-remote") {
    note(
      record,
      "worktree reset to the remote branch",
      "the PR branch was rewritten outside the bot",
    );
  }
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
    prComments: prComments.length ? renderPrComments(prComments) : "(none)",
    ciText: ci === "failure" ? await github.checksText(pr.number) : `(${ci})`,
  });
  const res = await runCodeClaude(dir, {
    prompt,
    runDir: out,
    label: "review-fix",
    identifier: record.identifier,
    budgetUsd: config.reviewBudgetUsd,
    timeoutMs: config.reviewTimeoutMs,
  });
  note(
    record,
    `review round ${round} run finished`,
    `cost $${res.costUsd ?? "?"}${res.isError ? ", ended in error" : ""}`,
  );
  if (res.isError) {
    return escalate(
      record,
      `review 修复的 Claude 运行以错误结束，不发布它留下的提交：\n\n${res.text.slice(0, 1500)}\n\nworktree: \`${dir}\``,
    );
  }

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
    verdict.problems.some((p) => p !== "threads" && p !== "comments")
  ) {
    return escalate(
      record,
      `review 修复声称已修复但没有新的提交。\n\n${String(result.summary ?? "").slice(0, 1500)}`,
    );
  }
  if (committed) {
    let gate;
    try {
      gate = await gatedPush(dir, record.branch);
    } catch (err) {
      return escalate(
        record,
        `review 修复后 push 失败，或推送前的 E2E 没能跑完（用例失败不会走到这里，只会评论到 PR）：\n\n\`\`\`\n${String(err.message).slice(0, 2500)}\n\`\`\``,
      );
    }
    recordE2e(record, gate, await git.headSha(dir));
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
  if (prComments.length)
    record.review.commentsSeenAt = prComments.at(-1).createdAt;
  record.review.lastFingerprint = fingerprint;
  record.review.lastStatus = result.status;
  note(record, `review round ${round} posted`, result.status);
  // Last, so a failed comment is retried by the next check, not by another round.
  await flushE2eComment(record, pr.number);
}
