import test from "node:test";
import assert from "node:assert/strict";

import { runMain } from "../dist/src/run.js";
import {
  __testing as screencastTesting,
  stopScreencast,
} from "../dist/src/driver/screencast.js";

// A minimal native ego whose only method reports a hard stop, the same shape the real
// bindings return when the user holds (or has not handed over) the task space. The
// `listTaskSpaces` helper lifts it through assertNoEgoError -> buildEgoError, which is
// where the sink is told a hard stop occurred.
function hardStopEgo(error_code) {
  return {
    calls: 0,
    async listTaskSpaces() {
      this.calls += 1;
      return {
        error: "native wording that should never reach the agent",
        error_code,
      };
    },
  };
}

// A native ego whose `snapshot` REJECTS with a hard-stop code — the shape the real
// bindings use under user control (helpers.ts probeAgentControl relies on it). driver/
// observe.ts calls browserEgo().snapshot() directly, so the rejection only reaches the
// sink if snapshot() routes it through buildEgoError.
function snapshotHardStopEgo(error_code) {
  return {
    calls: 0,
    async snapshot() {
      this.calls += 1;
      const err = new Error("native wording that should never reach the agent");
      err.error_code = error_code;
      throw err;
    },
  };
}

function captureStream() {
  const chunks = [];
  return {
    write(chunk) {
      chunks.push(String(chunk));
    },
    text() {
      return chunks.join("");
    },
  };
}

async function runScript(code, ego) {
  const previous = globalThis.ego;
  if (ego === undefined) {
    delete globalThis.ego;
  } else {
    globalThis.ego = ego;
  }
  const stdout = captureStream();
  const stderr = captureStream();
  let exitCode = null;
  let error = null;
  try {
    exitCode = await runMain({
      argv: [],
      stdinText: code,
      stdout,
      stderr,
      services: { printUpdateBanner() {} },
    });
  } catch (err) {
    error = err;
  } finally {
    if (previous === undefined) {
      delete globalThis.ego;
    } else {
      globalThis.ego = previous;
    }
  }
  return { exitCode, error, stdout: stdout.text(), stderr: stderr.text() };
}

test("a clean run flushes buffered console.log output in order", async () => {
  const result = await runScript(`console.log("one"); console.log("two");`);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "one\ntwo\n");
});

test("a swallowed user-control hard stop discards all output and prints the guidance once", async () => {
  const ego = hardStopEgo("EGO_TASK_SPACE_USER_IN_CONTROL");
  const result = await runScript(
    `
      for (const site of ["a", "b", "c"]) {
        console.log("visiting " + site);
        try {
          await taskSpaces.list();
          console.log("ok " + site);
        } catch (e) {
          console.log("failed " + site + ": " + e.message);
        }
      }
      console.log("summary: done");
    `,
    ego,
  );

  assert.equal(result.exitCode, 0);
  // Only the owned guidance survives — none of the script's own logging.
  assert.match(result.stdout, /taken control of this task space/);
  assert.match(result.stdout, /taskSpaces\.takeOver\(\)/);
  assert.doesNotMatch(result.stdout, /visiting|failed|ok |summary/);
  // Printed exactly once, even though every loop iteration re-reported the hard stop.
  assert.equal(result.stdout.match(/taskSpaces\.takeOver\(\)/g).length, 1);
  assert.ok(ego.calls >= 3, "every iteration should have hit the hard stop");
});

test("an inactive / unassigned task space is also a hard stop", async () => {
  const ego = hardStopEgo("EGO_TASK_SPACE_INACTIVE");
  const result = await runScript(
    `
      try {
        await taskSpaces.list();
      } catch (e) {
        console.log("swallowed: " + e.message);
      }
      console.log("more business output");
    `,
    ego,
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /no longer assigned to the agent/);
  assert.match(result.stdout, /taskSpaces\.claim\(id\)/);
  assert.doesNotMatch(result.stdout, /swallowed|business/);
});

