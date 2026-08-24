import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reclaimIdleTaskSpaces } from "../dist/src/taskspace-reclaim.js";
import { loadActivity, saveActivity } from "../dist/src/taskspace-activity.js";
import { state } from "../dist/src/state.js";

class FakeEgo {
  constructor(taskSpaces = []) {
    this.taskSpaces = taskSpaces.map((s) => ({ ...s }));
    this.calls = [];
    this.selectedId = null;
  }
  async listTaskSpaces() {
    this.calls.push(["listTaskSpaces"]);
    return { taskSpaces: this.taskSpaces.map((s) => ({ ...s })) };
  }
  useTaskSpace(id) {
    if (typeof id !== "number") throw new TypeError("numeric id");
    this.calls.push(["useTaskSpace", id]);
    this.selectedId = id;
    return id;
  }
  async closeTaskSpace() {
    this.calls.push(["closeTaskSpace"]);
    const id = this.selectedId;
    this.taskSpaces = this.taskSpaces.filter((s) => s.id !== id);
    this.selectedId = null;
    return { closed: id };
  }
}

const HOUR = 3600 * 1000;
const MIN = 60 * 1000;

async function setup({ spaces, activity, env = {} }) {
  state.reclaimDone = false;
  const dir = mkdtempSync(join(tmpdir(), "ego-reclaim-"));
  const stateFile = join(dir, "state.json");
  const prevEnv = {};
  for (const [k, v] of Object.entries(env)) {
    prevEnv[k] = process.env[k];
    process.env[k] = v;
  }
  const prevStateFile = process.env.EGO_RECLAIM_STATE_FILE;
  process.env.EGO_RECLAIM_STATE_FILE = stateFile;
  if (activity) await saveActivity(activity);
  const ego = new FakeEgo(spaces);
  const prevEgo = globalThis.ego;
  globalThis.ego = ego;
  return {
    ego,
    stateFile,
    cleanup() {
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      if (prevStateFile === undefined) delete process.env.EGO_RECLAIM_STATE_FILE;
      else process.env.EGO_RECLAIM_STATE_FILE = prevStateFile;
      if (prevEgo === undefined) delete globalThis.ego;
      else globalThis.ego = prevEgo;
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    },
  };
}

test("reclaims agent space idle past threshold, keeps fresh one", async () => {
  const now = 1700000000000;
  const ctx = await setup({
    spaces: [
      { taskId: "stale", id: 1, name: "stale", ownership: "agent" },
      { taskId: "fresh", id: 2, name: "fresh", ownership: "agent" },
    ],
    activity: { 1: now - 3 * HOUR, 2: now - 10 * MIN },
  });
  try {
    const r = await reclaimIdleTaskSpaces({ now: () => now, log() {} });
    assert.equal(r.scanned, 2);
    assert.equal(r.reclaimed, 1);
    assert.equal(ctx.ego.taskSpaces.length, 1);
    assert.equal(ctx.ego.taskSpaces[0].id, 2);
    assert.equal(
      ctx.ego.calls.filter((c) => c[0] === "closeTaskSpace").length,
      1,
    );
  } finally {
    ctx.cleanup();
  }
});

test("never touches user-owned spaces", async () => {
  const now = 1700000000000;
  const ctx = await setup({
    spaces: [
      { taskId: "agent-old", id: 1, name: "agent-old", ownership: "agent" },
      { taskId: "user-tab", id: 2, name: "user-tab", ownership: "user" },
    ],
    activity: { 1: now - 5 * HOUR },
  });
  try {
    const r = await reclaimIdleTaskSpaces({ now: () => now, log() {} });
    assert.equal(r.scanned, 1);
    assert.equal(r.reclaimed, 1);
    const ids = ctx.ego.taskSpaces.map((s) => s.id).sort((a, b) => a - b);
    assert.deepEqual(ids, [2]);
  } finally {
    ctx.cleanup();
  }
});

test("hard cap reclaims oldest even when all fresh", async () => {
  const now = 1700000000000;
  const spaces = [];
  for (let i = 1; i <= 5; i++) {
    spaces.push({ taskId: `s${i}`, id: i, name: `s${i}`, ownership: "agent" });
  }
  // larger i -> older (smaller timestamp); ranked ascending reclaims oldest first
  const activity = {};
  for (let i = 1; i <= 5; i++) activity[i] = now - i * MIN;
  const ctx = await setup({
    spaces,
    activity,
    env: { EGO_RECLAIM_MAX_SPACES: "3" },
  });
  try {
    const r = await reclaimIdleTaskSpaces({ now: () => now, log() {} });
    assert.equal(r.reclaimed, 2);
    const ids = ctx.ego.taskSpaces.map((s) => s.id).sort((a, b) => a - b);
    assert.deepEqual(ids, [1, 2, 3]);
  } finally {
    ctx.cleanup();
  }
});

