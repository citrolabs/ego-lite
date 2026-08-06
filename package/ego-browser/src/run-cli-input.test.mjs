import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HELP, USAGE, runMain } from "../dist/src/run.js";

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

async function run(argv, options = {}) {
  const stdout = captureStream();
  const stderr = captureStream();
  const exitCode = await runMain({
    argv,
    stdout,
    stderr,
    env: {},
    ...options,
  });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

test("runMain executes a script file named by the positional argument", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ego-browser-run-"));
  try {
    const scriptPath = join(dir, "task.js");
    await writeFile(scriptPath, "console.log('from file: café')", "utf8");
    const result = await run([scriptPath]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /from file: café/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runMain reports an unreadable script file and exits 1", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ego-browser-run-"));
  try {
    const missing = join(dir, "missing.js");
    const result = await run([missing]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /cannot read script file/);
    assert.match(result.stderr, /missing\.js/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runMain executes inline code passed with -e", async () => {
  const result = await run(["-e", "console.log('inline ran')"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /inline ran/);
});

test("runMain executes inline code passed with --eval", async () => {
  const result = await run(["--eval", "console.log('eval ran')"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /eval ran/);
});

test("runMain rejects -e without code", async () => {
  const result = await run(["-e"]);
  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, USAGE);
});

test("runMain rejects -e with extra arguments", async () => {
  const result = await run(["-e", "console.log(1)", "extra"]);
  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, USAGE);
});

test("runMain rejects more than one positional argument", async () => {
  const result = await run(["a.js", "b.js"]);
  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, USAGE);
});

test("runMain rejects an unknown flag", async () => {
  const result = await run(["--unknown"]);
  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, USAGE);
});

test("runMain still reads stdin when no input arguments are given", async () => {
  const result = await run([], { stdinText: "console.log('stdin ran')" });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /stdin ran/);
});

test("runMain combines --debug-clicks with a script file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ego-browser-run-"));
  try {
    const scriptPath = join(dir, "task.js");
    await writeFile(scriptPath, "console.log('debug file ran')", "utf8");
    const env = {};
    const result = await run(["--debug-clicks", scriptPath], { env });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /debug file ran/);
    assert.equal(env.EGO_BROWSER_DEBUG_CLICKS, "1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("help output documents the script file and -e forms", () => {
  assert.match(HELP, /<script\.js>/);
  assert.match(HELP, /-e <code>/);
  assert.match(USAGE, /<script\.js>/);
});
