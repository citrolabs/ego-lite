import assert from "node:assert/strict";
import { test } from "node:test";
import { assessHead } from "./review.mjs";

const clean = {
  body: "<!-- codex-review -->\n## 🤖 Codex Review · `abcd1234`\n<sub>x</sub>\nNo issues found that require changes.",
};
const dirty = {
  body: "<!-- codex-review -->\n## 🤖 Codex Review · `abcd1234`\n<sub>x</sub>\n- **[Major] a.ts:1** — bug",
};
const ready = { isDraft: false };
const now = Date.parse("2026-11-02T12:00:00Z");

test("waits while CI runs or while the Codex review is pending", () => {
  assert.equal(
    assessHead({ pr: ready, codex: null, ci: "pending", threads: [], now })
      .action,
    "wait",
  );
  assert.equal(
    assessHead({
      pr: ready,
      codex: null,
      ci: "success",
      threads: [],
      headSeenAt: "2026-11-02T11:30:00Z",
      now,
    }).action,
    "wait",
  );
});

test("finishes when Codex is clean, CI green and no threads are open", () => {
  assert.equal(
    assessHead({ pr: ready, codex: clean, ci: "success", threads: [], now })
      .action,
    "done",
  );
  assert.equal(
    assessHead({ pr: ready, codex: clean, ci: "none", threads: [], now })
      .action,
    "done",
  );
});

test("finishes without Codex once the wait window has passed", () => {
  const r = assessHead({
    pr: ready,
    codex: null,
    ci: "success",
    threads: [],
    headSeenAt: "2026-11-02T09:00:00Z",
    now,
  });
  assert.equal(r.action, "done");
});

test("fixes on CI failure, Codex findings or open human threads, even while CI is pending", () => {
  assert.deepEqual(
    assessHead({ pr: ready, codex: clean, ci: "failure", threads: [], now })
      .problems,
    ["ci"],
  );
  assert.deepEqual(
    assessHead({ pr: ready, codex: dirty, ci: "success", threads: [], now })
      .problems,
    ["codex"],
  );
  assert.deepEqual(
    assessHead({
      pr: ready,
      codex: null,
      ci: "pending",
      threads: [{ id: "t" }],
      now,
    }).problems,
    ["threads"],
  );
  assert.equal(
    assessHead({ pr: ready, codex: dirty, ci: "success", threads: [], now })
      .action,
    "fix",
  );
});

test("a draft PR with nothing to fix is reported as ready for manual verification, not done", () => {
  assert.equal(
    assessHead({
      pr: { isDraft: true },
      codex: null,
      ci: "success",
      threads: [],
      now,
    }).action,
    "draft_ready",
  );
  assert.equal(
    assessHead({
      pr: { isDraft: true },
      codex: null,
      ci: "failure",
      threads: [],
      now,
    }).action,
    "fix",
  );
});
