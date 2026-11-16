import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "linear-autofix-triage-"));
const output = path.join(tmp, "claude-output.json");
const claude = path.join(tmp, "claude");
fs.writeFileSync(claude, `#!/bin/sh\ncat > /dev/null\ncat '${output}'\n`);
fs.chmodSync(claude, 0o755);

Object.assign(process.env, {
  AUTOFIX_CLAUDE_BIN: claude,
  AUTOFIX_REPO: tmp,
  AUTOFIX_STATE_DIR: path.join(tmp, "state"),
  AUTOFIX_LOG_ISSUE: "",
  LINEAR_API_KEY: "lin_api_test",
});
delete process.env.AUTOFIX_DRY_RUN;

const { triage } = await import("./triage.mjs");

/** Triage one ticket with the given verdict; return the record and Linear queries. */
async function triageWith(verdict) {
  fs.writeFileSync(
    output,
    JSON.stringify({
      type: "result",
      structured_output: {
        verdict,
        confidence: 0.9,
        reason: "because",
        needs_windows: false,
        size: "S",
        affected_paths: [],
        repro_plan: "",
        comment: "",
      },
    }),
  );
  const record = {
    id: "uuid",
    identifier: "CITRO-1",
    teamId: "team",
    stage: "new",
    history: [],
  };
  const queries = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const { query } = JSON.parse(init.body);
    queries.push(query);
    return new Response(
      JSON.stringify({
        data: {
          commentCreate: { success: true },
          issueAddLabel: { success: true },
          team: {
            states: { nodes: [] },
            labels: { nodes: [{ id: "l", name: "agent:skipped" }] },
          },
        },
      }),
    );
  };
  try {
    await triage({ identifier: record.identifier, title: "t" }, record);
  } finally {
    globalThis.fetch = realFetch;
  }
  return { record, queries };
}

test("an unrelated ticket is skipped without any Linear request", async () => {
  const { record, queries } = await triageWith("unrelated");
  assert.equal(record.stage, "skipped");
  assert.equal(record.triage.verdict, "unrelated");
  assert.deepEqual(queries, []);
});

test("any other skip verdict still comments and labels the ticket", async () => {
  const { record, queries } = await triageWith("browser_side");
  assert.equal(record.stage, "skipped");
  assert.ok(queries.some((q) => q.includes("commentCreate")));
  assert.ok(queries.some((q) => q.includes("issueAddLabel")));
});
