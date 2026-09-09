import test from "node:test";
import assert from "node:assert/strict";

import {
  browserCdp,
  invalidateSession,
} from "../../dist/src/browser-runtime.js";
import { ElementResolutionError } from "../../dist/src/element-resolver.js";
import { setOverrides } from "../../dist/src/state.js";
import { helperContext } from "../../dist/src/helpers.js";
import {
  expectHidden,
  expectText,
  expectUrl,
  expectValue,
  expectVisible,
  isTransientError,
  retryOnTransient,
} from "../../dist/src/driver/expect.js";

function withCdpRuntime(fn) {
  const previous = globalThis.ego;
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
      let result = {};
      if (request.method === "Target.attachToTarget") {
        result = { sessionId: "session-1" };
      } else if (request.method === "Runtime.evaluate") {
        result = {
          result: {
            value: JSON.stringify({
              url: "https://example.com/",
              title: "Example",
              w: 800,
              h: 600,
              sx: 0,
              sy: 0,
              pw: 800,
              ph: 1200,
            }),
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
    .then(() => fn({ runtime }))
    .finally(() => {
      invalidateSession();
      if (previous === undefined) {
        delete globalThis.ego;
      } else {
        globalThis.ego = previous;
      }
    });
}

test("isTransientError classifies ElementResolutionError and message patterns", () => {
  assert.equal(
    isTransientError(
      new ElementResolutionError("Unknown ref: 12", "transient"),
    ),
    true,
  );
  assert.equal(
    isTransientError(
      new ElementResolutionError("matched 2 elements", "permanent"),
    ),
    false,
  );
  assert.equal(
    isTransientError(new Error("Locator foo matched 0 elements")),
    true,
  );
  assert.equal(isTransientError(new Error("Element not ready yet")), true);
  assert.equal(isTransientError(new Error("Invalid selector")), false);
  assert.equal(isTransientError("not an error"), false);
});

test("retryOnTransient retries transient errors then succeeds", async () => {
  let attempts = 0;
  const sleeps = [];
  const restore = setOverrides({
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  try {
    const result = await retryOnTransient(
      () => {
        attempts += 1;
        if (attempts < 3) {
          throw new ElementResolutionError("Unknown ref: 5", "transient");
        }
        return "done";
      },
      { attempts: 5, interval: 0.2 },
    );
    assert.equal(result, "done");
    assert.equal(attempts, 3);
    assert.deepEqual(sleeps, [200, 200]);
  } finally {
    restore();
  }
});

test("retryOnTransient rethrows permanent errors immediately", async () => {
  let attempts = 0;
  const restore = setOverrides({
    sleep: async () => {
      throw new Error("sleep should not run");
    },
  });
  try {
    await assert.rejects(
      () =>
        retryOnTransient(() => {
          attempts += 1;
          throw new ElementResolutionError("matched 2 elements", "permanent");
        }),
      (error) => {
        assert.ok(error instanceof ElementResolutionError);
        assert.equal(error.kind, "permanent");
        return true;
      },
    );
    assert.equal(attempts, 1);
  } finally {
    restore();
  }
});

test("retryOnTransient exhausts attempts and rethrows last transient error", async () => {
  const restore = setOverrides({
    sleep: async () => {},
  });
  try {
    await assert.rejects(
      () =>
        retryOnTransient(
          () => {
            throw new Error("matched 0 elements");
          },
          { attempts: 2, interval: 0.1 },
        ),
      /matched 0 elements/,
    );
  } finally {
    restore();
  }
});

test("expectVisible returns ok:true when element is visible", async () => {
  const restore = setOverrides({
    cdpOverride(method) {
      if (method === "Runtime.evaluate") {
        return { result: { objectId: "node-1" } };
      }
      if (method === "Runtime.callFunctionOn") {
        return { result: { value: true } };
      }
      return {};
    },
  });
  try {
    assert.deepEqual(await expectVisible("#banner"), { ok: true });
  } finally {
    restore();
  }
});

test("expectVisible returns ok:false when element is not visible", async () => {
  const restore = setOverrides({
    cdpOverride(method) {
      if (method === "Runtime.evaluate") {
        return { result: { objectId: "node-1" } };
      }
      if (method === "Runtime.callFunctionOn") {
        return { result: { value: false } };
      }
      return {};
    },
  });
  try {
    const result = await expectVisible("#banner");
    assert.equal(result.ok, false);
    assert.match(result.detail, /not visible/);
    assert.equal(result.actual, false);
    assert.equal(result.expected, true);
  } finally {
    restore();
  }
});

test("expectHidden returns ok:false on permanent resolution failure without throwing", async () => {
  const restore = setOverrides({
    cdpOverride(method) {
      if (method === "Runtime.evaluate") {
        return {
          exceptionDetails: {
            exception: {
              description: "Error: Locator #dup matched 2 elements",
            },
          },
        };
      }
      return {};
    },
  });
  try {
    const result = await expectHidden("#dup");
    assert.equal(result.ok, false);
    assert.match(result.detail, /expectHidden failed/);
  } finally {
    restore();
  }
});

test("expectText returns mismatch details", async () => {
  const restore = setOverrides({
    cdpOverride(method) {
      if (method === "Runtime.evaluate") {
        return { result: { objectId: "node-1" } };
      }
      if (method === "Runtime.callFunctionOn") {
        return { result: { value: "Hello" } };
      }
      return {};
    },
  });
  try {
    const result = await expectText("h1", "Goodbye");
    assert.equal(result.ok, false);
    assert.equal(result.actual, "Hello");
    assert.equal(result.expected, "Goodbye");
    assert.match(result.detail, /text mismatch/);
  } finally {
    restore();
  }
});

test("expectUrl returns ok:false when pageInfo reports a dialog", async () => {
  await withCdpRuntime(async ({ runtime }) => {
    await browserCdp("Runtime.evaluate", { expression: "document.title" });
    runtime.emit("Page.javascriptDialogOpening", {
      type: "alert",
      message: "Blocked",
      url: "https://example.com/",
    });

    const result = await expectUrl(/example/);
    assert.equal(result.ok, false);
    assert.match(result.detail, /JavaScript dialog/);
    assert.deepEqual(result.expected, /example/);
  });
});

test("expectUrl matches string and RegExp URLs", async () => {
  const pagePayload = {
    url: "https://example.com/checkout?x=1",
    title: "Checkout",
    w: 100,
    h: 100,
    sx: 0,
    sy: 0,
    pw: 100,
    ph: 100,
  };
  const restore = setOverrides({
    cdpOverride(method, params) {
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: JSON.stringify(pagePayload),
          },
        };
      }
      return {};
    },
  });
  try {
    assert.deepEqual(await expectUrl("https://example.com/checkout?x=1"), {
      ok: true,
      actual: "https://example.com/checkout?x=1",
      expected: "https://example.com/checkout?x=1",
    });
    assert.equal((await expectUrl(/\/checkout/)).ok, true);
    const mismatch = await expectUrl("https://other.test");
    assert.equal(mismatch.ok, false);
    assert.match(mismatch.detail, /URL mismatch/);
  } finally {
    restore();
  }
});

test("expectValue returns ok:true on match", async () => {
  const restore = setOverrides({
    cdpOverride(method) {
      if (method === "Runtime.evaluate") {
        return { result: { objectId: "node-1" } };
      }
      if (method === "Runtime.callFunctionOn") {
        return { result: { value: "agent@example.com" } };
      }
      return {};
    },
  });
  try {
    assert.deepEqual(await expectValue("#email", "agent@example.com"), {
      ok: true,
      actual: "agent@example.com",
      expected: "agent@example.com",
    });
  } finally {
    restore();
  }
});

test("page facade exposes retry and soft expect helpers", () => {
  const { page } = helperContext();
  assert.equal(typeof page.retryOnTransient, "function");
  assert.equal(typeof page.expectVisible, "function");
  assert.equal(typeof page.expectHidden, "function");
  assert.equal(typeof page.expectText, "function");
  assert.equal(typeof page.expectUrl, "function");
  assert.equal(typeof page.expectValue, "function");
});
