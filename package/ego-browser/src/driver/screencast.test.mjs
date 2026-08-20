import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

test("startScreencast starts the encoder before the CDP frame stream", async () => {
  const module = await import("../../dist/src/driver/screencast.js").catch(
    () => ({}),
  );
  assert.equal(typeof module.startScreencast, "function");
  assert.equal(typeof module.__testing?.setOverrides, "function");

  const order = [];
  const cdpCalls = [];
  let recorderOptions;
  const restore = module.__testing.setOverrides({
    ensureSession: async () => "session-1",
    pageInfo: async () => ({ w: 1200, h: 900 }),
    subscribeBrowserEvent: () => () => {},
    browserCdp: async (method, params, sessionId) => {
      order.push(`cdp:${method}`);
      cdpCalls.push({ method, params, sessionId });
      if (method === "Page.captureScreenshot") {
        return { result: { data: Buffer.from("fallback").toString("base64") } };
      }
      return { result: {} };
    },
    createRecorder: (options) => {
      recorderOptions = options;
      return {
        async start() {
          order.push("recorder:start");
        },
        writeFrame() {},
        async stop() {},
      };
    },
  });
  try {
    await module.startScreencast({ path: "artifacts/run.webm" });

    assert.deepEqual(order, ["recorder:start", "cdp:Page.startScreencast"]);
    assert.deepEqual(recorderOptions, {
      outputPath: resolve("artifacts/run.webm"),
      size: { width: 800, height: 600 },
    });
    assert.deepEqual(cdpCalls[0], {
      method: "Page.startScreencast",
      params: {
        format: "jpeg",
        quality: 90,
        maxWidth: 800,
        maxHeight: 600,
      },
      sessionId: "session-1",
    });
  } finally {
    await module.stopScreencast?.();
    restore?.();
  }
});

