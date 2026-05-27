import assert from "node:assert/strict";
import test from "node:test";

import { cdpAvailable, send, setOverrides, state } from "../dist/src/state.js";

test("setOverrides restores state after mutation", async () => {
  const restore = setOverrides({
    send: async () => ({ ok: true }),
    cdpOverride: async () => ({ result: { value: 1 } }),
    platform: "test-platform"
  });

  try {
    assert.equal(state.platform, "test-platform");
    assert.equal(cdpAvailable(), true);
    await assert.doesNotReject(() => send({ method: "Runtime.evaluate" }));
  } finally {
    restore();
  }

  assert.equal(state.platform, process.platform);
  assert.equal(state.cdpOverride, null);
});

test("cdpAvailable follows explicit override or custom send", async () => {
  const restore = setOverrides({
    cdpOverride: null,
    send: async () => ({ result: {} })
  });

  try {
    assert.equal(cdpAvailable(), true);
  } finally {
    restore();
  }

  assert.equal(cdpAvailable(), false);
});
