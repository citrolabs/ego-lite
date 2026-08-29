import test from "node:test";
import assert from "node:assert/strict";

import {
  waitForLoadStateInPage,
  waitForURLInPage,
} from "../../dist/src/driver/page-waits.js";

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
