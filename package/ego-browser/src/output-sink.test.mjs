import test from "node:test";
import assert from "node:assert/strict";

import {
  beginOutputBoundary,
  bufferOutput,
  finishOutputBoundary,
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

test("output boundaries isolate hard stops between REPL cells", () => {
  const out = fakeStream();

  beginOutputBoundary();
  bufferOutput("cell one business output\n");
  markHardStop("CELL ONE HARD STOP");
  const first = finishOutputBoundary(out, false);

  beginOutputBoundary();
  bufferOutput("cell two normal output\n");
  const second = finishOutputBoundary(out, false);

  assert.deepEqual(first, { hardStop: true, wrote: true });
  assert.deepEqual(second, { hardStop: false, wrote: true });
  assert.equal(out.text(), "CELL ONE HARD STOP\ncell two normal output\n");
});

test("a notice trailer set before the boundary begins flushes once, as a footer", () => {
  resetSink();
  // The fire-and-forget probe typically resolves during REPL bootstrap, long before
  // the first cell arrives — the pending trailer must survive the per-cell reset.
  setNoticeTrailer("[ego-browser:notice] update available");
  const out = fakeStream();

  beginOutputBoundary();
  bufferOutput("cell one output\n");
  finishOutputBoundary(out, false);

  beginOutputBoundary();
  bufferOutput("cell two output\n");
  finishOutputBoundary(out, false);

  assert.equal(
    out.text(),
    "cell one output\n[ego-browser:notice] update available\ncell two output\n",
  );
});

test("the notice trailer still trails the owned message on a hard stop", () => {
  resetSink();
  setNoticeTrailer("[ego-browser:notice] update available\n");
  const out = fakeStream();

  beginOutputBoundary();
  bufferOutput("business output to discard\n");
  markHardStop("HARD STOP MESSAGE");
  finishOutputBoundary(out, false);

  assert.equal(
    out.text(),
    "HARD STOP MESSAGE\n[ego-browser:notice] update available\n",
  );
});

test("output boundaries flush host stdout capture on clean completion", () => {
  let captured = "captured console output\n";
  const capture = {
    clear() {
      captured = "";
    },
    take() {
      return captured || "captured after clear\n";
    },
  };
  const out = fakeStream();

  beginOutputBoundary(capture);
  const result = finishOutputBoundary(out, false);

  assert.deepEqual(result, { hardStop: false, wrote: true });
  assert.equal(out.text(), "captured after clear\n");
});

test("output boundaries discard host stdout capture on hard stop", () => {
  const capture = {
    clear() {},
    take() {
      return "captured business output\n";
    },
  };
  const out = fakeStream();

  beginOutputBoundary(capture);
  markHardStop("CAPTURE HARD STOP");
  const result = finishOutputBoundary(out, false);

  assert.deepEqual(result, { hardStop: true, wrote: true });
  assert.equal(out.text(), "CAPTURE HARD STOP\n");
});
