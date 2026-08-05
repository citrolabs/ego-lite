/**
 * CDP transport, shared between the harness and this shim.
 *
 * The harness talks to the native layer through exactly three members
 * (see package/ego-browser/src/browser-runtime.ts):
 *
 *   ego.sendCDPMessage(jsonString)   — a serialized { id, method, params, sessionId? }
 *   ego.onCDPMessage(jsonString)     — a raw protocol message, parsed by handleMessage
 *   ego.onSendCDPMessageError(msg, code)
 *
 * Chrome's browser-level WebSocket speaks that exact wire format when sessions
 * are attached with `flatten: true` (which ensureSession() does), so harness
 * traffic is a straight passthrough.
 *
 * The shim also needs its own calls (Target.getTargets for listTabs, the
 * snapshot's DOM walk, ...). Both parties share one socket, so request ids are
 * partitioned: the harness counts up from 1, the shim from INTERNAL_ID_BASE.
 * Responses to shim ids are consumed here and never reach the harness, which
 * would otherwise see ids it has no pending entry for.
 */

const OPEN_TIMEOUT_MS = 10000;
const CALL_TIMEOUT_MS = 30000;
const INTERNAL_ID_BASE = 1_000_000;

export async function connectCdp(wsUrl) {
  const socket = new WebSocket(wsUrl);
  socket.binaryType = "arraybuffer";

  const internalPending = new Map();
  let nextInternalId = INTERNAL_ID_BASE;
  let runtime = null;
  let closed = false;
  let activeTargetId = null;
  let attachedTargetId = null;

  /** Track which tab the harness last brought to the front, and which it drives. */
  function noteActivation(payload) {
    try {
      const message = JSON.parse(payload);
      if (message.method === "Target.activateTarget" && message.params?.targetId) {
        activeTargetId = message.params.targetId;
      } else if (message.method === "Target.attachToTarget" && message.params?.targetId) {
        // ensureSession() attaches to whatever the harness considers current —
        // its preferredTargetId, which the shim cannot see any other way. The
        // shim's own page reads (snapshot) must target the same tab, or the
        // agent observes one page while acting on another.
        attachedTargetId = message.params.targetId;
      } else if (
        message.method === "Target.closeTarget" &&
        message.params?.targetId === activeTargetId
      ) {
        activeTargetId = null;
      }
    } catch {
      // Not our concern: the send itself is what matters.
    }
  }

  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`CDP WebSocket did not open within ${OPEN_TIMEOUT_MS}ms`)),
      OPEN_TIMEOUT_MS,
    );
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error(`failed to connect to CDP endpoint: ${wsUrl}`));
      },
      { once: true },
    );
  });

  socket.addEventListener("message", (event) => {
    const text =
      typeof event.data === "string"
        ? event.data
        : new TextDecoder().decode(event.data);

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return;
    }

    if (typeof data.id === "number" && data.id >= INTERNAL_ID_BASE) {
      const entry = internalPending.get(data.id);
      if (!entry) return;
      internalPending.delete(data.id);
      clearTimeout(entry.timer);
      if (data.error) {
        entry.reject(new Error(data.error.message || JSON.stringify(data.error)));
      } else {
        entry.resolve(data.result ?? {});
      }
      return;
    }

    runtime?.onCDPMessage?.(text);
  });

  socket.addEventListener("close", () => {
    closed = true;
    for (const entry of internalPending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("browser connection closed"));
    }
    internalPending.clear();
    // Mirrors the native bridge's task-level failure: every in-flight harness
    // request fails the same way, so they are all rejected at once.
    runtime?.onSendCDPMessageError?.(
      "browser connection closed",
      "EGO_CDP_CHANNEL_UNAVAILABLE",
    );
  });

  function assertOpen() {
    if (closed || socket.readyState !== WebSocket.OPEN) {
      throw new Error("CDP channel is not open");
    }
  }

  return {
    /** Raw passthrough for harness-authored payloads (ids below the shim's base). */
    sendRaw(payload) {
      assertOpen();
      noteActivation(payload);
      socket.send(payload);
    },

    /**
     * The last target the harness explicitly activated, or null.
     * CDP cannot be asked which tab is focused, so the authoritative signal is
     * the harness's own Target.activateTarget call (what browser.switchTab and
     * openOrReuseTab issue). Without this, currentTab() does not follow
     * switchTab() and every helper that reads "the active tab" drifts.
     */
    activeHint: () => activeTargetId,

    /** The target the harness's own CDP session is attached to, or null. */
    attachedHint: () => attachedTargetId,

    /** The shim's own request/response calls. */
    call(method, params = {}, sessionId = undefined) {
      assertOpen();
      if (method === "Target.activateTarget" && params.targetId) {
        activeTargetId = params.targetId;
      }
      const id = ++nextInternalId;
      const payload = JSON.stringify({
        id,
        method,
        params,
        ...(sessionId ? { sessionId } : {}),
      });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          internalPending.delete(id);
          reject(new Error(`CDP request timed out: ${method}`));
        }, CALL_TIMEOUT_MS);
        internalPending.set(id, { resolve, reject, timer });
        try {
          socket.send(payload);
        } catch (error) {
          clearTimeout(timer);
          internalPending.delete(id);
          reject(error);
        }
      });
    },

    /** Route protocol traffic into the harness once its callbacks are installed. */
    bind(egoRuntime) {
      runtime = egoRuntime;
    },

    close() {
      runtime = null;
      try {
        socket.close();
      } catch {
        // already gone
      }
    },
  };
}
