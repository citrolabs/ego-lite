import test from "node:test";
import assert from "node:assert/strict";

import { setOverrides, state } from "../../dist/src/state.js";
import { cdp } from "../../dist/src/cdp-eval.js";
import {
  clearPreferredTarget,
  drainBrowserEvents,
  invalidateSession,
} from "../../dist/src/browser-runtime.js";
import {
  waitForFunction,
  waitForLoadState,
  waitForRequest,
  waitForResponse,
  waitForURL,
} from "../../dist/src/driver/waits.js";

function installAutoEgo(resultFor = () => ({})) {
  const calls = [];
  globalThis.ego = {
    async listTabs() {
      return { tabs: [{ targetId: "tab-1", active: true }] };
    },
    sendCDPMessage(payload) {
      const parsed = JSON.parse(payload);
      calls.push(parsed);
      setTimeout(() => {
        if (!globalThis.ego?.onCDPMessage) return;
        const outcome =
          parsed.method === "Target.attachToTarget"
            ? { sessionId: `auto-sess-${parsed.id}` }
            : resultFor(parsed);
        const message =
          outcome && Object.prototype.hasOwnProperty.call(outcome, "error")
            ? { id: parsed.id, error: outcome.error }
            : { id: parsed.id, result: outcome || {} };
        globalThis.ego.onCDPMessage(JSON.stringify(message));
      }, 0);
    },
  };
  return calls;
}

function fireEvent(method, params = {}, sessionId = state.sessionId) {
  globalThis.ego.onCDPMessage(
    JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }),
  );
}

function cleanupBrowserRuntime() {
  delete globalThis.ego;
  invalidateSession();
  clearPreferredTarget();
  drainBrowserEvents();
  state.networkDomainEnabled = false;
}

test("waitForFunction polls until a page function returns a truthy value", async () => {
  let t = 0;
  const values = [false, "ready"];
  const sleeps = [];
  const expressions = [];
  const restore = setOverrides({
    cdpOverride: async (method, params) => {
      assert.equal(method, "Runtime.evaluate");
      expressions.push(params.expression);
      return { result: { value: values.shift() } };
    },
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  });
  try {
    const result = await waitForFunction(
      (expected) => window.status === expected,
      "done",
      { timeout: 500, polling: 50 },
    );
    assert.equal(result, "ready");
  } finally {
    restore();
  }
  assert.deepEqual(sleeps, [50]);
  assert.match(expressions[0], /window\.status === expected/);
  assert.match(expressions[0], /\("done"\)$/);
});

test("waitForURL supports Playwright-style glob strings", async () => {
  let t = 0;
  const urls = ["https://example.com/start", "https://example.com/path/target"];
  const sleeps = [];
  const restore = setOverrides({
    cdpOverride: async (method, params) => {
      assert.equal(method, "Runtime.evaluate");
      assert.equal(params.expression, "location.href");
      return { result: { value: urls.shift() || urls.at(-1) } };
    },
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  });
  try {
    assert.equal(
      await waitForURL("**/target", {
        timeout: 500,
        waitUntil: "commit",
      }),
      true,
    );
  } finally {
    restore();
  }
  assert.deepEqual(sleeps, [100]);
});

test("waitForURL predicates receive URL objects and wait for load by default", async () => {
  const calls = [];
  let observedUrl;
  const restore = setOverrides({
    cdpOverride: async (method, params) => {
      calls.push({ method, params });
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            frame: { url: "https://example.com/target" },
          },
        };
      }
      if (method === "Runtime.evaluate") {
        if (params.expression === "location.href") {
          return {
            result: { value: "https://example.com/target" },
          };
        }
        if (params.expression === "document.readyState") {
          return { result: { value: "complete" } };
        }
      }
      throw new Error(`unexpected CDP call: ${method}`);
    },
  });
  try {
    assert.equal(
      await waitForURL((url) => {
        observedUrl = url;
        return url.pathname === "/target";
      }),
      true,
    );
  } finally {
    restore();
  }

  assert(observedUrl instanceof URL);
  assert.equal(observedUrl.href, "https://example.com/target");
  assert.ok(
    calls.some(
      ({ method, params }) =>
        method === "Runtime.evaluate" &&
        params.expression === "document.readyState",
    ),
    "default waitForURL waits for the load state after the URL matches",
  );
});

test("waitForURL waitUntil commit returns without waiting for load", async () => {
  const calls = [];
  const restore = setOverrides({
    cdpOverride: async (method, params) => {
      calls.push({ method, params });
      return { result: { value: "https://example.com/target" } };
    },
  });
  try {
    assert.equal(
      await waitForURL("https://example.com/target", {
        waitUntil: "commit",
      }),
      true,
    );
  } finally {
    restore();
  }

  assert.equal(
    calls.some(({ method }) => method === "Page.getFrameTree"),
    false,
  );
});

