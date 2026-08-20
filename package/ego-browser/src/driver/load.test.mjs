import test from "node:test";
import assert from "node:assert/strict";

import { setOverrides } from "../../dist/src/state.js";
import { waitForDocumentLoad } from "../../dist/src/driver/load.js";

function committedTree(url = "https://example.com/app") {
  return { frameTree: { frame: { url } } };
}

test("waitForDocumentLoad keeps polling when Runtime.evaluate throws transiently", async () => {
  let evalCalls = 0;
  let t = 0;
  const restore = setOverrides({
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    cdpOverride: async (method) => {
      if (method === "Page.getFrameTree") return committedTree();
      if (method === "Runtime.evaluate") {
        evalCalls += 1;
        // The execution context is torn down while a navigation commits.
        if (evalCalls === 1) {
          throw new Error("Execution context was destroyed.");
        }
        return { result: { value: "complete" } };
      }
      return {};
    },
  });
  try {
    const settled = await waitForDocumentLoad({ timeout: 5000 });
    assert.equal(settled, true, "must settle after the transient eval error");
    assert.ok(evalCalls >= 2, "must retry past the transient error");
  } finally {
    restore();
  }
});

test("waitForDocumentLoad times out to false (does not throw) when evaluate keeps failing", async () => {
  let t = 0;
  const restore = setOverrides({
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    cdpOverride: async (method) => {
      if (method === "Page.getFrameTree") return committedTree();
      if (method === "Runtime.evaluate") {
        throw new Error("Cannot find context with specified id");
      }
      return {};
    },
  });
  try {
    const settled = await waitForDocumentLoad({ timeout: 900 });
    assert.equal(
      settled,
      false,
      "a persistent eval failure must time out to false, not reject",
    );
  } finally {
    restore();
  }
});

test("waitForDocumentLoad resolves true once the frame is committed and complete", async () => {
  let t = 0;
  const restore = setOverrides({
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    cdpOverride: async (method) => {
      if (method === "Page.getFrameTree") return committedTree();
      if (method === "Runtime.evaluate")
        return { result: { value: "complete" } };
      return {};
    },
  });
  try {
    assert.equal(await waitForDocumentLoad({ timeout: 5000 }), true);
  } finally {
    restore();
  }
});