test("a swallowed snapshot hard stop (rejected, not resolved) also collapses to one message", async () => {
  // snapshot rejects directly instead of resolving with { error }, so it bypasses
  // assertNoEgoError; the collapse only works if snapshot() rebuilds it via buildEgoError.
  const ego = snapshotHardStopEgo("EGO_TASK_SPACE_USER_IN_CONTROL");
  const result = await runScript(
    `
      for (const site of ["a", "b", "c"]) {
        console.log("visiting " + site);
        try {
          await page.snapshot();
          console.log("ok " + site);
        } catch (e) {
          console.log("failed " + site + ": " + e.message);
        }
      }
      console.log("summary: done");
    `,
    ego,
  );

  assert.equal(result.exitCode, 0);
  // The owned guidance survives once; the native wording and business logs are dropped.
  assert.match(result.stdout, /taken control of this task space/);
  assert.match(result.stdout, /taskSpaces\.takeOver\(\)/);
  assert.doesNotMatch(result.stdout, /native wording/);
  assert.doesNotMatch(result.stdout, /visiting|failed|ok |summary/);
  assert.equal(result.stdout.match(/taskSpaces\.takeOver\(\)/g).length, 1);
  assert.ok(
    ego.calls >= 3,
    "every iteration should have hit the snapshot hard stop",
  );
});

test("an uncaught hard stop discards output without double-printing the message", async () => {
  const ego = hardStopEgo("EGO_TASK_SPACE_USER_IN_CONTROL");
  const result = await runScript(
    `
      console.log("before");
      await taskSpaces.list();
      console.log("after");
    `,
    ego,
  );

  // The thrown Error already surfaces the message (the host prints it), so the sink
  // discards the buffer and stays silent rather than printing the guidance a second time.
  assert.ok(result.error, "expected runMain to reject");
  assert.match(result.error.message, /taken control of this task space/);
  assert.equal(result.stdout, "");
});

test("an ordinary uncaught error still flushes the output logged before it", async () => {
  const result = await runScript(`
    console.log("partial result");
    throw new Error("boom");
  `);

  assert.ok(result.error, "expected runMain to reject");
  assert.equal(result.error.message, "boom");
  assert.equal(result.stdout, "partial result\n");
});

test("an uncaught legacy task-space helper reports a stale skill instead of a ReferenceError", async () => {
  const result = await runScript(`
    await useOrCreateTaskSpace("checkout-flow");
  `);

  assert.ok(result.error, "expected runMain to reject");
  assert.equal(result.error.name, "EgoBrowserSkillStaleError");
  assert.match(result.error.message, /^\[ego-browser:skill-stale\]/);
  assert.match(result.error.message, /useOrCreateTaskSpace/);
  assert.match(result.error.message, /taskSpaces\.useOrCreate/);
  assert.doesNotMatch(result.error.message, /is not defined/);
  assert.equal(result.stdout, "");
});

test("a swallowed legacy task-space helper collapses output to one stale-skill message", async () => {
  const result = await runScript(`
    console.log("before");
    try {
      await useOrCreateTaskSpace("checkout-flow");
    } catch (error) {
      console.log("swallowed: " + error.message);
    }
    console.log("after");
  `);

  assert.equal(result.exitCode, 0);
  assert.equal(result.error, null);
  assert.match(result.stdout, /^\[ego-browser:skill-stale\]/);
  assert.match(result.stdout, /taskSpaces\.useOrCreate/);
  assert.doesNotMatch(result.stdout, /before|swallowed|after/);
  assert.equal(result.stdout.match(/\[ego-browser:skill-stale\]/g)?.length, 1);
});

test("runMain finalizes an active screencast when the script ends", async () => {
  let stopCalls = 0;
  const restore = screencastTesting.setOverrides({
    ensureSession: async () => "session-1",
    subscribeBrowserEvent: () => () => {},
    browserCdp: async (method) => {
      if (method === "Page.captureScreenshot") {
        return { result: { data: Buffer.from("fallback").toString("base64") } };
      }
      return { result: {} };
    },
    createRecorder: () => ({
      async start() {},
      writeFrame() {},
      async stop() {
        stopCalls += 1;
      },
    }),
  });
  try {
    const result = await runScript(`
      await page.screencast.start({
        path: "/tmp/auto-finalized.webm",
        size: { width: 640, height: 480 },
      });
      console.log("recorded");
    `);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "recorded\n");
    assert.equal(stopCalls, 1);
  } finally {
    await stopScreencast().catch(() => {});
    restore();
  }
});