test("waitForURL resolves a matched about:blank without waiting for load", async () => {
  const calls = [];
  const restore = setOverrides({
    cdpOverride: async (method, params) => {
      calls.push({ method, params });
      return { result: { value: "about:blank" } };
    },
  });
  try {
    assert.equal(await waitForURL("about:blank"), true);
  } finally {
    restore();
  }

  assert.equal(
    calls.some(({ method }) => method === "Page.getFrameTree"),
    false,
  );
});

test("waitForURL preserves networkidle for a matched about:blank", async () => {
  const methods = [];
  let t = 0;
  const restore = setOverrides({
    cdpOverride: async (method, params) => {
      methods.push(method);
      if (
        method === "Runtime.evaluate" &&
        params.expression === "location.href"
      ) {
        return { result: { value: "about:blank" } };
      }
      return {};
    },
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  });
  try {
    assert.equal(
      await waitForURL("about:blank", {
        timeout: 5000,
        waitUntil: "networkidle",
      }),
      true,
    );
  } finally {
    restore();
  }

  assert.ok(methods.includes("Network.enable"));
  assert.ok(methods.includes("Network.disable"));
  assert.ok(t >= 500, "networkidle observes its default idle window");
});

test("waitForRequest matches exact URL and returns a request facade", async () => {
  const calls = installAutoEgo();
  try {
    const promise = waitForRequest("https://example.com/api/search", {
      timeout: 1000,
    });
    setTimeout(() => {
      fireEvent("Network.requestWillBeSent", {
        requestId: "req-1",
        type: "XHR",
        request: {
          url: "https://example.com/api/search",
          method: "POST",
          headers: { "Content-Type": "application/json" },
          postData: '{"q":"test"}',
        },
      });
    }, 20);
    const request = await promise;
    assert.equal(request.url(), "https://example.com/api/search");
    assert.equal(request.method(), "POST");
    assert.equal(request.headers()["content-type"], "application/json");
    assert.equal(request.postData(), '{"q":"test"}');
    assert.equal(request.resourceType(), "xhr");
  } finally {
    cleanupBrowserRuntime();
  }
  assert.ok(calls.some((call) => call.method === "Network.enable"));
  assert.ok(calls.some((call) => call.method === "Network.disable"));
});

test("waitForRequest ignores matching events from other CDP sessions", async () => {
  installAutoEgo();
  try {
    const promise = waitForRequest("https://example.com/api/session", {
      timeout: 1000,
    });
    setTimeout(() => {
      fireEvent(
        "Network.requestWillBeSent",
        {
          requestId: "shared-request-id",
          type: "XHR",
          request: {
            url: "https://example.com/api/session",
            method: "POST",
            headers: {},
          },
        },
        "other-session",
      );
      fireEvent("Network.requestWillBeSent", {
        requestId: "shared-request-id",
        type: "XHR",
        request: {
          url: "https://example.com/api/session",
          method: "GET",
          headers: {},
        },
      });
    }, 20);
    const request = await promise;
    assert.equal(request.method(), "GET");
  } finally {
    cleanupBrowserRuntime();
  }
});

test("waitForResponse matches regex and exposes response body helpers", async () => {
  installAutoEgo((call) => {
    if (call.method === "Network.getResponseBody") {
      return { body: '{"ok":true}', base64Encoded: false };
    }
    return {};
  });
  try {
    const promise = waitForResponse(/\/api\/items$/, { timeout: 1000 });
    setTimeout(() => {
      fireEvent("Network.requestWillBeSent", {
        requestId: "req-2",
        type: "Fetch",
        request: {
          url: "https://example.com/api/items",
          method: "GET",
          headers: { Accept: "application/json" },
        },
      });
      fireEvent("Network.responseReceived", {
        requestId: "req-2",
        type: "Fetch",
        response: {
          url: "https://example.com/api/items",
          status: 200,
          statusText: "OK",
          headers: { "Content-Type": "application/json" },
        },
      });
    }, 20);
    const response = await promise;
    assert.equal(response.url(), "https://example.com/api/items");
    assert.equal(response.status(), 200);
    assert.equal(response.statusText(), "OK");
    assert.equal(response.ok(), true);
    assert.equal(response.headers()["content-type"], "application/json");
    assert.equal(response.request().method(), "GET");
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(await response.text(), '{"ok":true}');
  } finally {
    cleanupBrowserRuntime();
  }
});

