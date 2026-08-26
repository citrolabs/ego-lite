import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  browserCdp,
  invalidateSession,
} from "../../dist/src/browser-runtime.js";
import { captureScreenshot, snapshot } from "../../dist/src/driver/observe.js";
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
        result = {
          result: {
            value:
              request.params.expression === "window.devicePixelRatio"
                ? 2
                : {
                    w: 800,
                    h: 600,
                    sx: 24,
                    sy: 1200,
                    pw: 1600,
                    ph: 3000,
                  },
          },
        };
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

test("snapshot compacts the native result before returning it", async () => {
  const previous = globalThis.ego;
  const calls = [];
  globalThis.ego = {
    async snapshot(options) {
      calls.push(options);
      return {
        content: [
          "root",
          "  container",
          "    button [ref=1, loc=unstable]",
        ].join("\n"),
        refs: [{ refId: 1, backendNodeId: 1, loc: "unstable" }],
      };
    },
  };

  try {
    const result = await snapshot({ scope: "full_page" });
    assert.deepEqual(calls, [{ scope: "full_page" }]);
    assert.equal(result.content, "root\n  button [ref=1]");
    assert.equal(result.refs[0].loc, undefined);
  } finally {
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
});

test("captureScreenshot skips page metric JavaScript while a native dialog is pending", async () => {
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

      await captureScreenshot("/tmp/ego-browser-dialog-shot.png");

      assert.equal(
        sent.some((request) => request.method === "Runtime.evaluate"),
        false,
      );
      const screenshot = sent.find(
        (request) => request.method === "Page.captureScreenshot",
      );
      assert.deepEqual(screenshot.params, {
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

test("captureScreenshot clips the currently visible scrolled viewport", async () => {
  const restore = setOverrides({
    async writeFile() {},
  });
  try {
    await withCdpRuntime(async ({ sent }) => {
      await captureScreenshot("/tmp/ego-browser-scrolled-shot.png");

      const screenshot = sent.find(
        (request) => request.method === "Page.captureScreenshot",
      );
      assert.deepEqual(screenshot.params, {
        format: "png",
        captureBeyondViewport: false,
        clip: {
          x: 24,
          y: 1200,
          width: 800,
          height: 600,
          scale: 0.5,
        },
      });
    });
  } finally {
    restore();
  }
});

test("captureScreenshot keeps CSS-pixel sizing when scale is explicit", async () => {
  const restore = setOverrides({
    async writeFile() {},
  });
  try {
    await withCdpRuntime(async ({ sent }) => {
      await captureScreenshot("/tmp/ego-browser-css-shot.png", {
        scale: "css",
      });

      assert.equal(
        sent.some((request) => request.method === "Runtime.evaluate"),
        true,
      );
      const screenshot = sent.find(
        (request) => request.method === "Page.captureScreenshot",
      );
      assert.equal(screenshot.params.clip.scale, 0.5);
    });
  } finally {
    restore();
  }
});

test("captureScreenshot rejects unsupported device scale", async () => {
  await assert.rejects(
    () =>
      captureScreenshot("/tmp/ego-browser-device-shot.png", {
        scale: "device",
      }),
    /captureScreenshot scale must be css/,
  );
});

test("captureScreenshot creates missing parent directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-browser-screenshot-test-"));
  const outputPath = join(root, "nested", "screenshots", "page.png");
  try {
    await withCdpRuntime(async () => {
      assert.equal(await captureScreenshot(outputPath), outputPath);
    });
    assert.equal(await readFile(outputPath, "utf8"), "png");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
