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

function withCdpRuntime(fn, { evaluate } = {}) {
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
          result: { value: evaluate?.(request.params.expression) ?? "1" },
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

// A scrolled page: the viewport sits 1500px down the document, so a clip pinned
// to 0,0 would ask for content the compositor has not rasterized.
const scrolledPageInfo = {
  url: "https://example.com/",
  title: "Example",
  w: 800,
  h: 600,
  sx: 40,
  sy: 1500,
  pw: 800,
  ph: 3000,
};

function scrolledPageMetrics(expression) {
  return expression.includes("devicePixelRatio")
    ? "1"
    : JSON.stringify(scrolledPageInfo);
}

test("screenshot clips the viewport to the current scroll offset", async () => {
  const restore = setOverrides({ async writeFile() {} });
  try {
    await withCdpRuntime(
      async ({ sent }) => {
        await screenshot({ path: "/tmp/ego-browser-scrolled-shot.png" });

        const shot = sent.find(
          (request) => request.method === "Page.captureScreenshot",
        );
        assert.equal(shot.params.captureBeyondViewport, false);
        assert.deepEqual(shot.params.clip, {
          x: scrolledPageInfo.sx,
          y: scrolledPageInfo.sy,
          width: scrolledPageInfo.w,
          height: scrolledPageInfo.h,
          scale: 1,
        });
      },
      { evaluate: scrolledPageMetrics },
    );
  } finally {
    restore();
  }
});

test("screenshot keeps fullPage captures anchored to the document origin", async () => {
  const restore = setOverrides({ async writeFile() {} });
  try {
    await withCdpRuntime(
      async ({ sent }) => {
        await screenshot({
          path: "/tmp/ego-browser-fullpage-shot.png",
          fullPage: true,
        });

        const shot = sent.find(
          (request) => request.method === "Page.captureScreenshot",
        );
        assert.equal(shot.params.captureBeyondViewport, true);
        assert.deepEqual(shot.params.clip, {
          x: 0,
          y: 0,
          width: scrolledPageInfo.pw,
          height: scrolledPageInfo.ph,
          scale: 1,
        });
      },
      { evaluate: scrolledPageMetrics },
    );
  } finally {
    restore();
  }
});

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

test("drainEvents returns the current event array synchronously", () => {
  assert.ok(Array.isArray(drainEvents()));
});
