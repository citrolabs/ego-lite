import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createCursorApi } from "../src/cursor.mjs";

/** Records what the cursor asks of CDP, and hands back the shim event hooks. */
function fakeCdp() {
  const calls = [];
  const events = new Map();
  const claimed = [];
  return {
    calls,
    events,
    claimed,
    attachedHint: () => "target-1",
    onShimEvent(method, handler) {
      events.set(method, handler);
    },
    claimSession(sessionId) {
      claimed.push(sessionId);
    },
    async call(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === "Target.attachToTarget") return { sessionId: "session-1" };
      return {};
    },
  };
}

/** The payload each render carries, pulled back out of the injected expression. */
function renderedPayloads(cdp) {
  return cdp.calls
    .filter((call) => call.method === "Runtime.evaluate")
    .map((call) => {
      const source = call.params.expression;
      const json = source.slice(source.lastIndexOf(")(") + 2, -1);
      return JSON.parse(json);
    });
}

const listTabs = async () => ({
  tabs: [{ targetId: "target-1", active: true }],
});

describe("the cursor survives a navigation", () => {
  it("subscribes to loads, and redraws when one fires", async () => {
    const cdp = fakeCdp();
    const cursor = createCursorApi(cdp, { listTabs });

    assert.ok(
      cdp.events.has("Page.loadEventFired"),
      "a load handler is registered up front",
    );

    await cursor.watchPage();
    assert.deepEqual(cdp.claimed, ["session-1"], "the session is claimed");
    assert.ok(
      cdp.calls.some((c) => c.method === "Page.enable"),
      "and Page is enabled, or the load event never arrives",
    );

    const before = renderedPayloads(cdp).length;
    // A navigation replaces the document the overlay lives in. This is the
    // event that has to put it back.
    cdp.events.get("Page.loadEventFired")();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const drawn = renderedPayloads(cdp);
    assert.ok(drawn.length > before, "the load triggers a render");

    const last = drawn[drawn.length - 1];
    assert.equal(last.visible, true, "and the overlay is visible");
    assert.equal(
      last.placed,
      true,
      "placed, so an untouched page still shows the cursor",
    );
    assert.equal(last.read, null, "any read from the old document is dropped");
  });

  it("claims each session once, however many renders happen", async () => {
    const cdp = fakeCdp();
    const cursor = createCursorApi(cdp, { listTabs });

    await cursor.watchPage();
    await cursor.watchPage();
    cursor.moveTo(10, 10);
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.deepEqual(cdp.claimed, ["session-1"]);
    assert.equal(
      cdp.calls.filter((c) => c.method === "Page.enable").length,
      1,
      "Page.enable is not re-sent on every render",
    );
  });
});