test("waitForResponse ignores matching events from other CDP sessions", async () => {
  installAutoEgo();
  try {
    const promise = waitForResponse(/\/api\/session$/, { timeout: 1000 });
    setTimeout(() => {
      fireEvent(
        "Network.responseReceived",
        {
          requestId: "shared-response-id",
          response: {
            url: "https://example.com/api/session",
            status: 500,
          },
        },
        "other-session",
      );
      fireEvent("Network.responseReceived", {
        requestId: "shared-response-id",
        response: {
          url: "https://example.com/api/session",
          status: 200,
        },
      });
    }, 20);
    const response = await promise;
    assert.equal(response.status(), 200);
  } finally {
    cleanupBrowserRuntime();
  }
});

test("waitForResponse supports synchronous response predicates", async () => {
  installAutoEgo();
  try {
    const promise = waitForResponse(
      (response) =>
        response.url().includes("/api/create") &&
        response.status() === 201 &&
        response.request().method() === "POST",
      { timeout: 1000 },
    );
    setTimeout(() => {
      fireEvent("Network.requestWillBeSent", {
        requestId: "req-3",
        type: "XHR",
        request: {
          url: "https://example.com/api/create",
          method: "POST",
          headers: {},
        },
      });
      fireEvent("Network.responseReceived", {
        requestId: "req-3",
        type: "XHR",
        response: {
          url: "https://example.com/api/create",
          status: 201,
          statusText: "Created",
          headers: {},
        },
      });
    }, 20);
    const response = await promise;
    assert.equal(response.status(), 201);
  } finally {
    cleanupBrowserRuntime();
  }
});

test("waitForRequest rejects on timeout", async () => {
  installAutoEgo();
  try {
    await assert.rejects(
      () => waitForRequest(/never-matches/, { timeout: 20 }),
      /page\.waitForRequest timed out after 20ms/,
    );
  } finally {
    cleanupBrowserRuntime();
  }
});

test("waitForResponse rejects on timeout", async () => {
  installAutoEgo();
  try {
    await assert.rejects(
      () => waitForResponse(/never-matches/, { timeout: 20 }),
      /page\.waitForResponse timed out after 20ms/,
    );
  } finally {
    cleanupBrowserRuntime();
  }
});

test("waitForRequest rejects async predicates and disables owned Network domain", async () => {
  const calls = installAutoEgo();
  try {
    const promise = waitForRequest(async () => true, { timeout: 1000 });
    setTimeout(() => {
      fireEvent("Network.requestWillBeSent", {
        requestId: "req-async",
        type: "XHR",
        request: {
          url: "https://example.com/api/async",
          method: "GET",
          headers: {},
        },
      });
    }, 20);
    await assert.rejects(
      () => promise,
      /page\.waitForRequest does not support async predicates/,
    );
  } finally {
    cleanupBrowserRuntime();
  }
  assert.ok(calls.some((call) => call.method === "Network.enable"));
  assert.ok(calls.some((call) => call.method === "Network.disable"));
});

test("waitForResponse matches redirect responses from requestWillBeSent", async () => {
  installAutoEgo();
  try {
    const promise = waitForResponse(
      (response) =>
        response.url() === "https://example.com/old" &&
        response.status() === 302 &&
        response.request().method() === "GET",
      { timeout: 1000 },
    );
    setTimeout(() => {
      fireEvent("Network.requestWillBeSent", {
        requestId: "req-redirect",
        type: "Document",
        request: {
          url: "https://example.com/old",
          method: "GET",
          headers: {},
        },
      });
      fireEvent("Network.requestWillBeSent", {
        requestId: "req-redirect",
        type: "Document",
        redirectResponse: {
          url: "https://example.com/old",
          status: 302,
          statusText: "Found",
          headers: { location: "https://example.com/new" },
        },
        request: {
          url: "https://example.com/new",
          method: "GET",
          headers: {},
        },
      });
    }, 20);
    const response = await promise;
    assert.equal(response.url(), "https://example.com/old");
    assert.equal(response.status(), 302);
    assert.equal(response.headers().location, "https://example.com/new");
    assert.equal(response.request().url(), "https://example.com/old");
  } finally {
    cleanupBrowserRuntime();
  }
});

