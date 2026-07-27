import test from "node:test";
import assert from "node:assert/strict";

import { runMain } from "../dist/src/run.js";

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

test("runMain does not mutate caller-owned argv arrays", async () => {
  const argv = ["--debug-clicks"];
  const env = {};
  const stdout = captureStream();
  const stderr = captureStream();

  const exitCode = await runMain({
    argv,
    env,
    stdinText: 'console.log("ready")',
    stdout,
    stderr,
    services: { printUpdateBanner() {} },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(argv, ["--debug-clicks"]);
  assert.equal(env.EGO_BROWSER_DEBUG_CLICKS, "1");
  assert.equal(stdout.text(), "ready\n");
  assert.equal(stderr.text(), "");
});
