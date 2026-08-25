import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { emitUpdateNotice } from "../dist/src/update-notice.js";

test("update notice is emitted only for a valid available update", async () => {
  const lines = [];
  const emit = (line) => lines.push(line);
  await emitUpdateNotice(
    {
      async getBrowserVersion() {
        return { currentVersion: "0.5.0.5", updateAvailable: false };
      },
    },
    emit,
  );
  await emitUpdateNotice({ async getBrowserVersion() {} }, emit);

  await emitUpdateNotice(
    {
      async getBrowserVersion() {
        return { currentVersion: "0.5.0.5", updateAvailable: true };
      },
    },
    emit,
  );
  assert.equal(lines.length, 1);
  const [line] = lines;
  assert.match(line, /^\[ego-browser:notice\]/);
  assert.match(line, /current 0\.5\.0\.5/);
  assert.match(line, /ego-browser upgrade/);
  assert.match(line, /ask the user/i);
});

test("version probing stays silent when unsupported, failed, or stalled", async () => {
  const lines = [];
  const emit = (line) => lines.push(line);
  await emitUpdateNotice({}, emit);
  await emitUpdateNotice(
    {
      async getBrowserVersion() {
        throw new Error("updater unavailable");
      },
    },
    emit,
  );
  // Simulate a stalled probe that outlasts emitUpdateNotice's own race timeout,
  // but still settles (ref'd, so it keeps the process alive until it does)
  // instead of dangling forever — Node's test runner fails the run on
  // promises still pending when the event loop would otherwise be empty.
  await emitUpdateNotice({ getBrowserVersion: () => delay(1_000) }, emit);
  assert.deepEqual(lines, []);
});

test("SDK startup appends one update notice on a clean run", () => {
  const result = runSdk(`
    globalThis.ego = {
      async getBrowserVersion() {
        return { currentVersion: "0.5.0.5", updateAvailable: true };
      },
    };
    await import(SDK_URL);
    await new Promise((resolve) => setImmediate(resolve));
  `);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.match(/\[ego-browser:notice\]/g)?.length, 1);
  assert.match(result.stdout, /ego-browser upgrade/);
});

test("a hard stop discards a queued update notice", () => {
  const result = runSdk(`
    globalThis.ego = {
      async getBrowserVersion() {
        return { currentVersion: "0.5.0.5", updateAvailable: true };
      },
    };
    await import(SDK_URL);
    await new Promise((resolve) => setImmediate(resolve));
    try {
      await egoBrowser.newTaskSpace("stale 1.3 skill");
    } catch {}
  `);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[ego-browser:skill-stale\]/);
  assert.doesNotMatch(result.stdout, /\[ego-browser:notice\]/);
});

function runSdk(source) {
  const sdkUrl = new URL("../dist/src/index.js", import.meta.url).href;
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      source.replaceAll("SDK_URL", JSON.stringify(sdkUrl)),
    ],
    { encoding: "utf8" },
  );
}
