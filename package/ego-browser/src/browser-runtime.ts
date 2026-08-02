import { state } from "./state.js";
import { assertNoEgoError, buildEgoError } from "./ego-errors.js";

const RESPONSE_TIMEOUT_MS = 15000;
const SESSION_TTL_MS = 2000;
// Upper bound for buffered CDP events. The runtime can be long-lived (installEgoSdk
// inside the browser); without a cap, undrained events grow without bound.
const MAX_BUFFERED_EVENTS = 10000;
const SESSION_LOST =
  /Session (?:with given id )?not found|Target closed|No session/i;
const BROWSER_LEVEL = (method) =>
  method.startsWith("Target.") || method.startsWith("Browser.");
type BrowserEventSubscriber = {
  method: string;
  sessionId?: string;
  listener: (event: any) => void;
};
let nextMessageId = 1;
const pending = new Map();
const events = [];
const eventWaiters = [];
const eventSubscribers = new Set<BrowserEventSubscriber>();
const pageEnabledSessions = new Set();
const pendingDialogs = new Map();
export function isBrowserRuntime() {
  return Boolean(
    globalThis.ego && typeof globalThis.ego.sendCDPMessage === "function",
  );
}

export function browserEgo() {
  if (!globalThis.ego) {
    throw new Error("browser runtime is not available");
  }
  return globalThis.ego;
}

function rawCdp(
  method,
  params: any = {},
  sessionId = undefined,
  timeoutMs = RESPONSE_TIMEOUT_MS,
) {
  const runtime = browserEgo();
  runtime.onCDPMessage = handleMessage;
  runtime.onSendCDPMessageError = handleSendError;
  const id = nextMessageId++;
  const payload = JSON.stringify({
    id,
    method,
    params,
    ...(sessionId ? { sessionId } : {}),
  });
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP request timed out: ${method}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    try {
      runtime.sendCDPMessage(payload);
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });
}

export async function browserCdp(
  method,
  params: any = {},
  sessionId = undefined,
  timeoutMs = RESPONSE_TIMEOUT_MS,
) {
  // Test mock: cdpOverride bypasses everything including session injection.
  if (state.cdpOverride) {
    return state.cdpOverride(method, params, sessionId);
  }
  const explicit = sessionId !== undefined;
  let effective = sessionId;
  if (!explicit && !BROWSER_LEVEL(method)) {
    effective = await ensureSession();
  }
  try {
    return await rawCdp(method, params, effective, timeoutMs);
  } catch (error) {
    const lost = SESSION_LOST.test(error?.message || "");
    if (lost && !explicit && !BROWSER_LEVEL(method)) {
      invalidateSession();
      const fresh = await ensureSession();
      return rawCdp(method, params, fresh, timeoutMs);
    }
    throw error;
  }
}

export async function ensureSession() {
  if (state.sessionId && Date.now() - state.sessionAt < SESSION_TTL_MS) {
    return state.sessionId;
  }
  if (state.sessionInflight) {
    return state.sessionInflight;
  }
  state.sessionInflight = (async () => {
    try {
      const result = assertNoEgoError(await browserEgo().listTabs());
      const tabs = result?.tabs || result?.targetInfos || [];
      const preferred = state.preferredTargetId
        ? tabs.find((t) => t.targetId === state.preferredTargetId)
        : null;
      const active =
        preferred || tabs.find((t) => t.active) || tabs[tabs.length - 1];
      if (!active) {
        throw new Error("no active tab to attach session");
      }
      const targetId = active.targetId;
      if (targetId !== state.sessionTargetId || !state.sessionId) {
        const attached = await rawCdp(
          "Target.attachToTarget",
          { targetId, flatten: true },
          undefined,
        );
        state.sessionId = attached.result?.sessionId || attached.sessionId;
        state.sessionTargetId = targetId;
      }
      await enablePageEvents(state.sessionId);
      state.sessionAt = Date.now();
      return state.sessionId;
    } finally {
      state.sessionInflight = null;
    }
  })();
  return state.sessionInflight;
}

export function invalidateSession() {
  if (state.sessionId) {
    pageEnabledSessions.delete(state.sessionId);
    pendingDialogs.delete(state.sessionId);
  }
  state.sessionId = null;
  state.sessionTargetId = null;
  state.sessionAt = 0;
}

export function setPreferredTarget(targetId) {
  state.preferredTargetId = targetId || null;
}

export function clearPreferredTarget() {
  state.preferredTargetId = null;
}

export function drainBrowserEvents() {
  const out = events.splice(0, events.length);
  return out;
}