test("startScreencast forwards JPEG frames and acknowledges them", async () => {
  const module = await import("../../dist/src/driver/screencast.js");
  const cdpCalls = [];
  const frames = [];
  let frameListener;
  const restore = module.__testing.setOverrides({
    ensureSession: async () => "session-1",
    subscribeBrowserEvent: (_method, _sessionId, listener) => {
      frameListener = listener;
      return () => {};
    },
    browserCdp: async (method, params, sessionId) => {
      cdpCalls.push({ method, params, sessionId });
      return { result: {} };
    },
    createRecorder: () => ({
      async start() {},
      writeFrame(buffer, timestamp) {
        frames.push({ buffer, timestamp });
      },
      async stop() {},
    }),
  });
  try {
    await module.startScreencast({
      path: "artifacts/run.webm",
      size: { width: 640, height: 480 },
    });

    frameListener({
      method: "Page.screencastFrame",
      sessionId: "session-1",
      params: {
        data: Buffer.from("frame").toString("base64"),
        sessionId: 7,
        metadata: { timestamp: 1.25 },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(frames.length, 1);
    assert.equal(frames[0].buffer.toString(), "frame");
    assert.equal(frames[0].timestamp, 1250);
    assert.deepEqual(cdpCalls.at(-1), {
      method: "Page.screencastFrameAck",
      params: { sessionId: 7 },
      sessionId: "session-1",
    });
  } finally {
    await module.stopScreencast();
    restore();
  }
});

test("startScreencast acknowledges a frame only after the encoder accepts it", async () => {
  const module = await import("../../dist/src/driver/screencast.js");
  const cdpMethods = [];
  let frameListener;
  let acceptFrame;
  const restore = module.__testing.setOverrides({
    ensureSession: async () => "session-1",
    subscribeBrowserEvent: (_method, _sessionId, listener) => {
      frameListener = listener;
      return () => {};
    },
    browserCdp: async (method) => {
      cdpMethods.push(method);
      return { result: {} };
    },
    createRecorder: () => ({
      async start() {},
      writeFrame() {
        return new Promise((resolve) => {
          acceptFrame = resolve;
        });
      },
      async stop() {},
    }),
  });
  try {
    await module.startScreencast({
      path: "artifacts/run.webm",
      size: { width: 640, height: 480 },
    });
    frameListener({
      params: {
        data: Buffer.from("frame").toString("base64"),
        sessionId: 7,
        metadata: { timestamp: 1 },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(cdpMethods.includes("Page.screencastFrameAck"), false);
    acceptFrame();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cdpMethods.includes("Page.screencastFrameAck"), true);
  } finally {
    acceptFrame?.();
    await module.stopScreencast().catch(() => {});
    restore();
  }
});

test("stopScreencast waits for an in-flight frame before finalizing", async () => {
  const module = await import("../../dist/src/driver/screencast.js");
  let frameListener;
  let acceptFrame;
  let recorderStopCalls = 0;
  const restore = module.__testing.setOverrides({
    ensureSession: async () => "session-1",
    subscribeBrowserEvent: (_method, _sessionId, listener) => {
      frameListener = listener;
      return () => {};
    },
    browserCdp: async () => ({ result: {} }),
    createRecorder: () => ({
      async start() {},
      writeFrame() {
        return new Promise((resolve) => {
          acceptFrame = resolve;
        });
      },
      async stop() {
        recorderStopCalls += 1;
      },
    }),
  });
  try {
    await module.startScreencast({
      path: "artifacts/run.webm",
      size: { width: 640, height: 480 },
    });
    frameListener({
      params: {
        data: Buffer.from("frame").toString("base64"),
        sessionId: 7,
        metadata: { timestamp: 1 },
      },
    });
    const stopping = module.stopScreencast();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(recorderStopCalls, 0);
    acceptFrame();
    await stopping;
    assert.equal(recorderStopCalls, 1);
  } finally {
    acceptFrame?.();
    await module.stopScreencast().catch(() => {});
    restore();
  }
});

test("startScreencast preserves a zero CDP frame timestamp", async () => {
  const module = await import("../../dist/src/driver/screencast.js");
  const timestamps = [];
  let frameListener;
  const restore = module.__testing.setOverrides({
    ensureSession: async () => "session-1",
    subscribeBrowserEvent: (_method, _sessionId, listener) => {
      frameListener = listener;
      return () => {};
    },
    now: () => 9000,
    browserCdp: async () => ({ result: {} }),
    createRecorder: () => ({
      async start() {},
      writeFrame(_buffer, timestamp) {
        timestamps.push(timestamp);
      },
      async stop() {},
    }),
  });
  try {
    await module.startScreencast({
      path: "artifacts/run.webm",
      size: { width: 640, height: 480 },
    });

    frameListener({
      params: {
        data: Buffer.from("frame").toString("base64"),
        sessionId: 7,
        metadata: { timestamp: 0 },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(timestamps, [0]);
  } finally {
    await module.stopScreencast();
    restore();
  }
});

test("stopScreencast records a fallback JPEG when Chromium sends no frames", async () => {
  const module = await import("../../dist/src/driver/screencast.js");
  const frames = [];
  const cdpMethods = [];
  const restore = module.__testing.setOverrides({
    ensureSession: async () => "session-1",
    subscribeBrowserEvent: () => () => {},
    now: () => 3000,
    browserCdp: async (method) => {
      cdpMethods.push(method);
      if (method === "Page.captureScreenshot") {
        return {
          result: { data: Buffer.from("fallback").toString("base64") },
        };
      }
      return { result: {} };
    },
    createRecorder: () => ({
      async start() {},
      writeFrame(buffer, timestamp) {
        frames.push({ buffer, timestamp });
      },
      async stop() {},
    }),
  });
  try {
    await module.startScreencast({
      path: "artifacts/run.webm",
      size: { width: 640, height: 480 },
    });

    await module.stopScreencast();

    assert.ok(cdpMethods.includes("Page.captureScreenshot"));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].buffer.toString(), "fallback");
    assert.equal(frames[0].timestamp, 3000);
  } finally {
    await module.stopScreencast();
    restore();
  }
});

test("startScreencast cleans up the encoder when CDP startup fails", async () => {
  const module = await import("../../dist/src/driver/screencast.js");
  let unsubscribeCalls = 0;
  let stopCalls = 0;
  const restore = module.__testing.setOverrides({
    ensureSession: async () => "session-1",
    subscribeBrowserEvent: () => () => {
      unsubscribeCalls += 1;
    },
    browserCdp: async (method) => {
      if (method === "Page.startScreencast") throw new Error("start failed");
      return {
        result: { data: Buffer.from("fallback").toString("base64") },
      };
    },
    createRecorder: () => ({
      async start() {},
      writeFrame() {},
      async stop() {
        stopCalls += 1;
      },
    }),
  });
  try {
    await assert.rejects(
      () =>
        module.startScreencast({
          path: "artifacts/run.webm",
          size: { width: 640, height: 480 },
        }),
      /start failed/,
    );

    assert.equal(unsubscribeCalls, 1);
    assert.equal(stopCalls, 1);
  } finally {
    await module.stopScreencast().catch(() => {});
    restore();
  }
});

test("stopScreencast finalizes the encoder when CDP shutdown fails", async () => {
  const module = await import("../../dist/src/driver/screencast.js");
  let frameListener;
  let unsubscribeCalls = 0;
  let stopCalls = 0;
  const restore = module.__testing.setOverrides({
    ensureSession: async () => "session-1",
    subscribeBrowserEvent: (_method, _sessionId, listener) => {
      frameListener = listener;
      return () => {
        unsubscribeCalls += 1;
      };
    },
    browserCdp: async (method) => {
      if (method === "Page.stopScreencast") throw new Error("stop failed");
      return { result: {} };
    },
    createRecorder: () => ({
      async start() {},
      writeFrame() {},
      async stop() {
        stopCalls += 1;
      },
    }),
  });
  try {
    await module.startScreencast({
      path: "artifacts/run.webm",
      size: { width: 640, height: 480 },
    });
    frameListener({
      params: {
        data: Buffer.from("frame").toString("base64"),
        sessionId: 1,
        metadata: { timestamp: 1 },
      },
    });

    await assert.rejects(() => module.stopScreencast(), /stop failed/);

    assert.equal(unsubscribeCalls, 1);
    assert.equal(stopCalls, 1);
  } finally {
    await module.stopScreencast().catch(() => {});
    restore();
  }
});

test("startScreencast rejects non-WebM output before browser work", async () => {
  const module = await import("../../dist/src/driver/screencast.js");
  let sessionCalls = 0;
  const restore = module.__testing.setOverrides({
    ensureSession: async () => {
      sessionCalls += 1;
      return "session-1";
    },
    subscribeBrowserEvent: () => () => {},
    browserCdp: async () => ({ result: {} }),
    createRecorder: () => ({
      async start() {},
      writeFrame() {},
      async stop() {},
    }),
  });
  try {
    await assert.rejects(
      () =>
        module.startScreencast({
          path: "artifacts/run.mp4",
          size: { width: 640, height: 480 },
        }),
      /path must end with \.webm/,
    );
    assert.equal(sessionCalls, 0);
  } finally {
    await module.stopScreencast().catch(() => {});
    restore();
  }
});

test("startScreencast normalizes requested dimensions for VP8", async () => {
  const module = await import("../../dist/src/driver/screencast.js");
  let recorderOptions;
  let startParams;
  const restore = module.__testing.setOverrides({
    ensureSession: async () => "session-1",
    subscribeBrowserEvent: () => () => {},
    browserCdp: async (method, params) => {
      if (method === "Page.startScreencast") startParams = params;
      if (method === "Page.captureScreenshot") {
        return { result: { data: Buffer.from("fallback").toString("base64") } };
      }
      return { result: {} };
    },
    createRecorder: (options) => {
      recorderOptions = options;
      return {
        async start() {},
        writeFrame() {},
        async stop() {},
      };
    },
  });
  try {
    await module.startScreencast({
      path: "artifacts/run.webm",
      size: { width: 641, height: 481 },
      quality: 80,
    });

    assert.deepEqual(recorderOptions.size, { width: 640, height: 480 });
    assert.equal(startParams.maxWidth, 640);
    assert.equal(startParams.maxHeight, 480);
    assert.equal(startParams.quality, 80);
  } finally {
    await module.stopScreencast();
    restore();
  }
});

test("startScreencast rejects quality outside the CDP range", async () => {
  const module = await import("../../dist/src/driver/screencast.js");
  let sessionCalls = 0;
  const restore = module.__testing.setOverrides({
    ensureSession: async () => {
      sessionCalls += 1;
      return "session-1";
    },
  });
  try {
    await assert.rejects(
      () =>
        module.startScreencast({
          path: "artifacts/run.webm",
          size: { width: 640, height: 480 },
          quality: 101,
        }),
      /quality must be between 0 and 100/,
    );
    assert.equal(sessionCalls, 0);
  } finally {
    await module.stopScreencast().catch(() => {});
    restore();
  }
});

test("startScreencast rejects dimensions too small for VP8", async () => {
  const module = await import("../../dist/src/driver/screencast.js");
  let sessionCalls = 0;
  const restore = module.__testing.setOverrides({
    ensureSession: async () => {
      sessionCalls += 1;
      return "session-1";
    },
    subscribeBrowserEvent: () => () => {},
    browserCdp: async () => ({ result: {} }),
    createRecorder: () => ({
      async start() {},
      writeFrame() {},
      async stop() {},
    }),
  });
  try {
    await assert.rejects(
      () =>
        module.startScreencast({
          path: "artifacts/run.webm",
          size: { width: 1, height: 480 },
        }),
      /width and height must be at least 2 pixels/,
    );
    assert.equal(sessionCalls, 0);
  } finally {
    await module.stopScreencast().catch(() => {});
    restore();
  }
});

test("startScreencast returns a Playwright-style disposable", async () => {
  const module = await import("../../dist/src/driver/screencast.js");
  let stopCalls = 0;
  const restore = module.__testing.setOverrides({
    ensureSession: async () => "session-1",
    subscribeBrowserEvent: () => () => {},
    browserCdp: async (method) => {
      if (method === "Page.captureScreenshot") {
        return { result: { data: Buffer.from("fallback").toString("base64") } };
      }
      return { result: {} };
    },
    createRecorder: () => ({
      async start() {},
      writeFrame() {},
      async stop() {
        stopCalls += 1;
      },
    }),
  });
  try {
    const disposable = await module.startScreencast({
      path: "artifacts/run.webm",
      size: { width: 640, height: 480 },
    });

    assert.equal(typeof disposable, "object");
    assert.equal(typeof disposable.dispose, "function");
    assert.equal(typeof disposable[Symbol.asyncDispose], "function");
    await disposable.dispose();
    assert.equal(stopCalls, 1);
  } finally {
    await module.stopScreencast().catch(() => {});
    restore();
  }
});

test("startScreencast cleans up and can retry when frame subscription fails", async () => {
  const module = await import("../../dist/src/driver/screencast.js");
  let subscriptionAttempts = 0;
  let recorderStopCalls = 0;
  const restore = module.__testing.setOverrides({
    ensureSession: async () => "session-1",
    subscribeBrowserEvent: () => {
      subscriptionAttempts += 1;
      if (subscriptionAttempts === 1) throw new Error("subscribe failed");
      return () => {};
    },
    browserCdp: async (method) => {
      if (method === "Page.captureScreenshot") {
        return { result: { data: Buffer.from("fallback").toString("base64") } };
      }
      return { result: {} };
    },
    createRecorder: () => ({
      async start() {},
      writeFrame() {},
      async stop() {
        recorderStopCalls += 1;
      },
    }),
  });
  try {
    await assert.rejects(
      () =>
        module.startScreencast({
          path: "artifacts/run.webm",
          size: { width: 640, height: 480 },
        }),
      /subscribe failed/,
    );
    assert.equal(recorderStopCalls, 1);

    await module.startScreencast({
      path: "artifacts/retry.webm",
      size: { width: 640, height: 480 },
    });
    await module.stopScreencast();
    assert.equal(subscriptionAttempts, 2);
  } finally {
    await module.stopScreencast().catch(() => {});
    restore();
  }
});

test("stopScreencast surfaces an asynchronous fallback frame failure", async () => {
  const module = await import("../../dist/src/driver/screencast.js");
  let recorderStopCalls = 0;
  const restore = module.__testing.setOverrides({
    ensureSession: async () => "session-1",
    subscribeBrowserEvent: () => () => {},
    browserCdp: async (method) => {
      if (method === "Page.captureScreenshot") {
        return { result: { data: Buffer.from("fallback").toString("base64") } };
      }
      return { result: {} };
    },
    createRecorder: () => ({
      async start() {},
      async writeFrame() {
        throw new Error("fallback frame failed");
      },
      async stop() {
        recorderStopCalls += 1;
      },
    }),
  });
  try {
    await module.startScreencast({
      path: "artifacts/run.webm",
      size: { width: 640, height: 480 },
    });

    await assert.rejects(
      () => module.stopScreencast(),
      /fallback frame failed/,
    );
    assert.equal(recorderStopCalls, 1);
  } finally {
    await module.stopScreencast().catch(() => {});
    restore();
  }
});

test("startScreencast rejects overlapping recordings and stop remains idempotent", async () => {
  const module = await import("../../dist/src/driver/screencast.js");
  let recorderStopCalls = 0;
  const restore = module.__testing.setOverrides({
    ensureSession: async () => "session-1",
    subscribeBrowserEvent: () => () => {},
    browserCdp: async (method) => {
      if (method === "Page.captureScreenshot") {
        return { result: { data: Buffer.from("fallback").toString("base64") } };
      }
      return { result: {} };
    },
    createRecorder: () => ({
      async start() {},
      writeFrame() {},
      async stop() {
        recorderStopCalls += 1;
      },
    }),
  });
  try {
    const recording = await module.startScreencast({
      path: "artifacts/run.webm",
      size: { width: 640, height: 480 },
    });

    await assert.rejects(
      () =>
        module.startScreencast({
          path: "artifacts/overlap.webm",
          size: { width: 640, height: 480 },
        }),
      /already started/,
    );
    await Promise.all([
      module.stopScreencast(),
      module.stopScreencast(),
      recording.dispose(),
    ]);

    assert.equal(recorderStopCalls, 1);
  } finally {
    await module.stopScreencast().catch(() => {});
    restore();
  }
});

test("stopScreencast surfaces an encoder frame failure and still finalizes", async () => {
  const module = await import("../../dist/src/driver/screencast.js");
  let frameListener;
  let recorderStopCalls = 0;
  const restore = module.__testing.setOverrides({
    ensureSession: async () => "session-1",
    subscribeBrowserEvent: (_method, _sessionId, listener) => {
      frameListener = listener;
      return () => {};
    },
    browserCdp: async () => ({ result: {} }),
    createRecorder: () => ({
      async start() {},
      async writeFrame() {
        throw new Error("encoder frame failed");
      },
      async stop() {
        recorderStopCalls += 1;
      },
    }),
  });
  try {
    await module.startScreencast({
      path: "artifacts/run.webm",
      size: { width: 640, height: 480 },
    });
    frameListener({
      params: {
        data: Buffer.from("frame").toString("base64"),
        sessionId: 1,
        metadata: { timestamp: 1 },
      },
    });

    await assert.rejects(() => module.stopScreencast(), /encoder frame failed/);
    assert.equal(recorderStopCalls, 1);
  } finally {
    await module.stopScreencast().catch(() => {});
    restore();
  }
});

test("startScreencast refuses to size a recording while a dialog is open", async () => {
  const module = await import("../../dist/src/driver/screencast.js");
  let recorderCreated = false;
  const restore = module.__testing.setOverrides({
    ensureSession: async () => "session-1",
    pageInfo: async () => ({ dialog: { type: "confirm", message: "ok?" } }),
    subscribeBrowserEvent: () => () => {},
    browserCdp: async () => ({ result: {} }),
    createRecorder: () => {
      recorderCreated = true;
      return { async start() {}, writeFrame() {}, async stop() {} };
    },
  });
  try {
    await assert.rejects(
      () => module.startScreencast({ path: "artifacts/run.webm" }),
      /JavaScript dialog is open.*explicit size/s,
    );
    assert.equal(recorderCreated, false, "no encoder is started");
  } finally {
    await module.stopScreencast().catch(() => {});
    restore();
  }
});

test("startScreencast reports an unusable viewport instead of a 0x0 recording", async () => {
  const module = await import("../../dist/src/driver/screencast.js");
  const restore = module.__testing.setOverrides({
    ensureSession: async () => "session-1",
    pageInfo: async () => ({ w: 0, h: 0 }),
    subscribeBrowserEvent: () => () => {},
    browserCdp: async () => ({ result: {} }),
    createRecorder: () => ({
      async start() {},
      writeFrame() {},
      async stop() {},
    }),
  });
  try {
    await assert.rejects(
      () => module.startScreencast({ path: "artifacts/run.webm" }),
      /could not derive a recordable size.*w: 0, h: 0/s,
    );
  } finally {
    await module.stopScreencast().catch(() => {});
    restore();
  }
});

test("startScreencast rejects a viewport that scales below the encoder minimum", async () => {
  const module = await import("../../dist/src/driver/screencast.js");
  const restore = module.__testing.setOverrides({
    ensureSession: async () => "session-1",
    // Scaling 1000x2 to fit 800 leaves a height of 1, below the 2-pixel floor
    // the explicit-size path already enforces.
    pageInfo: async () => ({ w: 1000, h: 2 }),
    subscribeBrowserEvent: () => () => {},
    browserCdp: async () => ({ result: {} }),
    createRecorder: () => ({
      async start() {},
      writeFrame() {},
      async stop() {},
    }),
  });
  try {
    await assert.rejects(
      () => module.startScreencast({ path: "artifacts/run.webm" }),
      /could not derive a recordable size/,
    );
  } finally {
    await module.stopScreencast().catch(() => {});
    restore();
  }
});
