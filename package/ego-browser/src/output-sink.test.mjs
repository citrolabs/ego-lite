import test from "node:test";
import assert from "node:assert/strict";

import {
  bufferOutput,
  flushSink,
  markHardStop,
  resetSink,
  setNoticeTrailer,
} from "../dist/src/output-sink.js";

function fakeStream() {
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

test("flushSink writes buffered output verbatim on a clean run", () => {
  resetSink();
  bufferOutput("a\n");
  bufferOutput("b\n");
  const out = fakeStream();
  flushSink(out, false);
  assert.equal(out.text(), "a\nb\n");
});

test("a swallowed hard stop discards the buffer and prints the owned message once", () => {
  resetSink();
  bufferOutput("visiting\n");
  markHardStop("HARD STOP MESSAGE");
  markHardStop("a later re-report that must be ignored");
  const out = fakeStream();
  flushSink(out, false);
  assert.equal(out.text(), "HARD STOP MESSAGE\n");
});

test("a thrown hard stop stays silent so the propagating error is not echoed twice", () => {
  resetSink();
  bufferOutput("visiting\n");
  markHardStop("HARD STOP MESSAGE");
  const out = fakeStream();
  flushSink(out, true);
  assert.equal(out.text(), "");
});

test("an ordinary thrown error still flushes what was logged before it", () => {
  resetSink();
  bufferOutput("partial\n");
  const out = fakeStream();
  flushSink(out, true);
  assert.equal(out.text(), "partial\n");
});

test("flushSink runs at most once", () => {
  resetSink();
  bufferOutput("x\n");
  const out = fakeStream();
  flushSink(out, false);
  flushSink(out, false);
  assert.equal(out.text(), "x\n");
});

test("a message that already ends in a newline is not double-terminated", () => {
  resetSink();
  markHardStop("already terminated\n");
  const out = fakeStream();
  flushSink(out, false);
  assert.equal(out.text(), "already terminated\n");
});

test("a stale-skill hard stop remains distinct from a trailing update notice", () => {
  resetSink();
  markHardStop("[ego-browser:skill-stale] re-read the skill");
  setNoticeTrailer("[ego-browser:notice] ego lite update available");
  const out = fakeStream();
  flushSink(out, false);
  assert.equal(
    out.text(),
    [
      "[ego-browser:skill-stale] re-read the skill",
      "[ego-browser:notice] ego lite update available",
      "",
    ].join("\n"),
  );
});
