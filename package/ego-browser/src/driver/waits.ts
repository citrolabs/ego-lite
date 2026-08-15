import { state } from "../state.js";
import { cdp, runtimeValue } from "../cdp-eval.js";
import { resolveHandle, releaseHandle } from "./element-ops.js";
import { ElementResolutionError } from "../ego-errors.js";
import { waitForDocumentLoad } from "./load.js";
import { drainEvents } from "./observe.js";
import { waitForBrowserEvent } from "../browser-runtime.js";

type WaitForSelectorOptions = {
  timeout?: number;
  state?: "visible" | "attached";
};

type WaitForFunctionOptions = {
  timeout?: number;
  polling?: number;
};

type WaitForURLOptions = {
  timeout?: number;
  waitUntil?: LoadState | "commit";
};

type WaitForLoadStateOptions = {
  timeout?: number;
  idleMs?: number;
};

type WaitForNetworkOptions = {
  timeout?: number;
};

type LoadState = "load" | "domcontentloaded" | "networkidle";

let networkEventUsers = 0;
let networkEventsOwnDomain = false;
let networkEnableInFlight: Promise<void> | null = null;

/**
 * Sleep for a fixed number of milliseconds.
 * @param {number} [ms=1000] Milliseconds to wait.
 * @returns {Promise<void>}
 */
export async function waitForTimeout(ms = 1000) {
  await state.sleep(ms);
}

/**
 * Poll a page function or expression until it returns a truthy value.
 * @param {string|Function} pageFunction Browser-side expression or function.
 * @param {unknown|{timeout?: number, polling?: number}} [argOrOptions] Optional function argument, or options.
 * @param {{timeout?: number, polling?: number}} [options] timeout and polling in milliseconds.
 * @returns {Promise<unknown|false>} The first truthy return value, or false on timeout.
 */
export async function waitForFunction(
  pageFunction,
  argOrOptions: unknown | WaitForFunctionOptions = undefined,
  options: WaitForFunctionOptions = {},
) {
  const [arg, effectiveOptions] = normalizeWaitForFunctionArgs(
    arguments.length,
    argOrOptions,
    options,
  );
  const timeout = effectiveOptions.timeout ?? state.defaultTimeout;
  const polling = effectiveOptions.polling ?? 100;
  const deadline = state.now() + timeout;
  const expression = buildWaitForFunctionExpression(pageFunction, arg);
  while (state.now() < deadline) {
    const response = await cdp("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    const value = runtimeValue(response, expression);
    if (value) {
      return value;
    }
    await state.sleep(polling);
  }
  return false;
}

/**
 * Wait for the current page URL to match a string, glob, RegExp, or predicate.
 * @param {string|RegExp|Function} url URL matcher. Predicate functions receive a URL object. Strings with * are treated as globs; other strings are exact.
 * @param {{timeout?: number, waitUntil?: "load"|"domcontentloaded"|"networkidle"|"commit"}} [options]
 *   `waitUntil` defaults to `"load"`.
 * @returns {Promise<boolean>} True when matched before timeout.
 */
export async function waitForURL(url, options: WaitForURLOptions = {}) {
  const timeout = options.timeout ?? state.defaultTimeout;
  const deadline = state.now() + timeout;
  while (state.now() < deadline) {
    const current = runtimeValue(
      await cdp("Runtime.evaluate", {
        expression: "location.href",
        returnByValue: true,
        awaitPromise: false,
      }),
      "location.href",
    );
    if (urlMatches(current, url)) {
      const waitUntil = options.waitUntil ?? "load";
      // waitForDocumentLoad treats about:blank as an uncommitted transient,
      // so skip document-load states for a matched blank page. Explicit
      // networkidle still needs to observe its idle window.
      return waitUntil === "commit" ||
        (current === "about:blank" && waitUntil !== "networkidle")
        ? true
        : waitForLoadState(waitUntil, {
            timeout: Math.max(0, deadline - state.now()),
          });
    }
    await state.sleep(100);
  }
  return false;
}

/**
 * Wait for a network request whose URL or request facade matches.
 * @param {string|RegExp|Function} urlOrPredicate Exact URL, RegExp, or synchronous request predicate.
 * @param {{timeout?: number}} [options] timeout in milliseconds; 0 disables timeout.
 * @returns {Promise<object>} Playwright-style request facade.
 */
export async function waitForRequest(
  urlOrPredicate,
  options: WaitForNetworkOptions = {},
) {
  return waitForNetworkMatch("request", urlOrPredicate, options);
}

/**
 * Wait for a network response whose URL or response facade matches.
 * @param {string|RegExp|Function} urlOrPredicate Exact URL, RegExp, or synchronous response predicate.
 * @param {{timeout?: number}} [options] timeout in milliseconds; 0 disables timeout.
 * @returns {Promise<object>} Playwright-style response facade.
 */
export async function waitForResponse(
  urlOrPredicate,
  options: WaitForNetworkOptions = {},
) {
  return waitForNetworkMatch("response", urlOrPredicate, options);
}

/**
 * Wait for a page load state. `"networkidle"` waits until network traffic goes
 * idle; `"domcontentloaded"` until the DOM is interactive; otherwise until
 * document.readyState is complete.
 * @param {"load"|"domcontentloaded"|"networkidle"|{timeout?: number, idleMs?: number}} [loadState="load"] Load state to wait for, or options for the default "load" state.
 * @param {{timeout?: number, idleMs?: number}} [options] timeout in milliseconds; idleMs only applies to "networkidle".
 * @returns {Promise<boolean>} True when the state was reached before timeout.
 */
export async function waitForLoadState(
  loadState: LoadState | WaitForLoadStateOptions = "load",
  options: WaitForLoadStateOptions = {},
) {
  const [stateName, effectiveOptions] = normalizeLoadStateArgs(
    loadState,
    options,
  );
  if (stateName === "networkidle") {
    return waitForNetworkIdle(effectiveOptions);
  }
  return waitForDocumentLoad({
    timeout: effectiveOptions.timeout,
    until: stateName === "domcontentloaded" ? "domcontentloaded" : "load",
  });
}

function normalizeLoadStateArgs(
  loadState: LoadState | WaitForLoadStateOptions,
  options: WaitForLoadStateOptions,
): [LoadState, WaitForLoadStateOptions] {
  if (loadState && typeof loadState === "object") {
    return ["load", loadState];
  }
  return [(loadState || "load") as LoadState, options];
}

function normalizeWaitForFunctionArgs(
  length: number,
  argOrOptions: unknown | WaitForFunctionOptions,
  options: WaitForFunctionOptions,
): [unknown, WaitForFunctionOptions] {
  if (length >= 3) {
    return [argOrOptions, options];
  }
  if (isWaitForFunctionOptions(argOrOptions)) {
    return [undefined, argOrOptions];
  }
  return [argOrOptions, {}];
}

function isWaitForFunctionOptions(value): value is WaitForFunctionOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return "timeout" in value || "polling" in value;
}

