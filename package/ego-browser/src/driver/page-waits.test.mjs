import test from "node:test";
import assert from "node:assert/strict";

import {
  waitForLoadStateInPage,
  waitForSelectorInPage,
  waitForURLInPage,
} from "../../dist/src/driver/page-waits.js";

test("waitForSelectorInPage refreshes iframe sessions while it polls", async () => {
  let now = 0;
  let discoveries = 0;
  const services = {
    async cdp(method, _params, sessionId) {
      if (method === "Runtime.evaluate") {
        return sessionId === "session:frame-current"
          ? { result: { objectId: "object:ready" } }
          : { result: { type: "undefined" } };
      }
      if (method === "Runtime.callFunctionOn") {
        return { result: { value: true } };
      }
      if (method === "Runtime.releaseObject") return {};
      throw new Error(`unexpected CDP method: ${method}`);
    },
    now: () => now,
    async sleep(ms) {
      now += ms;
    },
  };
  const getIframeSessions = async () => {
    discoveries += 1;
    return discoveries === 1
      ? new Map()
      : new Map([["frame-current", "session:frame-current"]]);
  };

  assert.equal(
    await waitForSelectorInPage(
      services,
      "session:page",
      new Map(),
      "#ready",
      { state: "visible", timeout: 2_000 },
      getIframeSessions,
    ),
    true,
  );
  assert.equal(discoveries, 2);
});

test("waitForSelectorInPage retries when a discovered iframe disappears during resolution", async () => {
  let now = 0;
  let discoveries = 0;
  const services = {
    async cdp(method, _params, sessionId) {
      if (
        method === "Runtime.evaluate" &&
        sessionId === "session:frame-stale"
      ) {
        throw new Error("Frame with the given frameId is not found.");
      }
      if (method === "Runtime.evaluate") {
        return sessionId === "session:frame-current"
          ? { result: { objectId: "object:ready" } }
          : { result: { type: "undefined" } };
      }
      if (method === "Runtime.callFunctionOn") {
        return { result: { value: true } };
      }
      if (method === "Runtime.releaseObject") return {};
      throw new Error(`unexpected CDP method: ${method}`);
    },
    now: () => now,
    async sleep(ms) {
      now += ms;
    },
  };
  const getIframeSessions = async () => {
    discoveries += 1;
    return discoveries === 1
      ? new Map([["frame-stale", "session:frame-stale"]])
      : new Map([["frame-current", "session:frame-current"]]);
  };

  assert.equal(
    await waitForSelectorInPage(
      services,
      "session:page",
      new Map(),
      "#ready",
      { state: "visible", timeout: 500 },
      getIframeSessions,
    ),
    true,
  );
  assert.equal(discoveries, 2);
});

test("waitForSelectorInPage rethrows a lost page session instead of reporting hidden", async () => {
  let now = 0;
  const services = {
    async cdp() {
      throw new Error("Target closed");
    },
    now: () => now,
    async sleep(ms) {
      now += ms;
    },
  };

  await assert.rejects(
    () =>
      waitForSelectorInPage(
        services,
        "session:page",
        new Map(),
        "#spinner",
        { state: "hidden", timeout: 500 },
        async () => new Map(),
      ),
    /Target closed/,
  );
});

test("waitForSelectorInPage reports its own timeout at the deadline", async () => {
  let now = 0;
  const discoveryTimeouts = [];
  const services = {
    async cdp(method) {
      if (method === "Runtime.evaluate")
        return { result: { type: "undefined" } };
      throw new Error(`unexpected CDP method: ${method}`);
    },
    now: () => now,
    async sleep(ms) {
      now += ms;
    },
  };
  const getIframeSessions = async (timeoutMs) => {
    discoveryTimeouts.push(timeoutMs);
    if (timeoutMs < 250) {
      const error = new Error("CDP request timed out: Target.getTargets");
      error.code = "EGO_CDP_REQUEST_TIMEOUT";
      throw error;
    }
    return new Map();
  };

  await assert.rejects(
    () =>
      waitForSelectorInPage(
        services,
        "session:page",
        new Map(),
        "#missing",
        { state: "visible", timeout: 500 },
        getIframeSessions,
      ),
    /page\.waitForSelector timed out after 500ms: #missing/,
  );
  assert(
    discoveryTimeouts.every((timeoutMs) => timeoutMs <= 500),
    `frame discovery must never exceed the public timeout: ${discoveryTimeouts}`,
  );
});

test("waitForSelectorInPage throttles iframe discovery while polling", async () => {
  let now = 0;
  let discoveries = 0;
  const services = {
    async cdp(method) {
      if (method === "Runtime.evaluate")
        return { result: { type: "undefined" } };
      throw new Error(`unexpected CDP method: ${method}`);
    },
    now: () => now,
    async sleep(ms) {
      now += ms;
    },
  };

  await assert.rejects(
    () =>
      waitForSelectorInPage(
        services,
        "session:page",
        new Map(),
        "#missing",
        { state: "visible", timeout: 2_000 },
        async () => {
          discoveries += 1;
          return new Map();
        },
      ),
    /timed out/,
  );
  assert(
    discoveries <= 5,
    `expected at most one discovery per 500ms over 2s, got ${discoveries}`,
  );
});

