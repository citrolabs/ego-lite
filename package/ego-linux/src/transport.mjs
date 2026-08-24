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
  let mouseWatcher = null;
  // Sessions the shim opened for its own reads. Their events belong to the
  // shim, not to the harness.
  const shimSessions = new Set();
  const shimEvents = new Map();
  let keyWatcher = null;
  let navWatcher = null;
  let viewportWatcher = null;
  let downloadContextResolver = null;

  /** Track which tab the harness last brought to the front, and which it drives. */
  function noteActivation(payload) {
    try {
      const message = JSON.parse(payload);
      if (message.method === "Input.dispatchMouseEvent") {
        // Where the agent's pointer actually is. The harness announces intent
        // through ego.animationHighlightMouseToPosition, but only these carry
        // the drag path and the press itself, which is what the cursor overlay
        // needs to look like a hand on the mouse rather than a teleport.
        mouseWatcher?.(message.params || {});
      } else if (
        message.method === "Input.dispatchKeyEvent" ||
        message.method === "Input.insertText"
      ) {
        // Typing is the one thing an agent does that leaves no trace until the
        // text appears. Both paths matter: keystrokes and fill()'s bulk insert.
        keyWatcher?.(message.params || {});
      } else if (message.method === "Page.navigate" && message.params?.url) {
        // Whether a space ever held a real page can only be seen as it happens:
        // a tab is about:blank again the moment it navigates away, so polling
        // its url later cannot tell "never used" from "between pages".
        if (message.params.url !== "about:blank") navWatcher?.(message.params.url);
      } else if (message.method === "Emulation.setDeviceMetricsOverride") {
        // Emulation resizes the page's viewport, never the OS window — so a
        // mobile layout renders as a narrow strip inside a desktop-sized window.
        viewportWatcher?.(message.params || {});
      } else if (message.method === "Emulation.clearDeviceMetricsOverride") {
        // Explicitly the other half: leaving emulation has to put the window
        // back, or it stays phone-shaped for the rest of the session.
        viewportWatcher?.({ width: 0, height: 0 });
      } else if (message.method === "Target.activateTarget" && message.params?.targetId) {
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

    // Events from a session the shim opened are the shim's business. Forwarding
    // them would push them into the harness's event buffer, where drainEvents()
    // hands them to the agent — a screencast alone would bury a task's real
    // events under dozens of frames a second.
    if (data.sessionId && shimSessions.has(data.sessionId)) {
      shimEvents.get(data.method)?.(data.params || {}, data.sessionId);
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

  /**
   * Point the harness's download setup at the space the agent is working in.
   *
   * Browser.setDownloadBehavior with no browserContextId configures the DEFAULT
   * context. That was right when a task space was a plain window, but a space
   * now owns its own context — so the harness's call, which cannot know that,
   * would arm downloads on a context nothing is downloading in. No
   * Page.downloadWillBegin ever fires and page.waitForEvent("download") hangs
   * until it times out.
   *
   * Rewriting on the way out keeps the harness unmodified and keeps the
   * download path the harness chose, which download.path() then reads from.
   */
  function aimDownloadsAtCurrentSpace(payload) {
    if (!downloadContextResolver) return payload;
    if (!payload.includes("Browser.setDownloadBehavior")) return payload;
    try {
      const message = JSON.parse(payload);
      if (message.method !== "Browser.setDownloadBehavior") return payload;
      if (message.params?.browserContextId) return payload;
      const browserContextId = downloadContextResolver();
      if (!browserContextId) return payload;
      return JSON.stringify({
        ...message,
        params: { ...message.params, browserContextId },
      });
    } catch {
      // A payload we cannot parse is one we have no business rewriting.
      return payload;
    }
  }

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
      socket.send(aimDownloadsAtCurrentSpace(payload));
    },

    /**
     * Tell the transport which browser context downloads should be armed for.
     * Set by the shim to the selected task space; see the rewrite below.
     */
    setDownloadContext(resolver) {
      downloadContextResolver = resolver;
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

    /**
     * Observe the harness's mouse input as it goes out. Read-only: the callback
     * runs before the send and its errors are swallowed by noteActivation's
     * catch, so a watcher can never hold up or fail an action.
     */
    watchMouse(handler) {
      mouseWatcher = handler;
    },

    /** Observe the harness's keyboard input, on the same read-only terms. */
    watchKeys(handler) {
      keyWatcher = handler;
    },

    /**
     * Claim a session the shim opened, so its events stop at the shim.
     * Sessions the harness opens are untouched and keep flowing to it.
     */
    claimSession(sessionId) {
      if (sessionId) shimSessions.add(sessionId);
    },

    releaseSession(sessionId) {
      shimSessions.delete(sessionId);
    },

    /** Handle one CDP event method arriving on a claimed session. */
    onShimEvent(method, handler) {
      shimEvents.set(method, handler);
    },

    /** Observe viewport emulation, on the same read-only terms. */
    watchViewport(handler) {
      viewportWatcher = handler;
    },

    /** Observe navigations to real pages, on the same read-only terms. */
    watchNavigation(handler) {
      navWatcher = handler;
    },

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
