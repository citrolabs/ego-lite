import { state } from "./state.js";

const RESPONSE_TIMEOUT_MS = 15000;
const SESSION_TTL_MS = 2000;
const SESSION_LOST = /Session (?:with given id )?not found|Target closed|No session/i;
const BROWSER_LEVEL = (method) => method.startsWith("Target.") || method.startsWith("Browser.");
let nextMessageId = 1;
const pending = new Map();
const events = [];
export function isBrowserRuntime() {
  return Boolean(globalThis.ego && typeof globalThis.ego.sendCDPMessage === "function");
}

export function browserEgo() {
  if (!globalThis.ego) {
    throw new Error("browser runtime is not available");
  }
  return globalThis.ego;
}

function rawCdp(method, params: any = {}, sessionId = undefined, timeoutMs = RESPONSE_TIMEOUT_MS) {
  const runtime = browserEgo();
  runtime.onCDPMessage = handleMessage;
  const id = nextMessageId++;
  const payload = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
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
      }
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

export async function browserCdp(method, params: any = {}, sessionId = undefined, timeoutMs = RESPONSE_TIMEOUT_MS) {
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
      const result = await browserEgo().listTabs();
      const tabs = result?.tabs || result?.targetInfos || [];
      const preferred = state.preferredTargetId
        ? tabs.find((t) => t.targetId === state.preferredTargetId)
        : null;
      const active = preferred || tabs.find((t) => t.active) || tabs[tabs.length - 1];
      if (!active) {
        throw new Error("no active tab to attach session");
      }
      const targetId = active.targetId;
      if (targetId !== state.sessionTargetId || !state.sessionId) {
        const attached = await rawCdp("Target.attachToTarget", { targetId, flatten: true }, undefined);
        state.sessionId = attached.result?.sessionId || attached.sessionId;
        state.sessionTargetId = targetId;
      }
      state.sessionAt = Date.now();
      return state.sessionId;
    } finally {
      state.sessionInflight = null;
    }
  })();
  return state.sessionInflight;
}

export function invalidateSession() {
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
  if (data.method === "Target.detachedFromTarget" || data.method === "Target.targetDestroyed") {
    const targetId = data.params?.targetId || data.params?.targetInfo?.targetId;
    if (targetId && targetId === state.sessionTargetId) {
      invalidateSession();
    }
  }
  events.push(data);
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
    refMap.add(String(ref.backendNodeId), ref.backendNodeId, ref.role, ref.name, undefined);
  }
}
