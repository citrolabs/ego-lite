import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  bufferOutput,
  installLifecycleFlush,
  markHardStop,
  resetSink,
} from "../dist/src/output-sink.js";
import { touchRoundSpace } from "../dist/src/round-status.js";

// installLifecycleFlush registers once per process, so this file holds the
// only SDK-path lifecycle scenario.
test("beforeExit refreshes the round status before the SDK path flushes", async () => {
  resetSink();
  const chunks = [];
  const lifecycle = new EventEmitter();
  installLifecycleFlush(
    {
      write(chunk) {
        chunks.push(chunk);
      },
    },
    lifecycle,
  );
  bufferOutput("result\n");
  let releaseRefresh;
  touchRoundSpace(
    7,
    "research",
    () =>
      new Promise((resolve) => {
        releaseRefresh = () => {
          // The space was taken back meanwhile: this must not wipe the
          // script's output as a hard stop.
          markHardStop("the user controls this task space");
          resolve({
            state: "ready",
            pages: [
              { label: "p1", title: "Done", targetId: "t1", openedBy: "agent" },
            ],
          });
        };
      }),
  );

  lifecycle.emit("beforeExit");
  lifecycle.emit("beforeExit");
  assert.deepEqual(chunks, [], "nothing is written while the refresh runs");

  releaseRefresh();
  await new Promise((resolve) => setImmediate(resolve));
  lifecycle.emit("beforeExit");
  lifecycle.emit("exit");

  assert.equal(chunks.join(""), 'result\n[7 "research" ready: p1 "Done"]\n');
});
