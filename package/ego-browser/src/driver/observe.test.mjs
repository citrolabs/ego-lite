import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  browserCdp,
  invalidateSession,
} from "../../dist/src/browser-runtime.js";
import { drainEvents, screenshot } from "../../dist/src/driver/observe.js";
import { setOverrides } from "../../dist/src/state.js";

function withCdpRuntime(fn) {
  const previous = globalThis.ego;
  const sent = [];
  const runtime = {
    async listTabs() {
      return {
        tabs: [
          {
            targetId: "target-1",
            active: true,
            title: "Example",
            url: "https://example.com/",
          },
        ],
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
        const value = request.params.expression.includes(
          "document.documentElement",
        )
          ? JSON.stringify({
              url: "https://example.com/",
              title: "Example",
              w: 1280,
              h: 720,
              sx: 32,
              sy: 8192,
              pw: 1280,
              ph: 12000,
            })
          : "2";
        result = { result: { value } };
      }
      queueMicrotask(() =>
        runtime.onCDPMessage(JSON.stringify({ id: request.id, result })),
      );
    },
    emit(method, params) {
      runtime.onCDPMessage(
        JSON.stringify({ sessionId: "session-1", method, params }),
      );
    },
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

test("screenshot skips page metric JavaScript while a native dialog is pending", async () => {
  const writes = [];
  const restore = setOverrides({
    async writeFile(path, data) {
      writes.push({ path, data });
    },
  });
  try {
    await withCdpRuntime(async ({ runtime, sent }) => {
      await browserCdp("Runtime.evaluate", { expression: "document.title" });
      runtime.emit("Page.javascriptDialogOpening", {
        type: "alert",
        message: "Blocked",
        url: "https://example.com/",
      });
      sent.length = 0;

      await screenshot({ path: "/tmp/ego-browser-dialog-shot.png" });

      assert.equal(
        sent.some((request) => request.method === "Runtime.evaluate"),
        false,
      );
      const shot = sent.find(
        (request) => request.method === "Page.captureScreenshot",
      );
      assert.deepEqual(shot.params, {
        format: "png",
        captureBeyondViewport: false,
      });
    });
  } finally {
    restore();
  }

  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, "/tmp/ego-browser-dialog-shot.png");
});

test("screenshot creates a missing parent directory", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "ego-browser-observe-"));
  const path = join(tempDir, "nested", "shot.png");
  try {
    await withCdpRuntime(() => screenshot({ path, raw: true }));
    assert.equal((await readFile(path)).toString(), "png");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("screenshot clips the viewport at the current document scroll offset", async () => {
  const restore = setOverrides({
    async writeFile() {},
  });
  try {
    await withCdpRuntime(async ({ sent }) => {
      await screenshot({ path: "/tmp/ego-browser-scrolled-shot.png" });

      const shot = sent.find(
        (request) => request.method === "Page.captureScreenshot",
      );
      assert.deepEqual(shot.params, {
        format: "png",
        captureBeyondViewport: false,
        clip: {
          x: 32,
          y: 8192,
          width: 1280,
          height: 720,
          scale: 0.5,
        },
      });
    });
  } finally {
    restore();
  }
});

test("drainEvents returns the current event array synchronously", () => {
  assert.ok(Array.isArray(drainEvents()));
});
