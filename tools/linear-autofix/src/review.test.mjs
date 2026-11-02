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
const recent = "2026-11-02T11:30:00Z";
const old = "2026-11-02T09:00:00Z";

test("waits while CI runs, has not reported, or while the Codex review is pending", () => {
  assert.equal(
    assessHead({ pr: ready, codex: null, ci: "pending", threads: [], now })
      .action,
    "wait",
  );
  assert.equal(
    assessHead({
      pr: ready,
      codex: clean,
      ci: "none",
      threads: [],
      headSeenAt: recent,
      now,
    }).action,
    "wait",
  );
  assert.equal(
    assessHead({
      pr: ready,
      codex: null,
      ci: "success",
      threads: [],
      headSeenAt: recent,
      now,
    }).action,
    "wait",
  );
});

test("finishes only when CI reported success", () => {
  assert.equal(
    assessHead({ pr: ready, codex: clean, ci: "success", threads: [], now })
      .action,
    "done",
  );
  assert.equal(
    assessHead({
      pr: ready,
      codex: null,
      ci: "success",
      threads: [],
      headSeenAt: old,
      now,
    }).action,
    "done",
  );
  const noCi = assessHead({
    pr: ready,
    codex: clean,
    ci: "none",
    threads: [],
    headSeenAt: old,
    now,
  });
  assert.equal(noCi.action, "escalate");
  assert.match(noCi.why, /no CI result/);
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
  assert.equal(
    assessHead({
      pr: { isDraft: true },
      codex: null,
      ci: "none",
      threads: [],
      headSeenAt: recent,
      now,
    }).action,
    "wait",
  );
});
