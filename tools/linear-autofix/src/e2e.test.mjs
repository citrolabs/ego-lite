import assert from "node:assert/strict";
import { test } from "node:test";
import {
  e2eFailureComment,
  e2eNote,
  e2eWarning,
  failedCases,
  selectE2eCases,
  touchesE2eScope,
} from "./e2e.mjs";

test("touchesE2eScope matches the paths the pre-push hook watches", () => {
  assert.equal(
    touchesE2eScope(["tools/linear-autofix/src/cli.mjs", "README.md"]),
    false,
  );
  assert.equal(touchesE2eScope(["package/ego-browser/src/cdp-eval.ts"]), true);
  assert.equal(touchesE2eScope(["skills/ego-browser/SKILL.md"]), true);
  assert.equal(
    touchesE2eScope(["plugins/ego/skills/ego-browser/SKILL.md"]),
    false,
  );
});

test("selectE2eCases leaves out known failures and reports unknown names", () => {
  const all = ["Environment", "Page keyboard interface", "Pointer"];
  const r = selectE2eCases(all, ["Page keyboard interface", "Gone case"]);
  assert.deepEqual(r.only, ["Environment", "Pointer"]);
  assert.deepEqual(r.excluded, ["Page keyboard interface"]);
  assert.deepEqual(r.unknown, ["Gone case"]);
  assert.deepEqual(selectE2eCases(all, []).only, all);
});

test("e2eNote says what ran, what was excluded and what failed", () => {
  assert.match(
    e2eNote({
      ran: "bot",
      excluded: ["Page keyboard interface"],
      failures: [],
    }),
    /excluding known-failing cases: `Page keyboard interface`/,
  );
  const clean = e2eNote({ ran: "bot", excluded: [], failures: [] });
  assert.match(clean, /suite ran on the bot machine before this push\.$/);
  assert.match(
    e2eNote({
      ran: "bot",
      excluded: [],
      failures: [{ name: "Pointer", message: "x" }],
    }),
    /1 case\(s\) failed; a PR comment lists them/,
  );
  assert.match(
    e2eNote({ ran: "not needed", excluded: [], failures: [] }),
    /did not run/,
  );
});

test("failedCases keeps only failures from the runner's results", () => {
  assert.deepEqual(
    failedCases({
      cases: [
        { name: "A", status: "pass" },
        { name: "B", status: "skip" },
        { name: "C", status: "fail", message: "boom" },
      ],
    }),
    [{ name: "C", message: "boom" }],
  );
  assert.deepEqual(failedCases({ cases: [{ name: "A", status: "pass" }] }), []);
});

test("failedCases refuses to report when no case passed", () => {
  assert.equal(
    failedCases({
      cases: [
        { name: "A", status: "fail", message: "CLI not found" },
        { name: "B", status: "skip" },
      ],
    }),
    null,
  );
  assert.equal(failedCases({ cases: [] }), null);
  assert.equal(failedCases(null), null);
});

test("e2eFailureComment names each case and keeps local paths out", () => {
  const body = e2eFailureComment(
    {
      excluded: ["Paste"],
      failures: [
        { name: "Pointer", message: "/Users/bot/x failed ```fence```" },
        { name: "Long", message: "y".repeat(5000) },
      ],
    },
    "0123456789abcdef",
    "/Users/bot",
  );
  assert.match(body, /2 case\(s\) failed on `01234567`/);
  assert.match(body, /Not run \(known failures on this host\): `Paste`/);
  assert.match(body, /#### `Pointer`/);
  assert.match(body, /~\/x failed '''fence'''/);
  assert.doesNotMatch(body, /\/Users\/bot/);
  assert.ok(!body.includes("y".repeat(1501)));
  assert.equal(body.match(/```/g).length, 4);
});

test("e2eWarning only speaks about the commit E2E ran on", () => {
  const record = { e2e: { sha: "abc", failures: ["Pointer"] } };
  assert.match(e2eWarning(record, "abc"), /1 个 E2E 用例失败（Pointer）/);
  assert.equal(e2eWarning(record, "def"), "");
  assert.equal(e2eWarning({ e2e: { sha: "abc", failures: [] } }, "abc"), "");
  assert.equal(e2eWarning({}, "abc"), "");
});