export function waitForBrowserEvent(
  predicate,
  timeoutMs = state.defaultTimeout,
) {
  return new Promise((resolve, reject) => {
    const waiter = {
      predicate,
      resolve,
      reject,
      timer: setTimeout(() => {
        const index = eventWaiters.indexOf(waiter);
        if (index >= 0) eventWaiters.splice(index, 1);
        reject(new Error("page.waitForEvent timed out"));
      }, timeoutMs),
    };
    eventWaiters.push(waiter);
  });
}

export function subscribeBrowserEvent(
  method: string,
  sessionId: string | undefined,
  listener: (event: any) => void,
) {
  const subscriber = { method, sessionId, listener };
  eventSubscribers.add(subscriber);
  return () => eventSubscribers.delete(subscriber);
}

export function pendingDialog(sessionId = state.sessionId) {
  if (sessionId && pendingDialogs.has(sessionId)) {
    return { ...pendingDialogs.get(sessionId) };
  }
  return null;
}

async function enablePageEvents(sessionId) {
  if (!sessionId || pageEnabledSessions.has(sessionId)) {
    return;
  }
  try {
    await rawCdp("Page.enable", {}, sessionId);
    pageEnabledSessions.add(sessionId);
  } catch {
    // Dialog tracking is best-effort. Do not make all helpers fail on targets
    // that reject Page.enable, such as unusual internal pages.
  }
}

// Local send failures for ego.sendCDPMessage() arrive here (task inactive,
// user-controlled, not selected/claimed, host gone) instead of as a CDP
// response, so the matching request would otherwise sit until the 15s timeout.
// The callback carries no request id; these failures are task-level (every
// in-flight send fails the same way), so reject all pending requests, routing
// the stable code through buildEgoError to use the ego-browser-owned wording.
function handleSendError(message, error_code) {
  if (pending.size === 0) return;
  const error = buildEgoError({ error: message, error_code });
  const entries = [...pending.values()];
  pending.clear();
  for (const entry of entries) entry.reject(error);
}

function handleMessage(message) {
  let data;
  try {
    data = JSON.parse(message);
  } catch {
    return;
  }
  if (Object.hasOwn(data, "id")) {
    const entry = pending.get(data.id);
    if (!entry) {
      return;
    }
    pending.delete(data.id);
    if (data.error) {
      entry.reject(new Error(data.error.message || data.error));
      return;
    }
    entry.resolve(data);
    return;
  }
  if (
    data.method === "Target.detachedFromTarget" ||
    data.method === "Target.targetDestroyed"
  ) {
    const sessionId = data.params?.sessionId || data.sessionId;
    if (sessionId) {
      pageEnabledSessions.delete(sessionId);
      pendingDialogs.delete(sessionId);
    }
    const targetId = data.params?.targetId || data.params?.targetInfo?.targetId;
    if (targetId && targetId === state.sessionTargetId) {
      invalidateSession();
    }
  }
  if (data.method === "Page.javascriptDialogOpening") {
    const sessionId = data.sessionId || state.sessionId;
    if (sessionId) {
      pendingDialogs.set(sessionId, data.params || {});
    }
  } else if (data.method === "Page.javascriptDialogClosed") {
    const sessionId = data.sessionId || state.sessionId;
    if (sessionId) {
      pendingDialogs.delete(sessionId);
    }
  }
  let deliveredToSubscriber = false;
  for (const subscriber of eventSubscribers) {
    if (subscriber.method !== data.method) continue;
    if (subscriber.sessionId && subscriber.sessionId !== data.sessionId) {
      continue;
    }
    deliveredToSubscriber = true;
    try {
      subscriber.listener(data);
    } catch (error) {
      console.error("Browser event subscriber failed:", error);
    }
  }
  if (!(deliveredToSubscriber && data.method === "Page.screencastFrame")) {
    events.push(data);
    if (events.length > MAX_BUFFERED_EVENTS) {
      events.splice(0, events.length - MAX_BUFFERED_EVENTS);
    }
  }
  for (const waiter of [...eventWaiters]) {
    let matched = false;
    try {
      matched = waiter.predicate(data);
    } catch (error) {
      clearTimeout(waiter.timer);
      eventWaiters.splice(eventWaiters.indexOf(waiter), 1);
      waiter.reject(error);
      continue;
    }
    if (!matched) continue;
    clearTimeout(waiter.timer);
    eventWaiters.splice(eventWaiters.indexOf(waiter), 1);
    waiter.resolve(data);
  }
}

export function browserSnapshotRefsToRefMap(refMap, refs = []) {
  refMap.clear();
  for (const ref of refs) {
    if (!ref || typeof ref !== "object") {
      continue;
    }
    if (ref.backendNodeId === undefined || ref.backendNodeId === null) {
      continue;
    }
    refMap.add(
      String(ref.backendNodeId),
      ref.backendNodeId,
      ref.role,
      ref.name,
      undefined,
    );
  }
}
