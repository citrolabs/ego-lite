import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadActivity,
  reclaimConfig,
  reclaimStateFile,
  saveActivity,
  touchTaskSpace,
} from "../dist/src/taskspace-activity.js";

async function withStateFile(fn) {
  const dir = mkdtempSync(join(tmpdir(), "ego-act-"));
  const file = join(dir, "state.json");
  const prev = process.env.EGO_RECLAIM_STATE_FILE;
  process.env.EGO_RECLAIM_STATE_FILE = file;
  try {
    return await fn(file);
  } finally {
    if (prev === undefined) delete process.env.EGO_RECLAIM_STATE_FILE;
    else process.env.EGO_RECLAIM_STATE_FILE = prev;
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

test("save/load activity round-trips space timestamps", async () => {
  await withStateFile(async () => {
    await saveActivity({ 1: 1000, 2: 2000 });
    assert.deepEqual(loadActivity(), { 1: 1000, 2: 2000 });
  });
});

test("touchTaskSpace records a fresh timestamp", async () => {
  await withStateFile(async () => {
    await touchTaskSpace(7);
    const map = loadActivity();
    assert.ok(typeof map[7] === "number");
    assert.ok(Math.abs(map[7] - Date.now()) < 5000);
  });
});

test("loadActivity is tolerant of missing and corrupt files", async () => {
  await withStateFile(async (file) => {
    assert.deepEqual(loadActivity(), {});
    writeFileSync(file, "{not json", "utf8");
    assert.deepEqual(loadActivity(), {});
  });
});

test("reclaimConfig defaults and env overrides", () => {
  const prev = {
    idle: process.env.EGO_RECLAIM_IDLE_S,
    max: process.env.EGO_RECLAIM_MAX_SPACES,
    dis: process.env.EGO_RECLAIM_DISABLE,
  };
  try {
    delete process.env.EGO_RECLAIM_IDLE_S;
    delete process.env.EGO_RECLAIM_MAX_SPACES;
    delete process.env.EGO_RECLAIM_DISABLE;
    assert.deepEqual(reclaimConfig(), {
      idleSec: 7200,
      maxSpaces: 8,
      disabled: false,
    });
    process.env.EGO_RECLAIM_IDLE_S = "1800";
    process.env.EGO_RECLAIM_MAX_SPACES = "4";
    process.env.EGO_RECLAIM_DISABLE = "1";
    assert.deepEqual(reclaimConfig(), {
      idleSec: 1800,
      maxSpaces: 4,
      disabled: true,
    });
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("reclaimStateFile respects env override", () => {
  const prev = process.env.EGO_RECLAIM_STATE_FILE;
  try {
    process.env.EGO_RECLAIM_STATE_FILE = "/tmp/custom-state.json";
    assert.equal(reclaimStateFile(), "/tmp/custom-state.json");
  } finally {
    if (prev === undefined) delete process.env.EGO_RECLAIM_STATE_FILE;
    else process.env.EGO_RECLAIM_STATE_FILE = prev;
  }
});