function buildWaitForFunctionExpression(pageFunction, arg) {
  if (typeof pageFunction === "function") {
    return `(${pageFunction.toString()})(${JSON.stringify(arg)})`;
  }
  if (typeof pageFunction !== "string") {
    throw new TypeError(
      `waitForFunction expects a string expression or function, got ${pageFunction === null ? "null" : typeof pageFunction}`,
    );
  }
  return `(${pageFunction})`;
}

function urlMatches(current, matcher) {
  if (matcher instanceof RegExp) {
    return matcher.test(current);
  }
  if (typeof matcher === "function") {
    return Boolean(matcher(new URL(current)));
  }
  if (typeof matcher !== "string") {
    throw new TypeError(
      `waitForURL expects a string, RegExp, or function matcher, got ${matcher === null ? "null" : typeof matcher}`,
    );
  }
  if (matcher.includes("*")) {
    return globToRegExp(matcher).test(current);
  }
  return current === matcher;
}

function globToRegExp(glob) {
  let source = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        source += ".*";
        i += 1;
      } else {
        source += "[^/]*";
      }
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

async function waitForNetworkMatch(
  kind: "request" | "response",
  matcher,
  options: WaitForNetworkOptions,
) {
  const timeout = networkTimeout(options);
  const requests = new Map();
  const networkEvents = acquireNetworkEvents();
  let matched;
  try {
    void networkEvents.ready;
    await waitForBrowserEvent((event) => {
      matched = processNetworkEvent(kind, matcher, event, requests, timeout);
      return Boolean(matched);
    }, browserEventTimeout(timeout));
    return matched;
  } catch (error) {
    if (/page\.waitForEvent timed out/i.test(error?.message || "")) {
      throw new Error(
        `page.waitFor${kind === "request" ? "Request" : "Response"} timed out after ${timeout}ms`,
      );
    }
    throw error;
  } finally {
    await networkEvents.release();
  }
}