test("response body waits for loadingFinished when initially unavailable", async () => {
  let bodyAttempts = 0;
  installAutoEgo((call) => {
    if (call.method === "Network.getResponseBody") {
      bodyAttempts += 1;
      if (bodyAttempts === 1) {
        setTimeout(() => {
          fireEvent("Network.loadingFinished", { requestId: "req-body" });
        }, 20);
        return {
          error: { message: "No resource with given identifier found" },
        };
      }
      return { body: "done", base64Encoded: false };
    }
    return {};
  });
  try {
    const promise = waitForResponse("https://example.com/api/body", {
      timeout: 1000,
    });
    setTimeout(() => {
      fireEvent("Network.requestWillBeSent", {
        requestId: "req-body",
        type: "Fetch",
        request: {
          url: "https://example.com/api/body",
          method: "GET",
          headers: {},
        },
      });
      fireEvent("Network.responseReceived", {
        requestId: "req-body",
        type: "Fetch",
        response: {
          url: "https://example.com/api/body",
          status: 200,
          statusText: "OK",
          headers: {},
        },
      });
    }, 20);
    const response = await promise;
    assert.equal(await response.text(), "done");
    assert.equal(bodyAttempts, 2);
  } finally {
    cleanupBrowserRuntime();
  }
});

test("waitForRequest supports synchronous request predicates", async () => {
  installAutoEgo();
  try {
    const promise = waitForRequest(
      (request) =>
        request.url().endsWith("/api/filter") &&
        request.method() === "PUT" &&
        request.headers()["content-type"] === "application/json" &&
        request.postData() === '{"ok":true}',
      { timeout: 1000 },
    );
    setTimeout(() => {
      fireEvent("Network.requestWillBeSent", {
        requestId: "req-predicate",
        type: "XHR",
        request: {
          url: "https://example.com/api/filter",
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          postData: '{"ok":true}',
        },
      });
    }, 20);
    const request = await promise;
    assert.equal(request.method(), "PUT");
  } finally {
    cleanupBrowserRuntime();
  }
});

test("waitForResponse rejects invalid matchers and disables owned Network domain", async () => {
  const calls = installAutoEgo();
  try {
    const promise = waitForResponse(null, { timeout: 1000 });
    setTimeout(() => {
      fireEvent("Network.requestWillBeSent", {
        requestId: "req-invalid",
        type: "XHR",
        request: {
          url: "https://example.com/api/invalid",
          method: "GET",
          headers: {},
        },
      });
      fireEvent("Network.responseReceived", {
        requestId: "req-invalid",
        type: "XHR",
        response: {
          url: "https://example.com/api/invalid",
          status: 200,
          statusText: "OK",
          headers: {},
        },
      });
    }, 20);
    await assert.rejects(
      () => promise,
      /page\.waitForResponse expects a string, RegExp, or function matcher, got null/,
    );
  } finally {
    cleanupBrowserRuntime();
  }
  assert.ok(calls.some((call) => call.method === "Network.enable"));
  assert.ok(calls.some((call) => call.method === "Network.disable"));
});

test("waitForRequest leaves a caller-enabled Network domain enabled", async () => {
  const calls = installAutoEgo();
  try {
    await cdp("Network.enable");
    calls.length = 0;
    const promise = waitForRequest("https://example.com/api/owned", {
      timeout: 1000,
    });
    setTimeout(() => {
      fireEvent("Network.requestWillBeSent", {
        requestId: "req-owned",
        type: "XHR",
        request: {
          url: "https://example.com/api/owned",
          method: "GET",
          headers: {},
        },
      });
    }, 20);
    const request = await promise;
    assert.equal(request.url(), "https://example.com/api/owned");
  } finally {
    cleanupBrowserRuntime();
  }
  assert.ok(!calls.some((call) => call.method === "Network.disable"));
});

test("concurrent network waits share the Network domain until all complete", async () => {
  const calls = installAutoEgo();
  try {
    const requestPromise = waitForRequest("https://example.com/api/first", {
      timeout: 1000,
    });
    const responsePromise = waitForResponse("https://example.com/api/second", {
      timeout: 1000,
    });
    setTimeout(() => {
      fireEvent("Network.requestWillBeSent", {
        requestId: "req-first",
        type: "XHR",
        request: {
          url: "https://example.com/api/first",
          method: "GET",
          headers: {},
        },
      });
    }, 20);
    const request = await requestPromise;
    assert.equal(request.url(), "https://example.com/api/first");
    assert.equal(
      calls.filter((call) => call.method === "Network.disable").length,
      0,
      "first completed wait must not disable while another wait is pending",
    );
    fireEvent("Network.requestWillBeSent", {
      requestId: "req-second",
      type: "XHR",
      request: {
        url: "https://example.com/api/second",
        method: "GET",
        headers: {},
      },
    });
    fireEvent("Network.responseReceived", {
      requestId: "req-second",
      type: "XHR",
      response: {
        url: "https://example.com/api/second",
        status: 200,
        statusText: "OK",
        headers: {},
      },
    });
    const response = await responsePromise;
    assert.equal(response.url(), "https://example.com/api/second");
  } finally {
    cleanupBrowserRuntime();
  }
  assert.equal(
    calls.filter((call) => call.method === "Network.enable").length,
    1,
  );
  assert.equal(
    calls.filter((call) => call.method === "Network.disable").length,
    1,
  );
});

