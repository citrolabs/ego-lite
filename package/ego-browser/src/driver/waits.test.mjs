import test from "node:test";
import assert from "node:assert/strict";

import { setOverrides } from "../../dist/src/state.js";
import { cdp } from "../../dist/src/cdp-eval.js";
import { waitForNetworkIdle } from "../../dist/src/driver/waits.js";

test("waitForNetworkIdle enables the Network domain and disables it afterwards", async () => {
  // Regression: nothing used to enable the Network domain, so the helper could
  // report "idle" without ever being able to observe traffic.
  const methods = [];
  let t = 0;
  const restore = setOverrides({
    cdpOverride: async (method) => {
      methods.push(method);
      return {};
    },
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    }
  });
  try {
    const result = await waitForNetworkIdle({ timeout: 5 });
    assert.equal(result, true, "no traffic for idleMs resolves true");
  } finally {
    restore();
  }
  assert.equal(methods[0], "Network.enable", "must enable Network before observing");
  assert.equal(methods.at(-1), "Network.disable", "must disable Network when done");
});

test("waitForNetworkIdle leaves a caller-enabled Network domain enabled", async () => {
  const methods = [];
  let t = 0;
  const restore = setOverrides({
    cdpOverride: async (method) => {
      methods.push(method);
      return {};
    },
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    }
  });
  try {
    await cdp("Network.enable"); // the caller owns the domain
    methods.length = 0;
    const result = await waitForNetworkIdle({ timeout: 5 });
    assert.equal(result, true);
  } finally {
    restore();
  }
  assert.ok(
    !methods.includes("Network.disable"),
    "must not tear down a Network domain the caller enabled"
  );
});

test("waitForNetworkIdle survives a bridge that rejects Network.enable", async () => {
  let t = 0;
  const restore = setOverrides({
    cdpOverride: async (method) => {
      if (method === "Network.enable" || method === "Network.disable") {
        throw new Error("'Network.enable' wasn't found");
      }
      return {};
    },
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    }
  });
  try {
    const result = await waitForNetworkIdle({ timeout: 5 });
    assert.equal(result, true, "falls back to passive observation");
  } finally {
    restore();
  }
});
