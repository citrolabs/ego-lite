import fs from "node:fs";
import path from "node:path";
import { config } from "./config.mjs";
import { loadPrompt, renderPrompt, runClaude } from "./claude.mjs";
import * as git from "./git.mjs";
import * as github from "./github.mjs";
import * as linear from "./linear.mjs";
import { note, runDir, transition, worktreePath } from "./state.mjs";
import { escalate, FOOTER } from "./actions.mjs";
import { bothTails } from "./proc.mjs";

/**
 * Tools the implementer and the review fixer may use. The list keeps Claude on
 * rails and out of `git push`, `gh` and anything with network side effects; it
 * is not a sandbox against a hostile model (Edit plus `npm run` can execute
 * arbitrary code). Containment comes from the dedicated host and its limited
 * credentials. No `cd`, so every command runs at the worktree root; no bare
 * `node`/`npx`, which would allow arbitrary code outside the test runner.
 */
export const CODE_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "Grep",
  "Glob",
  "Bash(npm --prefix package/ego-browser *)",
  "Bash(npm --prefix plugins/ego *)",
  "Bash(package/ego-browser/node_modules/.bin/prettier *)",
  "Bash(git add *)",
  "Bash(git commit *)",
  "Bash(git diff *)",
  "Bash(git status *)",
  "Bash(git log *)",
  "Bash(git show *)",
  "Bash(git grep *)",
  "Bash(git restore *)",
  "Bash(git rm *)",
  "Bash(git mv *)",
];

export const PR_FOOTER =
  "🤖 Generated with [Claude Code](https://claude.com/claude-code)";

/** Compose the final PR body from the implementer's draft. Pure. */
export function composePrBody({ body, identifier, draft, e2eNote }) {
  const parts = [body.trim()];
  if (!body.includes(identifier)) parts.push(`Linear: ${identifier}`);
  const notes = [];
  if (draft)
    notes.push(
      "Draft: the fix was implemented unattended and still needs manual verification on Windows.",
    );
  if (e2eNote) notes.push(e2eNote);
  if (notes.length) parts.push(notes.map((n) => `> ${n}`).join("\n>\n"));
  parts.push(PR_FOOTER);
  return parts.join("\n\n");
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new Error(`${file} is not valid JSON: ${err.message}`);
  }
}

export async function implement(issue, record) {
  transition(record, "implementing");
  const dir = worktreePath(record.identifier);
  const { created } = await git.ensureWorktree(dir, record.branch);
  note(record, created ? "worktree created" : "worktree reused", dir);
  if (!created) await git.mergeBase(dir);
  await git.installDeps(dir);
  const base = `${config.remote}/${config.baseBranch}`;

  const out = runDir(record.identifier, "implement");
  const prompt = renderPrompt(loadPrompt("implement"), {
    issue: linear.renderIssue(issue),
    triage: renderTriageForPrompt(record.triage),
    branch: record.branch,
    baseBranch: base,
    packageDir: config.packageDir,
    outDir: out,
    identifier: record.identifier,
  });
  const res = await runClaude({
    prompt,
    cwd: dir,
    runDir: out,
    label: "implement",
    allowedTools: CODE_TOOLS,
    addDirs: [out],
    budgetUsd: config.implementBudgetUsd,
    timeoutMs: config.implementTimeoutMs,
  });
  record.implement = {
    costUsd: res.costUsd,
    turns: res.turns,
    durationMs: res.durationMs,
    runDir: out,
  };
  note(
    record,
    "implement run finished",
    `cost $${res.costUsd ?? "?"}, ${res.turns ?? "?"} turns`,
  );

  const result = readJson(path.join(out, "result.json"));
  if (result?.status === "blocked") {
    return escalate(
      record,
      `实现阶段判断无法在本仓库中修复：\n\n${result.reason ?? "(no reason given)"}`,
    );
  }
  if (await git.isDirty(dir)) {
    return escalate(
      record,
      `实现阶段结束时工作树有未提交的改动，已停止。worktree: \`${dir}\``,
    );
  }
  const ahead = await git.commitsAhead(dir, base);
  if (ahead === 0) {
    return escalate(
      record,
      `实现阶段没有产生任何提交。\n\n${res.text.slice(0, 1500)}`,
    );
  }
  const pr = readJson(path.join(out, "pr.json"));
  if (!pr?.title || !pr?.body) {
    return escalate(
      record,
      `实现阶段产生了 ${ahead} 个提交但没有写出 pr.json，无法开 PR。worktree: \`${dir}\``,
    );
  }
  record.implement.pr = { title: pr.title.trim(), body: pr.body };
  return publish(record);
}

