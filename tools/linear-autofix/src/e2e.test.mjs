import assert from "node:assert/strict";
import { test } from "node:test";
import { e2eNote, selectE2eCases, touchesE2eScope } from "./e2e.mjs";

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

test("e2eNote says which cases were excluded", () => {
  assert.match(
    e2eNote({ ran: "bot", excluded: ["Page keyboard interface"] }),
    /excluding known-failing cases: `Page keyboard interface`/,
  );
  assert.match(
    e2eNote({ ran: "hook", excluded: [] }),
    /pre-push real-browser E2E suite ran/,
  );
  assert.match(e2eNote({ ran: "not needed", excluded: [] }), /did not run/);
});
