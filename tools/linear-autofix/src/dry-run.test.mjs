import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "linear-autofix-dry-"));
const base = path.join(tmp, "state");
const calls = path.join(tmp, "calls.log");

function fakeBin(name, output) {
  const file = path.join(tmp, name);
  fs.writeFileSync(
    file,
    `#!/bin/sh\necho "${name} $*" >> '${calls}'\ncat > /dev/null\ncat <<'OUT'\n${output}\nOUT\n`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

const verdict = {
  verdict: "fix",
  confidence: 0.9,
  reason: "evident in the code",
  needs_windows: false,
  size: "S",
  affected_paths: [],
  repro_plan: "a test",
  comment: "fixable",
};
fakeBin("gh", "[]");
Object.assign(process.env, {
  PATH: `${tmp}${path.delimiter}${process.env.PATH}`,
  AUTOFIX_CLAUDE_BIN: fakeBin(
    "claude",
    JSON.stringify({ type: "result", structured_output: verdict }),
  ),
  // Not a git repository: a regression fails here instead of branching in ours.
  AUTOFIX_REPO: tmp,
  AUTOFIX_STATE_DIR: base,
  AUTOFIX_DRY_RUN: "1",
  AUTOFIX_LOG_ISSUE: "",
  LINEAR_API_KEY: "lin_api_test",
});

const { config, resolveStateDir } = await import("./config.mjs");
const { tick } = await import("./tick.mjs");

const issue = (identifier) => ({
  id: `uuid-${identifier}`,
  identifier,
  title: "t",
  url: "https://linear.app/x",
  branchName: `zhuoweiwang/${identifier.toLowerCase()}`,
  updatedAt: "2026-11-01T00:00:00Z",
  team: { id: "team", key: "CITRO" },
  state: { name: "Todo" },
  labels: { nodes: [] },
  comments: { nodes: [] },
});

test("the state dir of a dry run is separate from the real one", () => {
  const home = "/home/bot";
  const real = "/home/bot/.local/state/linear-autofix";
  assert.equal(resolveStateDir({}, home), real);
  assert.equal(
    resolveStateDir({ AUTOFIX_DRY_RUN: "1" }, home),
    `${real}/dry-run`,
  );
  assert.equal(resolveStateDir({ AUTOFIX_STATE_DIR: "/s" }, home), "/s");
  assert.equal(
    resolveStateDir({ AUTOFIX_STATE_DIR: "/s", AUTOFIX_DRY_RUN: "1" }, home),
    "/s/dry-run",
  );
});

test("a dry-run tick triages without touching the real state, Linear or a PR", async () => {
  const issuesDir = path.join(config.stateDir, "issues");
  fs.mkdirSync(issuesDir, { recursive: true });
  // Would be reviewed by a real tick.
  fs.writeFileSync(
    path.join(issuesDir, "CITRO-2.json"),
    JSON.stringify({ identifier: "CITRO-2", stage: "in_review", history: [] }),
  );

  const queries = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const { query } = JSON.parse(init.body);
    queries.push(query);
    return new Response(
      JSON.stringify({
        data: {
          issues: {
            nodes: [issue("CITRO-1"), issue("CITRO-2")],
            pageInfo: { hasNextPage: false },
          },
        },
      }),
    );
  };
  try {
    await tick();
  } finally {
    globalThis.fetch = realFetch;
  }

  const read = (id) =>
    JSON.parse(fs.readFileSync(path.join(issuesDir, `${id}.json`), "utf8"));
  assert.equal(read("CITRO-1").stage, "triaged");
  assert.equal(read("CITRO-1").triage.verdict, "fix");
  assert.equal(read("CITRO-2").stage, "in_review");

  assert.equal(
    fs.existsSync(path.join(base, "issues")),
    false,
    "nothing is recorded in the real state",
  );
  assert.deepEqual(fs.readdirSync(path.join(config.stateDir, "worktrees")), []);
  assert.equal(queries.length, 1, "Linear is only read");

  const log = fs.readFileSync(calls, "utf8").trim().split("\n");
  assert.equal(log.filter((l) => l.startsWith("claude ")).length, 1);
  assert.equal(log.filter((l) => l.startsWith("gh ")).length, 1);
  assert.match(
    log.find((l) => l.startsWith("gh ")),
    /citro-1 /,
  );
});

for (const command of ["implement", "review", "publish", "reset"]) {
  test(`${command} refuses to run in a dry run`, () => {
    const cli = new URL("./cli.mjs", import.meta.url).pathname;
    const res = spawnSync(process.execPath, [cli, command, "CITRO-1"], {
      encoding: "utf8",
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /not available with AUTOFIX_DRY_RUN=1/);
  });
}
