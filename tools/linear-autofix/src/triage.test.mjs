import assert from "node:assert/strict";
import { test } from "node:test";
import { renderTriageComment, validateTriage } from "./triage.mjs";
import {
  composePrBody,
  PR_FOOTER,
  prMetadata,
  sharesScope,
} from "./implement.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseJsonBlock, renderPrompt } from "./claude.mjs";
import { ciStatus, pickPr } from "./github.mjs";

test("validateTriage normalizes a good result and rejects bad ones", () => {
  const t = validateTriage({
    verdict: "fix",
    confidence: "0.8",
    reason: " root cause in run.ts ",
    needs_windows: "yes",
    size: "XL",
    affected_paths: ["a.ts"],
    repro_plan: "write a test",
    comment: "",
  });
  assert.equal(t.confidence, 0.8);
  assert.equal(t.reason, "root cause in run.ts");
  assert.equal(t.needs_windows, false);
  assert.equal(t.size, "M");
  assert.equal(t.comment, "root cause in run.ts");
  assert.throws(
    () => validateTriage({ verdict: "maybe", confidence: 0.5, reason: "x" }),
    /verdict invalid/,
  );
  assert.throws(
    () => validateTriage({ verdict: "fix", confidence: 2, reason: "x" }),
    /confidence invalid/,
  );
  assert.throws(
    () => validateTriage({ verdict: "fix", confidence: 0.5, reason: "" }),
    /reason missing/,
  );
  assert.throws(() => validateTriage(null), /not an object/);
});

test("renderTriageComment shows the repro plan only for fix verdicts", () => {
  const base = {
    confidence: 0.9,
    size: "S",
    needs_windows: true,
    affected_paths: [],
    comment: "ok",
    repro_plan: "plan",
  };
  assert.match(
    renderTriageComment({ ...base, verdict: "fix" }),
    /复现计划[\s\S]*plan/,
  );
  assert.doesNotMatch(
    renderTriageComment({ ...base, verdict: "needs_info" }),
    /复现计划/,
  );
  assert.match(
    renderTriageComment({ ...base, verdict: "fix" }),
    /需 Windows 验证/,
  );
});

test("composePrBody adds the Linear id, draft note and footer exactly once", () => {
  const body = composePrBody({
    body: "## Problem\nx\n",
    identifier: "CITRO-1",
    draft: true,
    e2eNote: "E2E ran.",
  });
  assert.match(body, /Linear: CITRO-1/);
  assert.match(body, /> Draft: .*Windows/);
  assert.match(body, /> E2E ran\./);
  assert.ok(body.endsWith(PR_FOOTER));
  const withId = composePrBody({
    body: "Fixes CITRO-1",
    identifier: "CITRO-1",
    draft: false,
  });
  assert.equal(withId.match(/CITRO-1/g).length, 1);
});

test("renderPrompt substitutes variables and fails on missing ones", () => {
  assert.equal(renderPrompt("a {{ x }} b {{y}}", { x: 1, y: "z" }), "a 1 b z");
  assert.throws(() => renderPrompt("{{missing}}", {}), /missing/);
});

test("parseJsonBlock reads fenced or bare JSON and returns null otherwise", () => {
  assert.deepEqual(parseJsonBlock('here you go\n```json\n{"a":1}\n```'), {
    a: 1,
  });
  assert.deepEqual(parseJsonBlock('prefix {"a":{"b":2}} suffix'), {
    a: { b: 2 },
  });
  assert.equal(parseJsonBlock("no json here"), null);
});

test("ciStatus folds the rollup into one of four states", () => {
  assert.equal(ciStatus([]), "none");
  assert.equal(ciStatus(undefined), "none");
  assert.equal(
    ciStatus([{ conclusion: "SUCCESS" }, { conclusion: "SKIPPED" }]),
    "success",
  );
  assert.equal(
    ciStatus([{ conclusion: "SUCCESS" }, { state: "IN_PROGRESS" }]),
    "pending",
  );
  assert.equal(
    ciStatus([
      { conclusion: "SUCCESS" },
      { conclusion: "FAILURE" },
      { state: "PENDING" },
    ]),
    "failure",
  );
});

test("prMetadata prefers the saved PR fields and falls back to the run's pr.json", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "autofix-pr-"));
  assert.equal(prMetadata({ implement: { runDir } }), null);
  fs.writeFileSync(
    path.join(runDir, "pr.json"),
    JSON.stringify({ title: " t ", body: "b" }),
  );
  assert.deepEqual(prMetadata({ implement: { runDir } }), {
    title: "t",
    body: "b",
  });
  assert.deepEqual(
    prMetadata({ implement: { runDir, pr: { title: "saved", body: "s" } } }),
    { title: "saved", body: "s" },
  );
  assert.equal(prMetadata({}), null);
});

test("sharesScope compares the first two path segments and refuses empty branches", () => {
  assert.equal(
    sharesScope(
      ["package/ego-browser/src/a.ts"],
      ["package/ego-browser/src/b.ts"],
    ),
    true,
  );
  assert.equal(
    sharesScope(
      ["tools/linear-autofix/src/cli.mjs"],
      ["package/ego-browser/src/b.ts"],
    ),
    false,
  );
  assert.equal(sharesScope(["docs/x.md"], []), true);
  assert.equal(sharesScope([], ["package/ego-browser/src/b.ts"]), false);
});

test("pickPr resumes only an open PR into the base branch and refuses one into another branch", () => {
  const dev = {
    number: 1,
    url: "u1",
    state: "OPEN",
    baseRefName: "dev",
    createdAt: "2026-11-01T00:00:00Z",
  };
  const main = {
    number: 2,
    url: "u2",
    state: "OPEN",
    baseRefName: "main",
    createdAt: "2026-11-02T00:00:00Z",
  };
  const closed = {
    number: 3,
    url: "u3",
    state: "CLOSED",
    baseRefName: "dev",
    createdAt: "2026-10-01T00:00:00Z",
  };
  const older = {
    number: 4,
    url: "u4",
    state: "MERGED",
    baseRefName: "dev",
    createdAt: "2026-09-01T00:00:00Z",
  };
  assert.equal(pickPr([closed, dev, main], "dev"), dev);
  assert.throws(
    () => pickPr([main, closed], "dev"),
    /open against main, not dev/,
  );
  assert.equal(pickPr([older, closed], "dev"), closed);
  assert.equal(pickPr([], "dev"), null);
});