/**
 * Push the worktree branch and open (or adopt) the PR, then hand the ticket to
 * the review loop. Also reachable from `linear-autofix publish <ID>` after a
 * human fixed whatever made the push fail (usually the pre-push E2E).
 */
export async function publish(record) {
  const dir = worktreePath(record.identifier);
  const base = `${config.remote}/${config.baseBranch}`;
  const pr = record.implement?.pr;
  if (!pr?.title || !pr?.body) {
    return escalate(record, `没有保存下来的 PR 标题和描述，无法 publish。`);
  }
  if (!fs.existsSync(dir)) {
    return escalate(record, `worktree 不存在：\`${dir}\``);
  }
  if (await git.isDirty(dir)) {
    return escalate(
      record,
      `工作树有未提交的改动，先处理再 publish。worktree: \`${dir}\``,
    );
  }
  const ahead = await git.commitsAhead(dir, base);
  if (ahead === 0) {
    return escalate(record, `分支上没有领先 ${base} 的提交，无法 publish。`);
  }

  try {
    await git.push(dir, record.branch);
  } catch (err) {
    const logDir =
      record.implement?.runDir ?? runDir(record.identifier, "publish");
    const log = path.join(logDir, "push.log");
    fs.writeFileSync(
      log,
      `${err.stdout ?? ""}\n${err.stderr ?? ""}\n${err.message}`,
    );
    const excerpt = bothTails(err.stdout, err.stderr, 60).slice(-2200);
    return escalate(
      record,
      `push 失败（pre-push 会跑真浏览器 E2E，通常是 E2E 未通过）：\n\n\`\`\`\n${excerpt}\n\`\`\`\n\n完整输出：\`${log}\`\nworktree: \`${dir}\`\n\n修好环境后运行 \`linear-autofix publish ${record.identifier}\` 只重跑 push 和开 PR，不会重新实现。`,
    );
  }
  note(record, "pushed", await git.recentLog(dir, base));

  const draft = record.triage?.needs_windows === true;
  let prInfo = await github.findPr(record.branch);
  if (prInfo?.state === "OPEN") {
    note(record, "pr exists", prInfo.url);
  } else {
    prInfo = await github.createPr({
      branch: record.branch,
      title: pr.title,
      body: composePrBody({
        body: pr.body,
        identifier: record.identifier,
        draft,
        e2eNote:
          "The pre-push real-browser E2E suite ran on the bot machine before this push.",
      }),
      draft,
    });
    note(record, "pr created", prInfo.url);
  }
  record.pr = {
    number: prInfo.number,
    url: prInfo.url,
    draft: prInfo.isDraft ?? draft,
  };
  record.review = { rounds: 0 };
  record.consecutiveErrors = 0;

  if (["Backlog", "Todo"].includes(record.linearState)) {
    await linear.setState(record, config.linearStateInProgress);
  }
  if (record.stage === "escalated") {
    await linear.removeLabel(record, config.labels.escalated);
  }
  await linear.comment(
    record,
    `**已开 PR** ${prInfo.url}${draft ? "（draft，待在 Windows 上验证后转正）" : ""}\n\n机器人会跟进 Codex review 和人工评论，直到没有新意见为止。合并由人工完成。\n\n${FOOTER}`,
  );
  transition(record, "in_review", prInfo.url);
}

function renderTriageForPrompt(t) {
  if (!t) return "(none)";
  return [
    `- Verdict: ${t.verdict} (confidence ${t.confidence})`,
    `- Size: ${t.size}${t.needs_windows ? " · needs Windows verification (PR will be a draft)" : ""}`,
    `- Reason: ${t.reason}`,
    t.affected_paths?.length
      ? `- Expected paths: ${t.affected_paths.join(", ")}`
      : null,
    t.repro_plan ? `- Repro plan:\n\n${t.repro_plan}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}
