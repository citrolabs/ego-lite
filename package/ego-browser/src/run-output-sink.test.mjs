import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { runMain } from "../dist/src/run.js";

// A minimal native ego whose only method reports a hard stop, the same shape the real
// bindings return when the user holds (or has not handed over) the task space. The
// `listTaskSpaces` helper lifts it through invokeEgo -> buildEgoError, which is
// where the sink is told a hard stop occurred.
function hardStopEgo(
  error_code,
  error = "native wording that should never reach the agent",
) {
  return {
    calls: 0,
    async listTaskSpaces() {
      this.calls += 1;
      return {
        error,
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

test("a clean run flushes buffered cliLog output in order", async () => {
  const result = await runScript(`cliLog("one"); cliLog("two");`);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "one\ntwo\n");
});

test("round console methods share the buffered output channel", async () => {
  const result = await runScript(`
    console.log("plain", { value: 1 });
    console.info("info");
    console.warn("careful");
    console.error("broken");
    cliLog("legacy");
  `);

  assert.equal(result.exitCode, 0);
  assert.equal(
    result.stdout,
    "plain { value: 1 }\ninfo\n[warn] careful\n[error] broken\nlegacy\n",
  );
});

test("a hard stop discards console output together with cliLog output", async () => {
  const ego = hardStopEgo("EGO_TASK_SPACE_USER_IN_CONTROL");
  const result = await runScript(
    `
      console.log("before");
      try { await listTaskSpaces(); } catch {}
      console.warn("after");
    `,
    ego,
  );

  assert.match(result.stdout, /taken control of this task space/);
  assert.doesNotMatch(result.stdout, /before|after/);
});

test("a swallowed user-control hard stop discards all output and prints the guidance once", async () => {
  const ego = hardStopEgo("EGO_TASK_SPACE_USER_IN_CONTROL");
  const result = await runScript(
    `
      for (const site of ["a", "b", "c"]) {
        cliLog("visiting " + site);
        try {
          await listTaskSpaces();
          cliLog("ok " + site);
        } catch (e) {
          cliLog("failed " + site + ": " + e.message);
        }
      }
      cliLog("summary: done");
    `,
    ego,
  );

  assert.equal(result.exitCode, 0);
  // Only the owned guidance survives — none of the script's own logging.
  assert.match(result.stdout, /taken control of this task space/);
  assert.match(result.stdout, /takeOverTaskSpace\(spaceId\)/);
  assert.doesNotMatch(result.stdout, /visiting|failed|ok |summary/);
  // Printed exactly once, even though every loop iteration re-reported the hard stop.
  assert.equal(result.stdout.match(/takeOverTaskSpace\(spaceId\)/g).length, 1);
  assert.ok(ego.calls >= 3, "every iteration should have hit the hard stop");
});

test("a swallowed 1.3 skill mismatch discards business output and explains recovery", async () => {
  const result = await runScript(`
    console.log("before stale call");
    try {
      await egoBrowser.newTaskSpace("stale skill");
    } catch (error) {
      console.log("caught: " + error.message);
    }
    console.log("after stale call");
  `);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /\[ego-browser:skill-stale\]/);
  assert.match(result.stdout, /Run `ego-browser skill`/);
  assert.match(result.stdout, /taskSpace\(nameOrId\)/);
  assert.doesNotMatch(result.stdout, /before stale|caught:|after stale/);
  assert.equal(result.stdout.match(/\[ego-browser:skill-stale\]/g).length, 1);
});

test("a permission hard stop discards business output and keeps its specific guidance", async () => {
  const ego = hardStopEgo("EGO_TASK_SPACE_USER_IN_CONTROL", "camera");
  const result = await runScript(
    `
      console.log("before permission");
      try { await listTaskSpaces(); } catch {}
      console.log("after permission");
    `,
    ego,
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /camera access/);
  assert.match(result.stdout, /takeOverTaskSpace\(spaceId\)/);
  assert.doesNotMatch(result.stdout, /before permission|after permission/);
  assert.equal(result.stdout.match(/camera access/g).length, 1);
});

test("an inactive / unassigned task space is also a hard stop", async () => {
  const ego = hardStopEgo("EGO_TASK_SPACE_INACTIVE");
  const result = await runScript(
    `
      try {
        await listTaskSpaces();
      } catch (e) {
        cliLog("swallowed: " + e.message);
      }
      cliLog("more business output");
    `,
    ego,
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /no longer assigned to the agent/);
  assert.match(result.stdout, /claimTaskSpace\(spaceId\)/);
  assert.doesNotMatch(result.stdout, /swallowed|business/);
});

test("a swallowed snapshot hard stop (rejected, not resolved) also collapses to one message", async () => {
  // snapshot rejects directly instead of resolving with { error }, so it bypasses
  // invokeEgo; the collapse only works if snapshot() rebuilds it via buildEgoError.
  const ego = snapshotHardStopEgo("EGO_TASK_SPACE_USER_IN_CONTROL");
  const result = await runScript(
    `
      for (const site of ["a", "b", "c"]) {
        cliLog("visiting " + site);
        try {
          await snapshotText();
          cliLog("ok " + site);
        } catch (e) {
          cliLog("failed " + site + ": " + e.message);
        }
      }
      cliLog("summary: done");
    `,
    ego,
  );

  assert.equal(result.exitCode, 0);
  // The owned guidance survives once; the native wording and business logs are dropped.
  assert.match(result.stdout, /taken control of this task space/);
  assert.match(result.stdout, /takeOverTaskSpace\(spaceId\)/);
  assert.doesNotMatch(result.stdout, /native wording/);
  assert.doesNotMatch(result.stdout, /visiting|failed|ok |summary/);
  assert.equal(result.stdout.match(/takeOverTaskSpace\(spaceId\)/g).length, 1);
  assert.ok(
    ego.calls >= 3,
    "every iteration should have hit the snapshot hard stop",
  );
});

test("an uncaught hard stop discards output without double-printing the message", async () => {
  const ego = hardStopEgo("EGO_TASK_SPACE_USER_IN_CONTROL");
  const result = await runScript(
    `
      cliLog("before");
      await listTaskSpaces();
      cliLog("after");
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
    cliLog("partial result");
    throw new Error("boom");
  `);

  assert.ok(result.error, "expected runMain to reject");
  assert.equal(result.error.message, "boom");
  assert.equal(result.stdout, "partial result\n");
});

for (const [globalName, expression] of [
  ["document", "document.body"],
  ["window", "window.scrollY"],
  ["location", "location.href"],
  ["scrollY", "scrollY"],
]) {
  test(`a top-level ${globalName} ReferenceError explains the Node and Page execution boundary`, async () => {
    const result = await runScript(`console.log(${expression});`);

    assert.ok(result.error, "expected runMain to reject");
    assert.match(
      result.error.message,
      new RegExp(`${globalName} is not defined`, "i"),
    );
    assert.match(
      result.error.message,
      /heredoc runs in Node\.js, not in the Page/i,
    );
    assert.match(result.error.message, /page\.evaluate\(\)/i);
  });
}

test("a syntax error points to the invalid user-script line", async () => {
  const result = await runScript(`
const task = await taskSpace(556);
const rows = (await task.pages()).map(page => ({ title: await page.title() }));
console.log(rows);
`);

  assert.ok(result.error, "expected runMain to reject");
  assert.match(result.error.message, /syntax error at line 3, column \d+/i);
  assert.match(result.error.message, /3 \| const rows =/);
  assert.match(result.error.message, /\^/);
  assert.doesNotMatch(result.error.message, /node:internal\/vm/);
});

test("the direct CLI rejects removed placeholder commands", async () => {
  for (const command of ["--doctor", "--reload", "--debug-clicks"]) {
    const stdout = captureStream();
    const stderr = captureStream();
    const exitCode = await runMain({
      argv: [command],
      stdinText: "",
      stdout,
      stderr,
    });

    assert.equal(exitCode, 2, command);
    assert.equal(stdout.text(), "", command);
    assert.match(stderr.text(), /^Usage:/, command);
  }
});

test("the direct CLI prints an ordinary uncaught error once", () => {
  const entry = new URL("../dist/out/index.js", import.meta.url);
  const result = spawnSync(process.execPath, [entry.pathname], {
    input: 'throw new Error("single-error-probe")\n',
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.equal(result.stderr.match(/single-error-probe/g)?.length, 1);
});