function processNetworkEvent(kind, matcher, event, requests, timeout) {
  const method = event?.method;
  const params = event?.params || {};
  if (method === "Network.requestWillBeSent") {
    const previousRequest = requests.get(params.requestId);
    if (kind === "response" && params.redirectResponse) {
      const response = createResponseFacade(
        {
          requestId: params.requestId,
          response: params.redirectResponse,
          request: previousRequest,
        },
        timeout,
      );
      if (networkMatches(response, matcher, kind)) {
        return response;
      }
    }
    const request = createRequestInfo(params);
    requests.set(params.requestId, request);
    if (kind === "request") {
      const facade = createRequestFacade(request);
      if (networkMatches(facade, matcher, kind)) {
        return facade;
      }
    }
    return null;
  }
  if (kind === "response" && method === "Network.responseReceived") {
    const response = createResponseFacade(
      {
        requestId: params.requestId,
        response: params.response || {},
        request: requests.get(params.requestId),
      },
      timeout,
    );
    if (networkMatches(response, matcher, kind)) {
      return response;
    }
  }
  return null;
}

function networkMatches(facade, matcher, kind) {
  if (typeof matcher === "string") {
    return facade.url() === matcher;
  }
  if (matcher instanceof RegExp) {
    matcher.lastIndex = 0;
    return matcher.test(facade.url());
  }
  if (typeof matcher === "function") {
    const result = matcher(facade);
    if (result && typeof result.then === "function") {
      throw new Error(
        `page.waitFor${kind === "request" ? "Request" : "Response"} does not support async predicates`,
      );
    }
    return Boolean(result);
  }
  throw new TypeError(
    `page.waitFor${kind === "request" ? "Request" : "Response"} expects a string, RegExp, or function matcher, got ${matcher === null ? "null" : typeof matcher}`,
  );
}

function createRequestInfo(params) {
  const request = params.request || {};
  return {
    requestId: params.requestId,
    url: request.url || "",
    method: request.method || "",
    headers: normalizeHeaders(request.headers),
    postData: request.postData ?? null,
    resourceType: String(params.type || "").toLowerCase(),
  };
}

function createRequestFacade(info) {
  return {
    url: () => info.url,
    method: () => info.method,
    headers: () => ({ ...info.headers }),
    postData: () => info.postData,
    resourceType: () => info.resourceType,
  };
}

function createResponseFacade(info, timeout) {
  const response = info.response || {};
  const request =
    info.request ||
    createRequestInfo({
      requestId: info.requestId,
      request: {
        url: response.url || "",
        method: "",
        headers: response.requestHeaders || {},
      },
      type: response.type,
    });
  const status = Number(response.status || 0);
  const headers = normalizeHeaders(response.headers);
  const facade: any = {
    url: () => response.url || request.url || "",
    status: () => status,
    statusText: () => response.statusText || "",
    ok: () => status >= 200 && status <= 299,
    headers: () => ({ ...headers }),
    request: () => createRequestFacade(request),
    body: async () => {
      const body = await readResponseBody(info.requestId, timeout);
      return body.base64Encoded
        ? Buffer.from(body.body || "", "base64")
        : Buffer.from(body.body || "", "utf8");
    },
    text: async () => {
      const body = await readResponseBody(info.requestId, timeout);
      return body.base64Encoded
        ? Buffer.from(body.body || "", "base64").toString("utf8")
        : body.body || "";
    },
  };
  facade.json = async () => JSON.parse(await facade.text());
  return facade;
}

async function readResponseBody(requestId, timeout) {
  if (!requestId) {
    throw new Error("response body is unavailable without a requestId");
  }
  try {
    return await cdp("Network.getResponseBody", { requestId });
  } catch (firstError) {
    await waitForBrowserEvent(
      (event) =>
        (event?.method === "Network.loadingFinished" ||
          event?.method === "Network.loadingFailed") &&
        event?.params?.requestId === requestId,
      browserEventTimeout(timeout),
    ).catch(() => null);
    try {
      return await cdp("Network.getResponseBody", { requestId });
    } catch (error) {
      throw new Error(
        `response body is unavailable for request ${requestId}: ${error?.message || firstError?.message || error}`,
      );
    }
  }
}

function normalizeHeaders(headers = {}) {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers || {})) {
    out[String(name).toLowerCase()] = String(value);
  }
  return out;
}

function networkTimeout(options: WaitForNetworkOptions) {
  const timeout = options.timeout ?? state.defaultTimeout;
  if (!Number.isFinite(timeout) || timeout < 0) {
    throw new Error("network wait timeout must be a non-negative number");
  }
  return timeout;
}

