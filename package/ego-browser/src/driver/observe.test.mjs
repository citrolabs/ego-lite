import test from "node:test";
import assert from "node:assert/strict";

import { browserCdp, invalidateSession } from "../../dist/src/browser-runtime.js";
import { captureScreenshot } from "../../dist/src/driver/observe.js";
import { setOverrides } from "../../dist/src/state.js";

function withCdpRuntime(fn) {
  const previous = globalThis.ego;
  const sent = [];
  const runtime = {
    async listTabs() {
      return {
        tabs: [
          { targetId: "target-1", active: true, title: "Example", url: "https://example.com/" }
        ]
      };
    },
    sendCDPMessage(payload) {
      const request = JSON.parse(payload);
      sent.push(request);
      let result = {};
      if (request.method === "Target.attachToTarget") {
        result = { sessionId: "session-1" };
      } else if (request.method === "Page.captureScreenshot") {
        result = { data: Buffer.from("png").toString("base64") };
      } else if (request.method === "Runtime.evaluate") {
        result = { result: { value: "1" } };
      }
      queueMicrotask(() => runtime.onCDPMessage(JSON.stringify({ id: request.id, result })));
    },
    emit(method, params) {
      runtime.onCDPMessage(JSON.stringify({ sessionId: "session-1", method, params }));
    }
  };
  globalThis.ego = runtime;
  invalidateSession();
  return Promise.resolve()
    .then(() => fn({ runtime, sent }))
    .finally(() => {
      invalidateSession();
      if (previous === undefined) {
        delete globalThis.ego;
      } else {
        globalThis.ego = previous;
      }
    });
}

test("captureScreenshot skips page metric JavaScript while a native dialog is pending", async () => {
  const writes = [];
  const restore = setOverrides({
    async writeFile(path, data) {
      writes.push({ path, data });
    }
  });
  try {
    await withCdpRuntime(async ({ runtime, sent }) => {
      await browserCdp("Runtime.evaluate", { expression: "document.title" });
      runtime.emit("Page.javascriptDialogOpening", {
        type: "alert",
        message: "Blocked",
        url: "https://example.com/"
      });
      sent.length = 0;

      await captureScreenshot("/tmp/ego-browser-dialog-shot.png");

      assert.equal(sent.some((request) => request.method === "Runtime.evaluate"), false);
      const screenshot = sent.find((request) => request.method === "Page.captureScreenshot");
      assert.deepEqual(screenshot.params, {
        format: "png",
        captureBeyondViewport: false
      });
    });
  } finally {
    restore();
  }

  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, "/tmp/ego-browser-dialog-shot.png");
});
