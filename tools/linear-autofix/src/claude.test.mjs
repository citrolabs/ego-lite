import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// config.mjs reads these once, and node --test gives each file its own process.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autofix-claude-test-"));
const fake = path.join(tmp, "fake-claude.mjs");
process.env.AUTOFIX_STATE_DIR = path.join(tmp, "state");
process.env.AUTOFIX_CLAUDE_BIN = fake;

const { detectUsageLimit, parseClaudeStream, runClaude, UsageLimitError } =
  await import("./claude.mjs");
const { clearUsagePause, setUsagePause, usagePausedUntil } =
  await import("./state.mjs");
const { runCodeClaude } = await import("./implement.mjs");

const now = Date.parse("2026-11-02T04:00:00Z");
const resetsAt = now / 1000 + 3600;
const rejected = { status: "rejected", resetsAt };
const errorResult = (over = {}) => ({
  type: "result",
  subtype: "success",
  is_error: true,
  result: "You've hit your limit",
  ...over,
});

function fakeClaude(lines, exitCode = 0) {
  fs.writeFileSync(
    fake,
    `#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdin.on("end", () => {\n  console.log(${JSON.stringify(lines.map((l) => JSON.stringify(l)).join("\n"))});\n  process.exitCode = ${exitCode};\n});\n`,
    { mode: 0o755 },
  );
}

test("parseClaudeStream finds the result and the last rejected event", () => {
  const stdout = [
    "not json",
    JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", resetsAt: 1 },
    }),
    JSON.stringify({ type: "rate_limit_event", rate_limit_info: rejected }),
    JSON.stringify({ type: "result", result: "ok" }),
    "",
  ].join("\n");
  const parsed = parseClaudeStream(stdout);
  assert.equal(parsed.result.result, "ok");
  assert.deepEqual(parsed.rejected, rejected);
  assert.deepEqual(parseClaudeStream(undefined), {
    result: null,
    rejected: null,
  });
});

test("detectUsageLimit waits for the reset, plus a margin", () => {
  const limit = detectUsageLimit({ result: errorResult(), rejected, now });
  assert.equal(limit.until, resetsAt * 1000 + 60_000);
  assert.match(limit.reason, /hit your limit/);
});

test("detectUsageLimit falls back to a short wait without a usable reset", () => {
  const fallback = now + 30 * 60_000;
  for (const input of [
    { result: errorResult(), now },
    { result: errorResult(), rejected: { status: "rejected" }, now },
    { result: errorResult(), rejected: { resetsAt: now / 1000 - 5 }, now },
    {
      result: errorResult({ result: "API Error", api_error_status: 429 }),
      now,
    },
    { result: null, stderr: "Claude usage limit reached", now },
  ]) {
    assert.equal(detectUsageLimit(input).until, fallback);
  }
});

test("detectUsageLimit ignores what is not a usage limit", () => {
  // Finished normally, even though a window was rejected along the way.
  assert.equal(
    detectUsageLimit({
      result: {
        type: "result",
        is_error: false,
        result: "you've hit your limit",
      },
      rejected,
      now,
    }),
    null,
  );
  // The run's own --max-budget-usd.
  assert.equal(
    detectUsageLimit({
      result: errorResult({ subtype: "error_max_budget_usd", result: "" }),
      rejected,
      now,
    }),
    null,
  );
  assert.equal(
    detectUsageLimit({
      result: errorResult({ result: "something else broke" }),
      now,
    }),
    null,
  );
  assert.equal(detectUsageLimit({ result: null, stderr: "crash", now }), null);
});

test("runClaude pauses on a usage limit, then refuses to start", async () => {
  clearUsagePause();
  const future = Math.floor(Date.now() / 1000) + 3600;
  fakeClaude(
    [
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", resetsAt: future },
      },
      errorResult(),
    ],
    1,
  );
  await assert.rejects(
    runClaude({ prompt: "x", cwd: tmp, label: "t" }),
    UsageLimitError,
  );
  assert.equal(usagePausedUntil(), future * 1000 + 60_000);

  fs.rmSync(fake); // Starting it now would be a different error.
  await assert.rejects(
    runClaude({ prompt: "x", cwd: tmp, label: "t" }),
    UsageLimitError,
  );
  clearUsagePause();
});

test("runClaude returns a normal result and other errors as before", async () => {
  clearUsagePause();
  fakeClaude([
    { type: "system", subtype: "init" },
    {
      type: "result",
      is_error: false,
      result: "done",
      structured_output: { a: 1 },
      total_cost_usd: 0.5,
      num_turns: 2,
    },
  ]);
  const ok = await runClaude({ prompt: "x", cwd: tmp, label: "t" });
  assert.equal(ok.text, "done");
  assert.deepEqual(ok.structured, { a: 1 });
  assert.equal(ok.isError, false);
  assert.equal(ok.costUsd, 0.5);

  fakeClaude([errorResult({ result: "something else broke" })]);
  const failed = await runClaude({ prompt: "x", cwd: tmp, label: "t" });
  assert.equal(failed.isError, true);
  assert.equal(usagePausedUntil(), null);
});

test("a run cut off by the limit leaves the worktree as it started", async () => {
  clearUsagePause();
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  const git = (...args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "a.txt"), "start\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.txt\n");
  fs.writeFileSync(path.join(repo, "ignored.txt"), "keep\n");
  git("add", ".");
  git("commit", "-qm", "start");
  const start = git("rev-parse", "HEAD");

  const run = { prompt: "x", runDir: tmp, label: "t" };
  fs.writeFileSync(
    fake,
    `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
process.stdin.resume();
process.stdin.on("end", () => {
  fs.writeFileSync("a.txt", "partial commit\\n");
  execFileSync("git", ["commit", "-qam", "partial"]);
  fs.writeFileSync("a.txt", "uncommitted\\n");
  fs.writeFileSync("new.txt", "untracked\\n");
  console.log(${JSON.stringify(JSON.stringify(errorResult()))});
  process.exitCode = 1;
});
`,
    { mode: 0o755 },
  );
  // A .mjs fake, so its imports work; cwd is the repo.
  await assert.rejects(runCodeClaude(repo, run), UsageLimitError);
  assert.equal(git("rev-parse", "HEAD"), start);
  assert.equal(git("status", "--porcelain"), "");
  assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "start\n");
  assert.ok(fs.existsSync(path.join(repo, "ignored.txt")));

  // Refused before starting: nothing ran, so hand edits are left alone.
  fs.writeFileSync(path.join(repo, "a.txt"), "by hand\n");
  await assert.rejects(runCodeClaude(repo, run), UsageLimitError);
  assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "by hand\n");

  // Dirty before the run: the run is cut off, but nothing is discarded.
  clearUsagePause();
  fs.writeFileSync(path.join(repo, "mine.txt"), "untracked by hand\n");
  const original = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(runCodeClaude(repo, run), UsageLimitError);
  } finally {
    console.warn = original;
  }
  assert.notEqual(git("rev-parse", "HEAD"), start);
  assert.ok(fs.existsSync(path.join(repo, "mine.txt")));
  assert.ok(fs.existsSync(path.join(repo, "new.txt")));
  clearUsagePause();
});

test("an expired pause no longer counts", () => {
  setUsagePause(Date.now() - 1000, "old");
  assert.equal(usagePausedUntil(), null);
  clearUsagePause();
});
