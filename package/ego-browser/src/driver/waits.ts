import { state } from "../state.js";
import { cdp } from "../cdp-eval.js";
import { resolveHandle, releaseHandle } from "./element-ops.js";
import { ElementResolutionError } from "../element-resolver.js";
import { type WaitForLoadOptions, waitForDocumentLoad } from "./load.js";
import { drainEvents } from "./observe.js";
import {
  ensureNetworkTracking,
  ensureSession,
  isCdpRequestTimeoutError,
  isBrowserRuntime,
  isSessionLostError,
  networkActivity,
  pageNetworkSessions,
} from "../browser-runtime.js";

type WaitForElementOptions = {
  timeout?: number;
  visible?: boolean;
};

type WaitForNetworkIdleOptions = {
  timeout?: number;
  idleMs?: number;
};

/**
 * Sleep for a fixed number of seconds.
 * @param {number} [seconds=1.0] Seconds to wait.
 * @returns {Promise<void>}
 */
export async function wait(seconds = 1.0) {
  await state.sleep(seconds * 1000);
}

/**
 * Wait until document.readyState is complete.
 * @param {{timeout?: number}} [options]
 * @returns {Promise<boolean>} True when loaded before timeout.
 */
export async function waitForLoad(options: WaitForLoadOptions = {}) {
  return waitForDocumentLoad(options);
}

/**
 * Wait until an element exists, optionally requiring visibility.
 * @param {string} selector CSS selector / @ref / loc= / xpath= to poll.
 * @param {{timeout?: number, visible?: boolean}} [options]
 * @returns {Promise<boolean>} True when found before timeout.
 */
export async function waitForElement(
  selector: string,
  options: WaitForElementOptions = {},
) {
  const timeout = options.timeout ?? 10.0;
  const visible = options.visible ?? false;
  const deadline = state.now() + timeout * 1000;
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
      if (!visible) return true;
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
 * Wait until network events are idle.
 * In the browser runtime this reads the continuous, Page-scoped tracker without
 * consuming public events. Compatibility adapters retain the legacy temporary
 * Network-domain observation and best-effort fallback.
 * @param {{timeout?: number, idleMs?: number}} [options]
 * @returns {Promise<boolean>} True when idle before timeout.
 */
export async function waitForNetworkIdle(
  options: WaitForNetworkIdleOptions = {},
) {
  const timeout = options.timeout ?? 10.0;
  const idleMs = options.idleMs ?? 500;
  const deadline = state.now() + timeout * 1000;
  if (isBrowserRuntime()) {
    return waitForBrowserNetworkIdle(deadline, idleMs);
  }

  return waitForLegacyNetworkIdle(deadline, idleMs);
}

async function waitForBrowserNetworkIdle(
  deadline: number,
  idleMs: number,
): Promise<boolean> {
  const sessionId = await ensureSession(
    undefined,
    Math.max(1, deadline - state.now()),
  );
  let hasTracked = false;
  while (state.now() < deadline) {
    try {
      const sessionIds = await pageNetworkSessions(
        sessionId,
        Math.max(1, deadline - state.now()),
      );
      await ensureNetworkTracking(
        sessionIds,
        Math.max(1, deadline - state.now()),
      );
      const activity = networkActivity(sessionIds);
      hasTracked ||= activity.tracking;
      if (
        activity.tracking &&
        activity.inflight === 0 &&
        state.now() - activity.lastActivityAt >= idleMs
      ) {
        return true;
      }
    } catch (error) {
      if (!hasTracked && isUnsupportedNetworkTrackingError(error)) {
        return waitForPassiveIdle(deadline, idleMs);
      }
      if (!isRetryableNetworkRefreshError(error)) throw error;
      // A frame can detach while its sessions are refreshed. Once real
      // tracking has started, retry instead of converting uncertainty to idle.
    }
    const remaining = deadline - state.now();
    if (remaining <= 0) break;
    await state.sleep(Math.min(100, remaining));
  }
  return false;
}

function isUnsupportedNetworkTrackingError(error: unknown): boolean {
  return /Network\.enable.*(?:not found|wasn't found|unsupported|unknown method)/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

function isRetryableNetworkRefreshError(error: unknown): boolean {
  if (isCdpRequestTimeoutError(error) || isSessionLostError(error)) return true;
  return /detached Page session/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

async function waitForPassiveIdle(
  deadline: number,
  idleMs: number,
): Promise<boolean> {
  const remaining = deadline - state.now();
  if (remaining < idleMs) return false;
  await state.sleep(idleMs);
  return true;
}

async function waitForLegacyNetworkIdle(
  deadline: number,
  idleMs: number,
): Promise<boolean> {
  let lastActivity = state.now();
  const inflight = new Set();
  const ownsNetworkDomain = !state.networkDomainEnabled;
  await cdp("Network.enable").catch(() => {
    // Domain may be unsupported by the bridge; fall back to passive observation.
  });
  try {
    while (state.now() < deadline) {
      const events = await drainEvents();
      for (const event of events) {
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
    if (ownsNetworkDomain) {
      await cdp("Network.disable").catch(() => {
        // Best-effort cleanup; keeps the event buffer from accumulating after the wait.
      });
    }
  }
}