test("waitForURLInPage recovers from a transient execution-context change", async () => {
  let now = 0;
  let attempt = 0;
  const calls = [];
  const services = {
    async cdp(method, params, sessionId, timeoutMs) {
      calls.push([method, params, sessionId, timeoutMs]);
      attempt += 1;
      if (attempt === 1) {
        throw new Error("Execution context was destroyed");
      }
      return {
        result: {
          value:
            attempt === 2
              ? "https://example.test/loading"
              : "https://example.test/ready",
        },
      };
    },
    now: () => now,
    async sleep(ms) {
      now += ms;
    },
  };

  await waitForURLInPage(services, "session:page", /\/ready$/g, {
    timeout: 500,
  });

  assert.equal(attempt, 3);
  assert(
    calls.every(
      ([method, , sessionId, timeoutMs]) =>
        method === "Runtime.evaluate" &&
        sessionId === "session:page" &&
        timeoutMs > 0 &&
        timeoutMs <= 500,
    ),
  );
});

test("waitForURLInPage supports Playwright-style URL globs", async () => {
  let now = 0;
  let attempt = 0;
  const services = {
    async cdp() {
      attempt += 1;
      return {
        result: {
          value:
            attempt === 1
              ? "https://example.test/releases/draft/nested/item?channel=canary"
              : "https://example.test/releases/ready/item?channel=stable",
        },
      };
    },
    now: () => now,
    async sleep(ms) {
      now += ms;
    },
  };

  await waitForURLInPage(
    services,
    "session:page",
    "**/releases/{draft,ready}/*?channel=*",
    { timeout: 500 },
  );

  assert.equal(attempt, 2, "a single star must not cross a path separator");
});

test("waitForURLInPage passes a URL object to a synchronous predicate", async () => {
  let now = 0;
  let attempt = 0;
  const seen = [];
  const services = {
    async cdp() {
      attempt += 1;
      return {
        result: {
          value: `https://example.test/jobs?id=${attempt === 1 ? 41 : 42}`,
        },
      };
    },
    now: () => now,
    async sleep(ms) {
      now += ms;
    },
  };

  await waitForURLInPage(
    services,
    "session:page",
    (url) => {
      assert(url instanceof URL);
      seen.push(url.href);
      return url.searchParams.get("id") === "42";
    },
    { timeout: 500 },
  );

  assert.deepEqual(seen, [
    "https://example.test/jobs?id=41",
    "https://example.test/jobs?id=42",
  ]);
});

test("document load waits do not sleep past the budget after a slow probe", async () => {
  let now = 0;
  let calls = 0;
  const services = {
    async cdp(_method, _params, _sessionId, timeoutMs) {
      calls += 1;
      if (calls === 1) {
        assert.equal(timeoutMs, 100);
        now = 99;
      } else {
        assert.equal(timeoutMs, 1);
      }
      return { result: { value: "loading" } };
    },
    now: () => now,
    async sleep(ms) {
      now += ms;
    },
  };

  await assert.rejects(
    () =>
      waitForLoadStateInPage(services, "session:page", "load", {
        timeout: 100,
      }),
    /page\.waitForLoadState\(load\) timed out after 100ms/,
  );

  assert.equal(now, 100);
});

test("network-idle discovery stays within the Page wait timeout", async () => {
  let discoveryTimeout;
  const services = {
    async pageNetworkSessions(sessionId, timeoutMs) {
      assert.equal(sessionId, "session:page");
      discoveryTimeout = timeoutMs;
      return [sessionId];
    },
    async ensureNetworkTracking() {},
    networkActivity() {
      return { tracking: true, inflight: 0, lastActivityAt: -1_000 };
    },
    now: () => 0,
    async sleep() {},
  };

  await waitForLoadStateInPage(services, "session:page", "networkidle", {
    timeout: 123,
    idleMs: 10,
  });

  assert.equal(discoveryTimeout, 123);
});

test("network-idle gives tracking only the budget left after discovery", async () => {
  let now = 0;
  let trackingTimeout;
  const services = {
    async pageNetworkSessions(_sessionId, timeoutMs) {
      assert.equal(timeoutMs, 100);
      now = 90;
      return ["session:page"];
    },
    async ensureNetworkTracking(_sessionIds, timeoutMs) {
      trackingTimeout = timeoutMs;
    },
    networkActivity() {
      return { tracking: true, inflight: 0, lastActivityAt: -1_000 };
    },
    now: () => now,
    async sleep() {},
  };

  await waitForLoadStateInPage(services, "session:page", "networkidle", {
    timeout: 100,
    idleMs: 10,
  });

  assert.equal(trackingTimeout, 10);
});

test("network-idle reports its public timeout when discovery exhausts the budget", async () => {
  let now = 0;
  const services = {
    async pageNetworkSessions() {
      now = 50;
      const error = new Error("CDP request timed out: Page.getFrameTree");
      error.code = "EGO_CDP_REQUEST_TIMEOUT";
      throw error;
    },
    async ensureNetworkTracking() {},
    networkActivity() {
      throw new Error(
        "network activity must not be read after discovery fails",
      );
    },
    now: () => now,
    async sleep() {},
  };

  await assert.rejects(
    () =>
      waitForLoadStateInPage(services, "session:page", "networkidle", {
        timeout: 50,
        idleMs: 10,
      }),
    /page\.waitForLoadState\(networkidle\) timed out after 50ms/,
  );
});
