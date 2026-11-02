import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.AUTOFIX_STATE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "linear-autofix-test-"),
);
const { byPriority, reconcile } = await import("./tick.mjs");
const state = await import("./state.mjs");

const issue = (identifier, extra = {}) => ({
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
  ...extra,
});

test("byPriority puts urgent first and no-priority last", () => {
  const sorted = [
    { priority: 0, createdAt: "1" },
    { priority: 4, createdAt: "2" },
    { priority: 1, createdAt: "3" },
    { priority: 2, createdAt: "4" },
  ].sort(byPriority);
  assert.deepEqual(
    sorted.map((i) => i.priority),
    [1, 2, 4, 0],
  );
});

test("upsert keeps the stage and refreshes Linear fields", () => {
  const r1 = state.upsertFromIssue(issue("CITRO-1"));
  assert.equal(r1.stage, "new");
  state.transition(r1, "triaged");
  const r2 = state.upsertFromIssue(
    issue("CITRO-1", { title: "renamed", state: { name: "In Progress" } }),
  );
  assert.equal(r2.stage, "triaged");
  assert.equal(r2.title, "renamed");
  assert.equal(r2.linearState, "In Progress");
});

test("reconcile honors the opt-out label, retries crashed runs and re-triages needs_info on new comments", () => {
  const optOut = issue("CITRO-2", {
    labels: { nodes: [{ name: "no-agent" }] },
  });
  assert.equal(
    reconcile(state.upsertFromIssue(optOut), optOut).stage,
    "skipped",
  );

  const crashed = state.upsertFromIssue(issue("CITRO-3"));
  state.transition(crashed, "implementing");
  assert.equal(reconcile(crashed, issue("CITRO-3")).stage, "triaged");

  const info = state.upsertFromIssue(issue("CITRO-4"));
  info.triage = { verdict: "needs_info" };
  info.lastSeenCommentAt = "2026-11-01T00:00:00Z";
  state.transition(info, "skipped");
  assert.equal(reconcile(info, issue("CITRO-4")).stage, "skipped");
  const commented = issue("CITRO-4", {
    comments: {
      nodes: [{ body: "here is the repro", createdAt: "2026-11-02T00:00:00Z" }],
    },
  });
  assert.equal(
    reconcile(state.upsertFromIssue(commented), commented).stage,
    "new",
  );
});

test("the tick lock is exclusive, stale locks are reclaimed and the STOP file is honored", () => {
  assert.equal(state.acquireLock(), true);
  assert.equal(
    state.acquireLock(),
    false,
    "a lock held by a live process is respected",
  );
  state.releaseLock();
  fs.writeFileSync(
    path.join(process.env.AUTOFIX_STATE_DIR, "tick.lock"),
    "999999",
  );
  assert.equal(
    state.acquireLock(),
    true,
    "a lock left by a dead process is reclaimed",
  );
  state.releaseLock();
  assert.equal(
    state.acquireLock(),
    true,
    "the reclaimed lock was recreated exclusively",
  );
  assert.equal(state.acquireLock(), false);
  state.releaseLock();
  assert.equal(state.stopRequested(), false);
  state.setStop(true);
  assert.equal(state.stopRequested(), true);
  state.setStop(false);
});
