import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { lineSplitter, run, ProcessError } from "./proc.mjs";

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("run resolves with stdout and rejects on a non-zero exit", async () => {
  const ok = await run("sh", ["-c", "printf hi; cat"], { input: " there" });
  assert.equal(ok.stdout, "hi there");
  await assert.rejects(run("sh", ["-c", "echo boom >&2; exit 3"]), (err) => {
    assert.ok(err instanceof ProcessError);
    assert.equal(err.code, 3);
    assert.match(err.message, /boom/);
    return true;
  });
  const tolerated = await run("sh", ["-c", "exit 2"], { allowFailure: true });
  assert.equal(tolerated.code, 2);
});

test("a failure message carries both stdout and stderr", async () => {
  await assert.rejects(
    run("sh", ["-c", "echo hook-output; echo git-error >&2; exit 1"]),
    (err) => /hook-output[\s\S]*git-error/.test(err.message),
  );
});

test("a timeout kills the child's descendants too", async () => {
  const pidFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "autofix-proc-")),
    "pid",
  );
  await assert.rejects(
    run("sh", ["-c", `sleep 30 & echo $! > ${pidFile}; wait`], {
      timeoutMs: 300,
    }),
    (err) => err.timedOut === true,
  );
  const grandchild = Number(fs.readFileSync(pidFile, "utf8"));
  assert.ok(grandchild > 0);
  assert.equal(
    alive(grandchild),
    false,
    "background sleep should have been killed with the group",
  );
});

test("run shows complete output lines from both streams as they arrive", async () => {
  const lines = [];
  await run(
    "sh",
    ["-c", "printf 'a\\nb'; printf 'err\\n' >&2; sleep 0.1; printf 'c\\n'"],
    { onLine: (line) => lines.push(line) },
  );
  assert.deepEqual(lines.sort(), ["a", "bc", "err"]);
});

test("lineSplitter survives a callback that throws", () => {
  const seen = [];
  const original = console.error;
  console.error = () => {};
  try {
    const feed = lineSplitter((line) => {
      seen.push(line);
      throw new Error("boom");
    });
    feed("x\ny\n");
  } finally {
    console.error = original;
  }
  assert.deepEqual(seen, ["x", "y"]);
});