function browserEventTimeout(timeout) {
  return timeout === 0 ? 2147483647 : Math.min(timeout, 2147483647);
}

function acquireNetworkEvents() {
  if (networkEventUsers === 0 && !state.networkDomainEnabled) {
    networkEnableInFlight = cdp("Network.enable")
      .then(() => {
        networkEventsOwnDomain = true;
      })
      .catch(() => {
        // Some bridges do not expose the Network domain. The waiter will time out
        // with the normal waitForRequest/waitForResponse error.
      })
      .finally(() => {
        networkEnableInFlight = null;
      });
  }
  networkEventUsers += 1;
  let released = false;
  return {
    ready: networkEnableInFlight || Promise.resolve(),
    release: async () => {
      if (released) return;
      released = true;
      networkEventUsers = Math.max(0, networkEventUsers - 1);
      if (networkEventUsers > 0) return;
      if (networkEnableInFlight) {
        await networkEnableInFlight;
      }
      if (networkEventsOwnDomain) {
        networkEventsOwnDomain = false;
        await cdp("Network.disable").catch(() => {
          // Best-effort cleanup; the next wait can enable the domain again.
        });
      }
    },
  };
}

/**
 * Wait until an element exists, optionally requiring visibility.
 * @param {string} selector CSS selector / @ref / loc= / xpath= to poll.
 * @param {{timeout?: number, state?: "visible"|"attached"}} [options] timeout in milliseconds; state defaults to "attached".
 * @returns {Promise<boolean>} True when found before timeout.
 */
export async function waitForSelector(
  selector: string,
  options: WaitForSelectorOptions = {},
) {
  const timeout = options.timeout ?? state.defaultTimeout;
  const requireVisible = options.state === "visible";
  const deadline = state.now() + timeout;
  const visibilityFn =
    "function(){if(typeof this.checkVisibility==='function')return this.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});const s=getComputedStyle(this);return s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0';}";
  while (state.now() < deadline) {
    let handle;
    try {
      handle = await resolveHandle(selector);
    } catch (err) {
      if (err instanceof ElementResolutionError && err.kind === "transient") {
        await state.sleep(300);
        continue; // not found / not ready yet — keep polling.
      }
      throw err; // permanent (bad selector / ambiguous) or unknown error — fail loud.
    }
    try {
      if (!requireVisible) return true;
      const response = await cdp(
        "Runtime.callFunctionOn",
        {
          functionDeclaration: visibilityFn,
          objectId: handle.objectId,
          returnByValue: true,
          awaitPromise: false,
        },
        handle.sessionId,
      );
      if (response.result?.value) return true;
    } catch {
      // visibility check failed (element raced away); treat as not-ready, keep polling.
    } finally {
      await releaseHandle(handle.objectId, handle.sessionId);
    }
    await state.sleep(300);
  }
  return false;
}

/**
 * Wait until network events are idle. Module-private; reachable through
 * waitForLoadState("networkidle").
 * Enables the CDP Network domain for the duration of the wait so that network
 * events are actually delivered (previously nothing enabled the domain, so this
 * could report "idle" without ever observing traffic). If the caller had
 * already enabled the domain, it is left enabled on return. Best-effort: if
 * the runtime does not deliver Network events, an idle window of idleMs still
 * resolves true.
 * @param {{timeout?: number, idleMs?: number}} [options] timeout & idleMs in milliseconds.
 * @returns {Promise<boolean>} True when idle before timeout.
 */
async function waitForNetworkIdle(options: WaitForLoadStateOptions = {}) {
  const timeout = options.timeout ?? 10000;
  const idleMs = options.idleMs ?? 500;
  const deadline = state.now() + timeout;
  let lastActivity = state.now();
  const inflight = new Set();
  const networkEvents = acquireNetworkEvents();
  await networkEvents.ready;
  try {
    while (state.now() < deadline) {
      for (const event of await drainEvents()) {
        const method = event.method || "";
        const params = event.params || {};
        if (method === "Network.requestWillBeSent") {
          inflight.add(params.requestId);
          lastActivity = state.now();
        } else if (
          method === "Network.loadingFinished" ||
          method === "Network.loadingFailed"
        ) {
          inflight.delete(params.requestId);
          lastActivity = state.now();
        } else if (method.startsWith("Network.")) {
          lastActivity = state.now();
        }
      }
      if (inflight.size === 0 && state.now() - lastActivity >= idleMs) {
        return true;
      }
      await state.sleep(100);
    }
    return false;
  } finally {
    await networkEvents.release();
  }
}