test("response body decodes base64 payloads", async () => {
  const encoded = Buffer.from("hello").toString("base64");
  installAutoEgo((call) => {
    if (call.method === "Network.getResponseBody") {
      return { body: encoded, base64Encoded: true };
    }
    return {};
  });
  try {
    const promise = waitForResponse("https://example.com/api/base64", {
      timeout: 1000,
    });
    setTimeout(() => {
      fireEvent("Network.requestWillBeSent", {
        requestId: "req-base64",
        type: "Fetch",
        request: {
          url: "https://example.com/api/base64",
          method: "GET",
          headers: {},
        },
      });
      fireEvent("Network.responseReceived", {
        requestId: "req-base64",
        type: "Fetch",
        response: {
          url: "https://example.com/api/base64",
          status: 200,
          statusText: "OK",
          headers: {},
        },
      });
    }, 20);
    const response = await promise;
    assert.equal((await response.body()).toString("utf8"), "hello");
    assert.equal(await response.text(), "hello");
  } finally {
    cleanupBrowserRuntime();
  }
});

test("response ok is false for non-2xx statuses", async () => {
  installAutoEgo();
  try {
    const promise = waitForResponse("https://example.com/api/fail", {
      timeout: 1000,
    });
    setTimeout(() => {
      fireEvent("Network.responseReceived", {
        requestId: "req-fail",
        type: "XHR",
        response: {
          url: "https://example.com/api/fail",
          status: 500,
          statusText: "Internal Server Error",
          headers: {},
        },
      });
    }, 20);
    const response = await promise;
    assert.equal(response.status(), 500);
    assert.equal(response.ok(), false);
  } finally {
    cleanupBrowserRuntime();
  }
});

test("waitForRequest timeout 0 disables the timeout", async () => {
  installAutoEgo();
  try {
    const promise = waitForRequest("https://example.com/api/no-timeout", {
      timeout: 0,
    });
    setTimeout(() => {
      fireEvent("Network.requestWillBeSent", {
        requestId: "req-no-timeout",
        type: "XHR",
        request: {
          url: "https://example.com/api/no-timeout",
          method: "GET",
          headers: {},
        },
      });
    }, 20);
    const request = await promise;
    assert.equal(request.url(), "https://example.com/api/no-timeout");
  } finally {
    cleanupBrowserRuntime();
  }
});

test("waitForLoadState accepts Playwright-style options as the first argument", async () => {
  let t = 0;
  const readyStates = ["loading", "loading"];
  const sleeps = [];
  const restore = setOverrides({
    cdpOverride: async (method, params) => {
      if (method === "Runtime.evaluate") {
        if (params.expression === "document.readyState") {
          return { result: { value: readyStates.shift() || "loading" } };
        }
        return { result: { value: true } };
      }
      return {};
    },
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  });
  try {
    const result = await waitForLoadState({ timeout: 500 });
    assert.equal(result, false);
  } finally {
    restore();
  }
  assert.deepEqual(sleeps, [300, 300]);
});

test("waitForLoadState enables the Network domain and disables it afterwards", async () => {
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
    },
  });
  try {
    const result = await waitForLoadState("networkidle", { timeout: 5000 });
    assert.equal(result, true, "no traffic for idleMs resolves true");
  } finally {
    restore();
  }
  assert.equal(
    methods[0],
    "Network.enable",
    "must enable Network before observing",
  );
  assert.equal(
    methods.at(-1),
    "Network.disable",
    "must disable Network when done",
  );
});

test("waitForLoadState leaves a caller-enabled Network domain enabled", async () => {
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
    },
  });
  try {
    await cdp("Network.enable"); // the caller owns the domain
    methods.length = 0;
    const result = await waitForLoadState("networkidle", { timeout: 5000 });
    assert.equal(result, true);
  } finally {
    restore();
  }
  assert.ok(
    !methods.includes("Network.disable"),
    "must not tear down a Network domain the caller enabled",
  );
});

test("waitForLoadState survives a bridge that rejects Network.enable", async () => {
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
    },
  });
  try {
    const result = await waitForLoadState("networkidle", { timeout: 5000 });
    assert.equal(result, true, "falls back to passive observation");
  } finally {
    restore();
  }
});