test("disabled env reclaims nothing", async () => {
  const now = 1700000000000;
  const ctx = await setup({
    spaces: [{ taskId: "x", id: 1, name: "x", ownership: "agent" }],
    activity: { 1: now - 10 * HOUR },
    env: { EGO_RECLAIM_DISABLE: "1" },
  });
  try {
    const r = await reclaimIdleTaskSpaces({ now: () => now, log() {} });
    assert.equal(r.reclaimed, 0);
    assert.equal(ctx.ego.taskSpaces.length, 1);
  } finally {
    ctx.cleanup();
  }
});

test("no ego runtime returns empty without throwing", async () => {
  state.reclaimDone = false;
  const prev = globalThis.ego;
  delete globalThis.ego;
  const dir = mkdtempSync(join(tmpdir(), "ego-reclaim-"));
  const prevFile = process.env.EGO_RECLAIM_STATE_FILE;
  process.env.EGO_RECLAIM_STATE_FILE = join(dir, "s.json");
  try {
    const r = await reclaimIdleTaskSpaces({ log() {} });
    assert.equal(r.reclaimed, 0);
    assert.equal(r.scanned, 0);
  } finally {
    if (prevFile === undefined) delete process.env.EGO_RECLAIM_STATE_FILE;
    else process.env.EGO_RECLAIM_STATE_FILE = prevFile;
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    if (prev !== undefined) globalThis.ego = prev;
  }
});

test("first sight seeds instead of reclaiming (deploy safety)", async () => {
  const now = 1700000000000;
  // No activity file at all — every space is unknown on first deploy.
  const ctx = await setup({
    spaces: [
      { taskId: "unknown-a", id: 1, name: "unknown-a", ownership: "agent" },
      { taskId: "unknown-b", id: 2, name: "unknown-b", ownership: "agent" },
    ],
  });
  try {
    const r = await reclaimIdleTaskSpaces({ now: () => now, log() {} });
    assert.equal(r.reclaimed, 0);
    assert.equal(ctx.ego.taskSpaces.length, 2);
    assert.equal(
      ctx.ego.calls.filter((c) => c[0] === "closeTaskSpace").length,
      0,
    );
    // Seeded timestamps persisted for next round.
    const seeded = loadActivity();
    assert.equal(typeof seeded[1], "number");
    assert.equal(typeof seeded[2], "number");
  } finally {
    ctx.cleanup();
  }
});

test("seeded space reclaims only after idle window elapses", async () => {
  const t0 = 1700000000000;
  const ctx = await setup({
    spaces: [{ taskId: "x", id: 1, name: "x", ownership: "agent" }],
  });
  try {
    await reclaimIdleTaskSpaces({ now: () => t0, log() {} });
    assert.equal(ctx.ego.taskSpaces.length, 1);
    // No touch in between; 3h later the seeded space is now reclaimable.
    state.reclaimDone = false;
    const r = await reclaimIdleTaskSpaces({
      now: () => t0 + 3 * HOUR,
      log() {},
    });
    assert.equal(r.reclaimed, 1);
    assert.equal(ctx.ego.taskSpaces.length, 0);
  } finally {
    ctx.cleanup();
  }
});

test("first-sight spaces are also exempt from the hard cap", async () => {
  const now = 1700000000000;
  const spaces = [];
  for (let i = 1; i <= 5; i++) {
    spaces.push({ taskId: `s${i}`, id: i, name: `s${i}`, ownership: "agent" });
  }
  // No activity records — all first-sight; cap must NOT reclaim any.
  const ctx = await setup({
    spaces,
    env: { EGO_RECLAIM_MAX_SPACES: "3" },
  });
  try {
    const r = await reclaimIdleTaskSpaces({ now: () => now, log() {} });
    assert.equal(r.reclaimed, 0);
    assert.equal(ctx.ego.taskSpaces.length, 5);
  } finally {
    ctx.cleanup();
  }
});
