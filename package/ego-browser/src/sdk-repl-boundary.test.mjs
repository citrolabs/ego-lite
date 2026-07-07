import test from "node:test";
import assert from "node:assert/strict";

import { installEgoSdk } from "../dist/src/index.js";
import { markHardStop } from "../dist/src/output-sink.js";

function hostCapture() {
  return {
    text: "",
    clear() {
      this.text = "";
    },
    take() {
      const value = this.text;
      this.text = "";
      return value;
    },
    append(text) {
      this.text += text;
    },
  };
}

async function withCapturedProcessStdout(fn) {
  const originalWrite = process.stdout.write;
  const originalConsoleLog = console.log;
  let stdout = "";
  process.stdout.write = function (chunk, encodingOrCallback, callback) {
    stdout += String(chunk);
    if (typeof encodingOrCallback === "function") encodingOrCallback();
    if (typeof callback === "function") callback();
    return true;
  };
  try {
    await fn(() => stdout);
  } finally {
    process.stdout.write = originalWrite;
    console.log = originalConsoleLog;
  }
}

test("installEgoSdk flushes host REPL stdout capture after each clean evaluation", async () => {
  await withCapturedProcessStdout(async (stdout) => {
    const capture = hostCapture();
    const target = {
      ego: {},
      __egoNodeOutputCapture: capture,
      async __egoEvaluateReplScript(source) {
        capture.append(`captured ${source}\n`);
      },
      __egoCompleteReplEvaluation() {},
    };

    installEgoSdk(target);
    await target.__egoEvaluateReplScript("one");
    target.__egoCompleteReplEvaluation();
    await target.__egoEvaluateReplScript("two");
    target.__egoCompleteReplEvaluation();

    assert.equal(stdout(), "captured one\ncaptured two\n");
  });
});

test("installEgoSdk discards host REPL capture and prints one hard-stop message", async () => {
  await withCapturedProcessStdout(async (stdout) => {
    const capture = hostCapture();
    const target = {
      ego: {},
      __egoNodeOutputCapture: capture,
      async __egoEvaluateReplScript(source) {
        capture.append(`business ${source}\n`);
        markHardStop("SDK HARD STOP");
      },
      __egoCompleteReplEvaluation() {},
    };

    installEgoSdk(target);
    await target.__egoEvaluateReplScript("cell");
    target.__egoCompleteReplEvaluation();

    assert.equal(stdout(), "SDK HARD STOP\n");
  });
});

test("installEgoSdk flushes ordinary output before a thrown REPL evaluation error", async () => {
  await withCapturedProcessStdout(async (stdout) => {
    const capture = hostCapture();
    const target = {
      ego: {},
      __egoNodeOutputCapture: capture,
      async __egoEvaluateReplScript() {
        capture.append("before ordinary throw\n");
        throw new Error("ordinary throw");
      },
      __egoCompleteReplEvaluation() {},
    };

    installEgoSdk(target);
    await assert.rejects(
      () => target.__egoEvaluateReplScript("cell"),
      /ordinary throw/,
    );

    assert.equal(stdout(), "before ordinary throw\n");
  });
});

test("installEgoSdk keeps thrown hard stops silent for the host error printer", async () => {
  await withCapturedProcessStdout(async (stdout) => {
    const capture = hostCapture();
    const target = {
      ego: {},
      __egoNodeOutputCapture: capture,
      async __egoEvaluateReplScript() {
        capture.append("before hard stop throw\n");
        markHardStop("SDK HARD STOP THROW");
        throw new Error("hard stop throw");
      },
      __egoCompleteReplEvaluation() {},
    };

    installEgoSdk(target);
    await assert.rejects(
      () => target.__egoEvaluateReplScript("cell"),
      /hard stop throw/,
    );

    assert.equal(stdout(), "");
  });
});
