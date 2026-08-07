import { createSessionResolver } from "./session.mjs";

/**
 * The agent's cursor — the visible "something else is driving this page" mark.
 *
 * The native macOS app draws this itself, over the web view; on Linux the page
 * is the only surface the shim controls, so the cursor is a DOM overlay
 * injected into whichever page the harness is currently acting on. It follows
 * every pointer position the harness sends, presses and springs back when a
 * button goes down and up, ripples where it clicks, sweeps the lines it reads,
 * and carries the agent's current task state as a label.
 *
 * Two properties keep it from interfering with the automation it illustrates:
 *
 *   - the host element is `pointer-events: none`, so `document.elementFromPoint`
 *     never returns it. That matters beyond cosmetics: the harness's wheel and
 *     drag fallbacks hit-test with elementFromPoint, and an overlay that
 *     answered those probes would swallow input meant for the page.
 *   - every render is fire-and-forget and swallows its own errors, so a page
 *     that refuses the injection, or navigates mid-flight, can never fail an
 *     action. The cursor is allowed to be missing; it is not allowed to break
 *     anything.
 *
 * The overlay is a Runtime.evaluate injection rather than a content script, so
 * it works on pages with a strict CSP and needs no extension.
 *
 * Env: EGO_LINUX_CURSOR=0 turns it off (it is drawn into screenshots, which is
 * usually wanted and occasionally not); EGO_LINUX_CURSOR_NAME renames it from
 * the default "Claude".
 */

const HOST_ID = "ego-agent-cursor-overlay";
const ACCENT = "#d97757";
// Reading is where an agent spends most of its time, and the state a watcher is
// likeliest to mistake for an idle window. Giving it its own colour means one
// glance separates looking at the page from changing it — terracotta acts, blue
// observes. Every mark the overlay draws while reading switches to this, and
// switches back the moment real input lands.
const READ_ACCENT = "#4a9eff";

/** How long the pressed look is held, however briefly the button was down. */
const MIN_PRESS_MS = 130;

/** Keystrokes stop arriving well before the agent is done thinking; hold on. */
const TYPING_IDLE_MS = 700;

export function createCursorApi(cdp, { listTabs }) {
  const enabled = process.env.EGO_LINUX_CURSOR !== "0";
  const name = process.env.EGO_LINUX_CURSOR_NAME || "Claude";
  const sessionForActiveTab = createSessionResolver(cdp, {
    listTabs,
    op: "cursor",
  });

  const state = {
    x: 0,
    y: 0,
    label: "",
    visible: true,
    placed: false,
    pressed: false,
    typing: false,
    note: "",
    highlight: null,
    read: null,
  };
  // Where the cursor rests on a page it has only read, never touched.
  const RESTING_X = 28;
  const RESTING_Y = 28;
  let previousLabel = "";
  let dirty = false;
  let pendingPulse = false;
  let inFlight = false;
  let pressedAt = 0;
  let releaseTimer = null;
  let typingTimer = null;
  let labelX = null;
  let labelY = null;
  let highlightId = 0;
  let readId = 0;

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Put the overlay back after the page it lived in was replaced.
   *
   * The cursor is a DOM node injected into the current document, so a
   * navigation destroys it — and nothing re-injects. Only a render does that,
   * and renders are driven by snapshots, pointer events and keystrokes, none of
   * which a goto() performs. So an agent that navigated and then worked through
   * page.evaluate or a site tool — neither of which snapshots — drove the page
   * with no cursor on screen at all, which reads as an idle window.
   *
   * The old coordinates described elements in a document that no longer exists,
   * so re-drawing at them would point confidently at nothing. The cursor goes
   * back to its resting corner instead and lets the badge carry what the agent
   * is doing; the label is already marked stale by the move, so it presents
   * itself as history rather than as the current action.
   */
  function pageReplaced() {
    if (!enabled) return;
    endRead();
    state.x = RESTING_X;
    state.y = RESTING_Y;
    state.placed = true;
    schedule();
  }

  // Events only reach the shim for sessions it has claimed, and only for domains
  // enabled on them — see claimSession/onShimEvent in transport.mjs. Registered
  // once here; flush() does the per-session claim as targets come and go.
  cdp.onShimEvent?.("Page.loadEventFired", () => pageReplaced());

  /** Sessions already claimed and told to report loads. */
  const watchedSessions = new Set();

  async function watchLoads(sessionId) {
    if (!sessionId || watchedSessions.has(sessionId)) return;
    watchedSessions.add(sessionId);
    cdp.claimSession?.(sessionId);
    // Without Page.enable the load event never fires on this session. Failure is
    // cosmetic, exactly like every other render step here.
    await cdp.call("Page.enable", {}, sessionId).catch(() => {});
  }

  /**
   * A read sweep narrates the snapshot that started it, so any real input makes
   * it stale. Dropping the read from the payload is how the page is told to stop
   * — the sweep owns the cursor only while the id it began with keeps arriving.
   */
  function endRead() {
    state.read = null;
  }

  function placeAt(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    state.x = x;
    state.y = y;
    state.placed = true;
  }

  /**
   * Coalesce renders: a drag dispatches mouse moves far faster than a CDP round
   * trip completes, so only the latest position is ever sent, and a pulse that
   * lands mid-flight is carried over to the next render rather than dropped.
   */
  function schedule() {
    dirty = true;
    if (inFlight) return;
    void flush();
  }

  async function flush() {
    if (!dirty || inFlight) return;
    inFlight = true;
    try {
      while (dirty) {
        dirty = false;
        const payload = {
          x: state.x,
          y: state.y,
          // The label always goes out, so the badge never empties mid-session —
          // a blank badge tells a watcher less than a slightly old one. Whether
          // it still describes where the cursor now is travels alongside it, and
          // the overlay dims a stale label rather than passing it off as current.
          label: state.label,
          labelStale: !(state.x === labelX && state.y === labelY),
          name,
          accent: ACCENT,
          readAccent: READ_ACCENT,
          hostId: HOST_ID,
          // Typing counts as something to show even before the cursor has been
          // placed, because fill() never places it.
          visible: state.visible && (state.placed || state.typing),
          placed: state.placed,
          pressed: state.pressed,
          typing: state.typing,
          note: state.note,
          highlight: state.highlight,
          read: state.read,
          pulse: pendingPulse,
        };
        pendingPulse = false;
        const sessionId = await sessionForActiveTab();
        await watchLoads(sessionId);
        await cdp.call(
          "Runtime.evaluate",
          {
            expression: `(${renderOverlay.toString()})(${JSON.stringify(payload)})`,
            returnByValue: false,
            awaitPromise: false,
            userGesture: false,
          },
          sessionId,
        );
      }
    } catch {
      // Cosmetic only: a closed tab, a page mid-navigation or a target that
      // rejected the evaluate must never surface as an automation failure.
    } finally {
      inFlight = false;
      if (dirty) void flush();
    }
  }

  return {
    /**
     * Arm the load watcher ahead of a navigation the overlay has to survive.
     *
     * flush() claims the session as a side effect of rendering, so a process
     * whose very first act is a goto has claimed nothing yet and misses its own
     * first load — leaving the window blank for exactly the shape of task that
     * navigates and then works through page.evaluate or a site tool. Called on
     * Page.navigate, which the harness sends before the document is replaced.
     */
    async watchPage() {
      if (!enabled) return { done: false, reason: "cursor disabled" };
      try {
        await watchLoads(await sessionForActiveTab());
      } catch {
        // No tab yet, or a target that refused the attach: cosmetic, like every
        // other step here.
      }
      return { done: true };
    },

    /** Back ego.animationHighlightMouseToPosition(x, y). */
    moveTo(x, y) {
      if (!enabled) return { done: false, reason: "cursor disabled" };
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { done: false };
      // A redundant move is normally worth nothing, but a read sweep has walked
      // the cursor away from where the harness last put it — so moving back to
      // that same point is a real move, and the one that ends the sweep.
      if (state.placed && state.x === x && state.y === y && !state.read) {
        return { done: true };
      }
      endRead();
      state.x = x;
      state.y = y;
      state.placed = true;
      // The label is no longer blanked here: it stays up, marked stale, until a
      // real action replaces it. Emptying it on every move is what made the
      // badge flicker on a page the agent was only walking across.
      schedule();
      return { done: true };
    },

    /**
     * The agent is reading the page rather than touching it.
     *
     * Reading is most of what an agent does — open a page, snapshot it, decide —
     * and none of it dispatches a pointer event, so until now the overlay simply
     * never appeared: watching a session work looked like nothing was happening.
     * Placing the cursor on the first read gives the badge (which already
     * breathes) something to attach to, so reading reads as activity.
     *
     * The resting spot is only used when no click has placed the cursor yet; a
     * cursor that has been somewhere stays there, because jumping it to a corner
     * on every snapshot would lose where the agent actually was.
     *
     * The badge alone said the agent was reading but never *what*, which is the
     * one thing a person watching wants to know — so each read also carries an
     * id, and the page runs a sweep for it: the cursor travels the lines that
     * are actually on screen, marking each as it passes. The sweep is driven
     * from inside the page, because a round trip per line would cost more than
     * the snapshot it illustrates.
     */
    reading(label = "reading") {
      if (!enabled) return { done: false, reason: "cursor disabled" };
      if (!state.placed) {
        state.x = RESTING_X;
        state.y = RESTING_Y;
        state.placed = true;
      }
      previousLabel = state.label;
      if (state.label !== label) state.label = label;
      readId += 1;
      state.read = { id: readId };
      schedule();
      return { done: true };
    },

    /**
     * The label persists until a different activity replaces it.
     *
     * A snapshot completes in milliseconds, so clearing the label when the read
     * returned made "reading" flash for less than a frame — the badge just read
     * "Claude". Leaving it up means the window always says what the agent last
     * did, which is what makes an idle-looking window legible. moveTo and
     * pulseAt take it down again when real input arrives.
     */
    clearReadingLabel() {
      if (state.label !== "reading") return;
      state.label = previousLabel === "reading" ? "" : previousLabel || "";
      schedule();
    },

    /** Back ego.setAgentTaskState(label) — the text shown next to the cursor. */

    /**
     * Back ego.setAgentTaskState(label).
     *
     * The harness sets this from an action's own `label` option, immediately
     * after moving the cursor there — so it describes *that* action, at *that*
     * point. It is therefore remembered against the point it was set for, and
     * stops applying once the cursor moves on. Without that it would be set
     * once and then narrate every later action wrongly, forever.
     */
    setTaskState(taskState) {
      if (!enabled) return { done: false, reason: "cursor disabled" };
      const label = labelOf(taskState);
      if (label === state.label && labelX === state.x && labelY === state.y) {
        return { done: true };
      }
      state.label = label;
      labelX = state.x;
      labelY = state.y;
      schedule();
      return { done: true };
    },

    /** A button went down here: hold the cursor pressed, and ripple. */
    press(x, y) {
      if (!enabled) return;
      endRead();
      placeAt(x, y);
      clearTimeout(releaseTimer);
      state.pressed = true;
      pressedAt = Date.now();
      pendingPulse = true;
      schedule();
    },

    /**
     * The button came back up. A click's press and release are 25ms apart, which
     * is too short to read as anything, so the pressed look is held for a floor
     * of MIN_PRESS_MS. A drag releases long after that floor and springs back at
     * once.
     */
    release(x, y) {
      if (!enabled) return;
      endRead();
      placeAt(x, y);
      if (!state.pressed) {
        schedule();
        return;
      }
      const remaining = MIN_PRESS_MS - (Date.now() - pressedAt);
      if (remaining <= 0) {
        state.pressed = false;
        schedule();
        return;
      }
      schedule(); // the new position now; the spring back on its own schedule
      clearTimeout(releaseTimer);
      releaseTimer = setTimeout(() => {
        state.pressed = false;
        schedule();
      }, remaining);
      // A heredoc is a short-lived process; never hold it open for a flourish.
      releaseTimer.unref?.();
    },

    /**
     * A key went to the page. Typing has no coordinates, so this is a state
     * with a tail rather than an event: it stays on until the keystrokes stop.
     * Called per key event, but the render coalescer collapses a burst into a
     * couple of draws, and re-drawing is what lets the ring follow focus from
     * one field to the next.
     */
    typed() {
      if (!enabled) return;
      endRead();
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => {
        state.typing = false;
        schedule();
      }, TYPING_IDLE_MS);
      typingTimer.unref?.();
      state.typing = true;
      schedule();
    },

    /**
     * Draw a marker over some text, the way you would to explain it.
     *
     * `target` is a CSS selector, or the text itself — a string is tried as a
     * selector first and searched for as text if that finds nothing, so both
     * `highlight("#total")` and `highlight("free shipping")` do the obvious
     * thing. `{selector}` or `{text}` forces one.
     *
     * The bands are an overlay, never a real selection: selecting text for the
     * look of it would fight the agent's own work on the page.
     *
     * @param {string|{selector?: string, text?: string}} target
     * @param {{note?: string}} [options] Text to show next to the cursor while drawing.
     * @returns {Promise<{done: boolean, lines: number}>}
     */
    async highlight(target, options = {}) {
      if (!enabled) return { done: false, lines: 0, reason: "cursor disabled" };
      const request =
        typeof target === "string"
          ? { selector: target, text: target }
          : { selector: target?.selector || "", text: target?.text || "" };

      let found;
      try {
        const sessionId = await sessionForActiveTab();
        const { result } = await cdp.call(
          "Runtime.evaluate",
          {
            expression: `(${resolveHighlight.toString()})(${JSON.stringify(request)})`,
            returnByValue: true,
            awaitPromise: false,
          },
          sessionId,
        );
        found = result?.value;
      } catch {
        return { done: false, lines: 0 };
      }
      if (!found || !found.rects?.length) return { done: false, lines: 0 };

      // An explicit marker replaces the automatic sweep: both drive the cursor,
      // and the agent's own explanation is the one worth watching.
      endRead();
      state.note = String(options.note ?? "").slice(0, 120);
      highlightId += 1;
      state.highlight = { id: highlightId, rects: found.rects, upTo: -1 };

      // Walk the cursor along each line as its band draws, so the marker looks
      // drawn rather than pasted. The caller awaits this: it is an explanation,
      // and an explanation you cannot see happen is just a screenshot.
      for (let index = 0; index < found.rects.length; index += 1) {
        const rect = found.rects[index];
        const baseline = rect.y + rect.height - found.scrollY;
        state.x = rect.x - found.scrollX;
        state.y = baseline;
        state.placed = true;
        state.highlight.upTo = index;
        schedule();
        await wait(Math.round(rect.ms * 0.2));
        state.x = rect.x + rect.width - found.scrollX;
        state.y = baseline;
        schedule();
        await wait(rect.ms);
      }
      return { done: true, lines: found.rects.length };
    },

    /** Wipe the marker off again. */
    clearHighlight() {
      if (!enabled) return { done: false, reason: "cursor disabled" };
      state.highlight = null;
      state.note = "";
      schedule();
      return { done: true };
    },

    /** Hidden while the space belongs to the user (handOffTaskSpace). */
    hide() {
      if (!enabled) return;
      if (!state.visible) return;
      state.visible = false;
      schedule();
    },

    /** Shown again when the agent resumes (takeOverTaskSpace). */
    show() {
      if (!enabled) return;
      if (state.visible) return;
      state.visible = true;
      schedule();
    },
  };
}

/**
 * Find what to draw the marker over, and measure it line by line.
 *
 * Serialized into the page like the renderer. A Range is what gives one box per
 * *line* rather than one for the whole paragraph — which is the difference
 * between a pen stroke and a coloured rectangle.
 */
function resolveHighlight(request) {
  let range = null;

  if (request.selector) {
    let element = null;
    try {
      element = document.querySelector(request.selector);
    } catch {
      element = null; // a text query is rarely also valid CSS
    }
    if (element) {
      range = document.createRange();
      range.selectNodeContents(element);
    }
  }

  if (!range && request.text) {
    const needle = request.text.trim().toLowerCase();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!parent || !parent.getClientRects().length) continue;
      const at = (node.nodeValue || "").toLowerCase().indexOf(needle);
      if (at === -1) continue;
      range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      break;
    }
  }

  if (!range) return { rects: [], scrollX: window.scrollX, scrollY: window.scrollY };

  // A marker nobody can see explains nothing, so bring it on screen first.
  const first = range.getBoundingClientRect();
  if (first.bottom < 0 || first.top > window.innerHeight) {
    const anchor = range.startContainer.parentElement;
    anchor?.scrollIntoView({ block: "center" });
  }

  const rects = [];
  for (const rect of range.getClientRects()) {
    if (rect.width < 2 || rect.height < 2) continue;
    rects.push({
      x: rect.left + window.scrollX,
      y: rect.top + window.scrollY,
      width: rect.width,
      height: rect.height,
      // Long lines take longer to draw, the way a real stroke would.
      ms: Math.min(700, Math.max(160, Math.round(rect.width * 1.7))),
    });
  }
  return { rects, scrollX: window.scrollX, scrollY: window.scrollY };
}

/**
 * Read the overlay back out of a page: where the cursor is, what it is doing,
 * and how long ago it last moved. The Spaces overview runs this in its own
 * process — the page is the only state the two share, since each heredoc is a
 * separate Node process with its own CDP connection.
 *
 * Returns null when no agent has acted in that page.
 */
export const CURSOR_PROBE_EXPRESSION = `(${probeOverlay.toString()})(${JSON.stringify(HOST_ID)})`;

function probeOverlay(hostId) {
  const host = document.getElementById(hostId);
  const state = host && host.__egoState;
  if (!state) return null;
  return {
    // Where the cursor is *now*: it is anchored to the page, so a scroll since
    // the last action has moved it on screen. Reporting the stale viewport
    // position would crop an active card to the wrong place.
    x: state.pageX - window.scrollX,
    y: state.pageY - window.scrollY,
    label: state.label || "",
    name: state.name || "",
    ageMs: Date.now() - state.at,
    // Newest last, ages rather than timestamps: the reader is in another
    // process and has no business trusting this page's clock.
    trail: (host.__egoLog || []).map((entry) => ({
      text: entry.text,
      ageMs: Date.now() - entry.at,
    })),
    // A screenshot clip is in page coordinates; hand back what converts it.
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  };
}

/**
 * The harness passes a label string, but the native surface is documented only
 * as "task state" — accept the object form rather than printing [object Object].
 */
function labelOf(taskState) {
  if (taskState === null || taskState === undefined) return "";
  if (typeof taskState === "string") return taskState.slice(0, 120);
  if (typeof taskState === "object") {
    const text = taskState.label ?? taskState.state ?? taskState.text;
    return typeof text === "string" ? text.slice(0, 120) : "";
  }
  return String(taskState).slice(0, 120);
}

/**
 * The overlay itself, serialized with Function.prototype.toString() and run
 * inside the page on every update. It must stay self-contained: no imports, no
 * closure over anything in this module, and idempotent — it is re-entered for
 * every move, and re-creates itself after a navigation blew the old one away.
 */
function renderOverlay(payload) {
  const parent = document.body || document.documentElement;
  if (!parent) return;

  let host = document.getElementById(payload.hostId);
  if (!payload.visible) {
    // Handing the space back is a departure, not a disappearance, so the cursor
    // fades instead of blinking out. The state the Spaces overview polls goes
    // immediately though: the agent has let go, whatever the pixels still say.
    if (host && !host.__egoLeaving) {
      host.__egoLeaving = true;
      host.__egoState = null;
      if (host.__egoSweep) host.__egoSweep.done = true;
      host.style.opacity = "0";
      setTimeout(() => host.remove(), 220);
    }
    return;
  }

  // A host on its way out is not one to reuse: its opacity is already bound for
  // zero, and a taken-over space would inherit the fade meant for the handoff.
  if (host && host.__egoLeaving) {
    host.remove();
    host = null;
  }

  if (!host) {
    host = document.createElement("div");
    host.id = payload.hostId;
    host.setAttribute("aria-hidden", "true");
    // Inline, so page rules cannot win against it, and `pointer-events: none`
    // last so `all: initial` cannot reset it back to auto. Every child inherits
    // that, which is what keeps elementFromPoint blind to the overlay.
    host.style.cssText =
      "all:initial;position:fixed;left:0;top:0;width:0;height:0;" +
      "z-index:2147483647;pointer-events:none;" +
      // Arrives and leaves under its own power. The agent taking a page over is
      // an event worth seeing, and a cursor that pops into existence reads as a
      // rendering glitch rather than as something showing up.
      "opacity:0;transition:opacity 200ms ease;";
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML =
      "<style>" +
      // The cursor is anchored to the page, not the screen: it marks the thing
      // the agent is working on, so it has to travel with that thing when the
      // page scrolls. #layer carries the scroll offset with no transition of
      // its own, leaving #pointer's transition free to animate agent movement —
      // one element carrying both would make scrolling look rubbery.
      "#layer{position:absolute;left:0;top:0}" +
      // Marker bands, one per line of text, drawn in page coordinates so they
      // stay on their words when the page scrolls. Each wipes in from its own
      // left edge — a pen stroke, not a rectangle appearing.
      "#bands{position:absolute;left:0;top:0}" +
      ".band{position:absolute;left:0;top:0;width:0;border-radius:3px;" +
      "background:linear-gradient(180deg,rgba(217,119,87,.34),rgba(217,119,87,.22));" +
      "box-shadow:0 0 0 1px rgba(217,119,87,.22);" +
      "transition:width 260ms cubic-bezier(.33,.9,.5,1)}" +
      // A read band is the same stroke, lighter and temporary: reading is
      // constant, so its marks fade behind the cursor instead of piling up the
      // way a deliberate highlight does.
      ".band.read{background:linear-gradient(180deg,rgba(74,158,255,.32),rgba(74,158,255,.16));" +
      "box-shadow:none;transition-property:width,opacity;transition-timing-function:linear}" +
      // While reading, every mark the overlay owns turns blue: the arrow, the
      // ring, the badge's dot. The rules are scoped to #layer.reading so the
      // whole scheme reverts in one class toggle when input arrives.
      "#layer.reading #arrow path,#layer.reading #hand path{fill:" +
      payload.readAccent +
      "}" +
      "#layer.reading #ring{border-color:" +
      payload.readAccent +
      ";box-shadow:0 0 0 4px rgba(74,158,255,.18)}" +
      "#layer.reading #dot{background:" +
      payload.readAccent +
      "}" +
      // A label that no longer describes where the cursor is stays legible but
      // stops competing with one that does — and its dot stops breathing,
      // because breathing is what marks the badge as live.
      "#badge.stale{opacity:.5}" +
      "#badge.stale #dot{animation:none;opacity:.35}" +
      "#pointer{position:absolute;left:0;top:0;" +
      "transition:transform 200ms cubic-bezier(.22,.61,.36,1);will-change:transform}" +
      "#ring{position:absolute;left:0;top:0;border:2px solid " +
      payload.accent +
      ";border-radius:7px;box-shadow:0 0 0 4px rgba(217,119,87,.18);opacity:0;" +
      "transition:opacity 160ms ease,transform 200ms cubic-bezier(.22,.61,.36,1)," +
      "width 200ms ease,height 200ms ease}" +
      "#ring.on{opacity:1}" +
      "#arrow{position:absolute;left:-1px;top:-1px;display:block;" +
      // Scaled about its own tip, so pressing squashes the arrow without
      // moving the point it is aiming at. Down is fast and flat; the spring
      // back overshoots, which is what makes it read as a button release.
      "transform-origin:2px 2px;" +
      "transition:transform 190ms cubic-bezier(.34,1.56,.64,1);" +
      "filter:drop-shadow(0 2px 5px rgba(0,0,0,.35))}" +
      "#pointer.press #arrow{transform:scale(.76);" +
      "transition:transform 70ms cubic-bezier(.4,0,1,1)}" +
      "#pulse{position:absolute;left:-19px;top:-19px;width:38px;height:38px;" +
      "border-radius:50%;border:2px solid " +
      payload.accent +
      ";opacity:0}" +
      "#pulse.on{animation:ego-pulse 500ms ease-out}" +
      "@keyframes ego-pulse{from{transform:scale(.2);opacity:.9}" +
      "to{transform:scale(1);opacity:0}}" +
      // Positioned by transform alone, in the page coordinates #layer works in.
      "#badge{position:absolute;left:0;top:0;display:flex;align-items:center;" +
      "gap:7px;max-width:300px;padding:5px 11px 5px 9px;border-radius:999px;" +
      "background:rgba(24,24,27,.72);color:#fff;box-sizing:border-box;" +
      // Frosted rather than flat: the badge sits over arbitrary pages, and one
      // that lets its background through belongs to the page it is labelling
      // instead of hovering over it as a second opaque card.
      "-webkit-backdrop-filter:blur(14px) saturate(1.5);" +
      "backdrop-filter:blur(14px) saturate(1.5);" +
      "border:1px solid rgba(255,255,255,.09);letter-spacing:.01em;" +
      "font:500 12px/1.35 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;" +
      "box-shadow:0 8px 24px rgba(0,0,0,.28),0 1px 2px rgba(0,0,0,.2);" +
      "transition:transform 200ms ease}" +
      // Docked, the badge is holding still against a moving page: every scroll
      // event rewrites its offset, and a transition would chase each one.
      "#badge.docked{transition:none}" +
      // Which way the cursor went, when it is no longer on screen to point at.
      "#hint{flex:none;opacity:.7;font-size:11px}" +
      "#hint:empty{display:none}" +
      "#text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
      "animation:ego-fade 220ms ease}" +
      "@keyframes ego-fade{from{opacity:.3}to{opacity:1}}" +
      "#dot{flex:none;width:7px;height:7px;border-radius:50%;background:" +
      payload.accent +
      ";animation:ego-breathe 1.7s ease-in-out infinite}" +
      "@keyframes ego-breathe{0%,100%{opacity:1}50%{opacity:.35}}" +
      // The reading glow. A sibling of #layer, not a child: #layer carries the
      // scroll offset as a transform, and a transformed ancestor would make
      // position:fixed resolve against it instead of the viewport — the glow
      // would then scroll away from the edges it is meant to trace.
      "#glow{position:fixed;left:0;top:0;right:0;bottom:0;opacity:0;" +
      "transition:opacity 260ms ease;" +
      "box-shadow:inset 0 0 0 2px rgba(74,158,255,.22)," +
      "inset 0 0 52px rgba(74,158,255,.13)}" +
      // Breathing at a slower beat than the badge dot, so the two read as one
      // system rather than as two things blinking out of step.
      "#glow.on{opacity:1;animation:ego-read-glow 2.4s ease-in-out infinite}" +
      "@keyframes ego-read-glow{0%,100%{opacity:1}50%{opacity:.5}}" +
      // The shape says what the cursor is over, the way a real one does: an
      // arrow on the page, a hand on anything clickable, a beam over text.
      "svg.shape{position:absolute;left:-1px;top:-1px;display:none}" +
      "svg.shape.on{display:block}" +
      "</style>" +
      '<div id="layer">' +
      '<div id="bands"></div>' +
      '<div id="ring"></div>' +
      '<div id="pointer">' +
      '<div id="pulse"></div>' +
      '<svg id="arrow" class="shape on" width="20" height="26" viewBox="-1.4 -1.4 17 24">' +
      '<path d="M0 0 L0 18.6 L4.6 14.3 L7.7 21.1 L11.1 19.5 L8 12.9 L13.9 12.5 Z" ' +
      'fill="' +
      payload.accent +
      '" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>' +
      '<svg id="hand" class="shape" width="23" height="26" viewBox="-1.4 -1.4 20 24">' +
      '<path d="M4.6 11.4 L4.6 2.4 A1.8 1.8 0 0 1 8.2 2.4 L8.2 9.4 L8.2 6.6 ' +
      "A1.7 1.7 0 0 1 11.6 6.6 L11.6 9.4 L11.6 7.6 A1.7 1.7 0 0 1 15 7.6 L15 9.6 " +
      "A1.7 1.7 0 0 1 18.4 9.9 L18.4 15.4 A5.6 5.6 0 0 1 12.8 21 L10.4 21 " +
      'A5.4 5.4 0 0 1 5.6 18.1 L2.2 13.4 A1.7 1.7 0 0 1 4.6 11.4 Z" ' +
      'fill="' +
      payload.accent +
      '" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>' +
      '<svg id="beam" class="shape" width="14" height="26" viewBox="-1.4 -1.4 12 24">' +
      '<path d="M1.6 1 H7.4 M4.5 1 V19.4 M1.6 19.4 H7.4" ' +
      'stroke="#fff" stroke-width="4.4" stroke-linecap="round" fill="none"/>' +
      '<path d="M1.6 1 H7.4 M4.5 1 V19.4 M1.6 19.4 H7.4" stroke="' +
      payload.accent +
      '" stroke-width="2" stroke-linecap="round" fill="none"/></svg>' +
      "</div>" +
      // A sibling of #pointer rather than a child of it. The badge has to stay
      // readable exactly when the cursor has scrolled out of view, and a child
      // of something parked far off screen is at the mercy of whether that
      // layer gets drawn at all. Still inside #layer, though: everything the
      // overlay draws shares one coordinate space, and a screenshot treats the
      // whole subtree alike only while that stays true.
      '<div id="badge"><span id="dot"></span><span id="hint"></span>' +
      '<span id="text"></span></div>' +
      "</div>" +
      '<div id="glow"></div>';
    host.__egoShadow = shadow;

    // The page scrolls under the cursor between actions, and no CDP round trip
    // announces that. Compensating in the page keeps it glued to its element.
    const sync = () => {
      const layer = shadow.getElementById("layer");
      if (layer) {
        layer.style.transform =
          "translate3d(" + -window.scrollX + "px," + -window.scrollY + "px,0)";
      }
      // Staying glued to its element means riding that element off the screen,
      // and a long scroll leaves the window showing nothing at all. The cursor
      // keeps its place; the badge is what has to remain readable.
      const at = host.__egoState;
      if (at) placeBadge(at.pageX - window.scrollX, at.pageY - window.scrollY);
    };
    // hide() removes the host but leaves the realm standing, so a hide/show
    // cycle would stack a listener per show, each closing over a dead root.
    if (window.__egoCursorSync) {
      window.removeEventListener("scroll", window.__egoCursorSync);
      window.removeEventListener("resize", window.__egoCursorSync);
    }
    window.addEventListener("scroll", sync, { passive: true });
    // A resize reflows the page under an overlay whose marks are held in page
    // coordinates, and re-docks nothing on its own: the badge keeps measuring
    // itself against the viewport it was placed in, so the whole overlay reads
    // as slid away from what it points at. Retiling the window — switching to a
    // dynamic or split layout — is the everyday way to hit it, and scrolling was
    // the only event that used to put it right again.
    window.addEventListener("resize", sync, { passive: true });
    window.__egoCursorSync = sync;
    host.__egoSync = sync;
    parent.appendChild(host);
    void host.offsetWidth; // let opacity:0 land, or there is nothing to fade from
    host.style.opacity = "1";
  }

  const shadow = host.__egoShadow;
  if (!shadow) return;

  // Looked up before the first sync rather than where they are first drawn:
  // sync() places the badge too, and it runs on the line below.
  const badge = shadow.getElementById("badge");
  const hint = shadow.getElementById("hint");

  host.__egoSync?.();

  // The harness speaks in viewport coordinates, but the cursor lives in page
  // ones. Convert only when the viewport point actually changed: re-deriving it
  // on a label-only render would walk the cursor across the page on every
  // scroll, since the same viewport point is a different page point by then.
  const previous = host.__egoState;
  const moved = !previous || previous.x !== payload.x || previous.y !== payload.y;
  let pageX = moved ? payload.x + window.scrollX : previous.pageX;
  let pageY = moved ? payload.y + window.scrollY : previous.pageY;

  // fill() focuses its target and inserts text without dispatching a single
  // pointer event, so an agent can fill a whole form having never placed the
  // cursor. Park it on the field it is typing into rather than at the origin.
  if (!payload.placed) {
    const target = focusedRect();
    if (!target) return;
    pageX = target.right + window.scrollX - 8;
    pageY = target.bottom + window.scrollY - 6;
  }

  // Where it sits on screen right now, which is not payload.x/y once the page
  // has scrolled under it.
  const viewX = pageX - window.scrollX;
  const viewY = pageY - window.scrollY;

  // A read sweep drives the cursor from inside the page, line by line, so a
  // render belonging to the same read must not drag it back to where the sweep
  // began. Anything else — a click, a keystroke, the next read — ends it.
  const pointer = shadow.getElementById("pointer");
  const running = host.__egoSweep;
  const readId = payload.read ? payload.read.id : 0;
  const sweeping = Boolean(running) && running.id === readId && !running.done;
  if (running && !running.done && !sweeping) {
    // Cut off mid-line. Hand the pointer back with the timing it had before the
    // sweep borrowed it, or the next real move animates like a read.
    running.done = true;
    pointer.style.transitionDuration = "";
    pointer.style.transitionTimingFunction = "";
  }
  if (!sweeping) {
    // One fixed duration for every move made a nudge between two fields crawl
    // and a jump across the page look like a teleport. Scaling it to the
    // distance is what a hand on a mouse does: near is quick, far takes a beat.
    const far = previous ? Math.hypot(pageX - previous.pageX, pageY - previous.pageY) : 0;
    pointer.style.transitionDuration =
      Math.round(Math.min(420, Math.max(90, far * 0.45))) + "ms";
    pointer.style.transform = "translate3d(" + pageX + "px," + pageY + "px,0)";
  }
  pointer.classList.toggle("press", Boolean(payload.pressed));

  // What the cursor is over decides both its shape and, when the agent has not
  // said what it is doing, what the badge reads. elementFromPoint is safe to
  // ask here precisely because the overlay is pointer-events:none.
  const under = document.elementFromPoint(viewX, viewY);
  const subject = under
    ? under.closest("a,button,input,select,textarea,label,summary,[role]") ||
      // Falling back to whatever is under the cursor is useful for a paragraph
      // or an image. It is not for <html> or <body>: their textContent is the
      // entire document, stylesheet text and all, so the badge would read
      // "Claude · Example Domainbody{background:#…". Resting the cursor in a
      // corner after a navigation lands on exactly those, so describing them
      // has to mean describing nothing — the stale label is the better answer.
      (under.tagName === "HTML" || under.tagName === "BODY" ? null : under)
    : null;
  showShape(shadow, payload.typing ? "beam" : shapeFor(under));

  // A label that still matches where the cursor is outranks everything. Once it
  // goes stale it yields to a fresh description of what is actually under the
  // cursor, and only comes back when there is nothing else to say — dimmed, to
  // admit it is history. That ordering is what keeps the badge both permanent
  // and honest: it never empties, and it never narrates the wrong thing.
  const current = payload.note || (payload.labelStale ? "" : payload.label);
  const nearby = describe(subject);
  const showingStale =
    !payload.typing && !current && !nearby && Boolean(payload.label);
  const detail = payload.typing ? "typing…" : current || nearby || payload.label;
  setBadgeText(detail ? payload.name + " · " + detail : payload.name);

  // Reading owns the blue scheme; anything else hands it straight back. The
  // read is what the harness cleared on the last real input, so this follows
  // the same signal the sweep does rather than tracking a second one.
  const readingNow = Boolean(payload.read) && !payload.typing;
  shadow.getElementById("layer").classList.toggle("reading", readingNow);
  // A host injected by an older build has no #glow, and the shim reuses whatever
  // host it finds rather than rebuilding it. Reaching straight through would
  // throw a TypeError that flush() silently swallows, leaving the cursor frozen
  // on every page that was already open when the update landed. Missing glow
  // just means no glow until that page next navigates.
  const glow = shadow.getElementById("glow");
  if (glow) glow.classList.toggle("on", readingNow);
  // A reading label is always current — the sweep rewrites it per line — so the
  // stale dimming only applies when the badge actually fell back to old text.
  shadow
    .getElementById("badge")
    .classList.toggle("stale", showingStale && !readingNow);

  placeBadge(viewX, viewY);

  // A short trail of what happened, kept in the page for the same reason the
  // cursor's position is: the Spaces panel runs in another process and this is
  // the only state the two share. Recorded on transitions, so a burst of
  // keystrokes is one entry rather than sixty.
  const log = host.__egoLog || (host.__egoLog = []);
  const remember = (text) => {
    if (!text) return;
    if (log.length && log[log.length - 1].text === text) return;
    log.push({ text, at: Date.now() });
    if (log.length > 6) log.shift();
  };
  if (payload.pulse) remember("clicked " + (describe(subject) || "the page"));
  if (payload.typing && !previous?.typing) {
    remember("typed into " + (describe(document.activeElement) || "a field"));
  }
  if (payload.highlight && payload.highlight.id !== previous?.highlightId) {
    remember("highlighted " + (payload.note || "a passage"));
  }

  // Typing has no pointer to follow, so the field being typed into is what the
  // overlay marks instead — otherwise text simply appears with nothing to say
  // where it came from.
  const ring = shadow.getElementById("ring");
  const focused = payload.typing ? focusedRect() : null;
  ring.classList.toggle("on", Boolean(focused));
  if (focused) {
    ring.style.width = focused.width + "px";
    ring.style.height = focused.height + "px";
    ring.style.transform =
      "translate3d(" +
      (focused.left + window.scrollX) +
      "px," +
      (focused.top + window.scrollY) +
      "px,0)";
  }

  // Marker bands. Each is created at zero width and given its real width on the
  // same frame, so the CSS transition draws it on rather than snapping it in.
  // They are created only as the sweep reaches them, which is what makes the
  // cursor look like it is doing the drawing.
  const bands = shadow.getElementById("bands");
  const marks = payload.highlight ? payload.highlight.rects : [];
  if (!marks.length) {
    // A sweep in flight puts its own bands in here; only a render that ended it
    // is entitled to wipe them.
    if (!sweeping) {
      bands.replaceChildren();
      bands.__egoId = 0;
    }
  } else {
    // A new highlight replaces the old one. Without the generation check the
    // previous stroke's bands would be reused for it, and the second highlight
    // of a session would silently draw nothing.
    if (bands.__egoId !== payload.highlight.id) {
      bands.replaceChildren();
      bands.__egoId = payload.highlight.id;
    }
    for (let index = 0; index < marks.length; index += 1) {
      if (index > payload.highlight.upTo || bands.children[index]) continue;
      const rect = marks[index];
      const band = document.createElement("div");
      band.className = "band";
      band.style.height = rect.height + "px";
      band.style.transform =
        "translate3d(" + rect.x + "px," + rect.y + "px,0)";
      band.style.transitionDuration = rect.ms + "ms";
      bands.appendChild(band);
      void band.offsetWidth; // let the zero width land before the real one
      band.style.width = rect.width + "px";
    }
  }

  if (payload.pulse) {
    const pulse = shadow.getElementById("pulse");
    pulse.classList.remove("on");
    void pulse.offsetWidth; // restart the animation rather than ignore a re-click
    pulse.classList.add("on");
  }

  // Left for anything reading the page from outside — the Spaces overview uses
  // it to tell a space being worked in from one sitting idle.
  host.__egoState = {
    x: payload.x,
    y: payload.y,
    pageX,
    pageY,
    label: detail,
    name: payload.name,
    typing: Boolean(payload.typing),
    highlightId: payload.highlight ? payload.highlight.id : 0,
    at: Date.now(),
  };

  // Last, so everything the sweep reaches for — the log, the badge, the state
  // it keeps fresh — already exists by the time it runs.
  if (readId && (!running || running.id !== readId)) startReadSweep(readId);

  /**
   * Reading, made watchable.
   *
   * Snapshotting is most of what an agent does and it dispatches no input at
   * all, so a window where the agent was reading showed a cursor parked in a
   * corner under a badge that said "reading" — true, but never *what*. The
   * sweep walks the cursor along the lines that are actually on screen, marking
   * each as it passes and naming it in the badge, so someone watching can
   * follow what the agent took in.
   *
   * It runs entirely inside the page: a round trip per line would cost more
   * than the snapshot it illustrates, and the heredoc that triggered it has
   * usually exited before the last line is drawn. That also means it must give
   * up on its own — the sweep object is the only handle anything has on it.
   */
  function startReadSweep(id) {
    const sweep = { id, done: false };
    host.__egoSweep = sweep;
    const lines = readableLines();
    if (!lines.length) {
      sweep.done = true;
      return;
    }
    remember("read " + snip(lines[0].text));

    let index = 0;
    let spent = 0;

    const step = () => {
      if (sweep.done) return;
      // A budget rather than a line count: reading is constant, and a sweep
      // still going when the agent acts again would only ever be interrupted.
      if (index >= lines.length || spent > 2400) {
        sweep.done = true;
        pointer.style.transitionDuration = "";
        pointer.style.transitionTimingFunction = "";
        return;
      }
      const line = lines[index];
      index += 1;
      const scanMs = Math.min(360, Math.max(130, Math.round(line.width * 0.8)));
      spent += scanMs + 110;
      const baseline = line.y + line.height - 2;

      // Onto the start of the line first, then along it: the two legs are what
      // make it read as following the words rather than sliding to a spot.
      pointer.style.transitionTimingFunction = "ease-out";
      pointer.style.transitionDuration = "100ms";
      pointer.style.transform =
        "translate3d(" + line.x + "px," + baseline + "px,0)";
      setBadgeText(payload.name + " · reading “" + snip(line.text) + "”");
      placeBadge(line.x - window.scrollX, baseline - window.scrollY);

      setTimeout(() => {
        if (sweep.done) return;
        pointer.style.transitionTimingFunction = "linear";
        pointer.style.transitionDuration = scanMs + "ms";
        pointer.style.transform =
          "translate3d(" + (line.x + line.width) + "px," + baseline + "px,0)";

        const band = document.createElement("div");
        band.className = "band read";
        band.style.height = line.height + "px";
        band.style.transform = "translate3d(" + line.x + "px," + line.y + "px,0)";
        band.style.transitionDuration = scanMs + "ms";
        bands.appendChild(band);
        void band.offsetWidth; // let the zero width land before the real one
        band.style.width = line.width + "px";
        setTimeout(() => {
          band.style.opacity = "0";
          setTimeout(() => band.remove(), scanMs + 60);
        }, scanMs + 320);

        // Keep the state the Spaces overview polls moving: a card whose agent is
        // reading should not look like a card whose agent walked away.
        host.__egoState.pageX = line.x + line.width;
        host.__egoState.pageY = baseline;
        host.__egoState.label = "reading " + snip(line.text);
        host.__egoState.at = Date.now();

        setTimeout(step, scanMs + 10);
      }, 110);
    };

    step();
  }

  /**
   * The lines of text actually on screen, in reading order.
   *
   * Line boxes rather than elements: a Range hands back one rect per line, which
   * is what lets the cursor travel a paragraph the way a reader does. Only the
   * first few rects of any one node, so a long paragraph cannot spend the whole
   * sweep while the rest of the page goes unread.
   */
  function readableLines() {
    const root = document.body;
    if (!root) return [];
    const found = [];
    // Measuring is what costs, and an agent scrolled halfway down a long page
    // has thousands of text nodes above it that can never be swept. Dropping a
    // container that is entirely off screen drops everything inside it in one
    // test — but only when it has a box of its own to judge by, since an empty
    // rect (display:contents, a zero-height wrapper) says nothing about the
    // children. The count is the backstop for what pruning cannot reach.
    let measured = 0;
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (node.nodeType === 3) return NodeFilter.FILTER_ACCEPT;
          const box = node.getBoundingClientRect();
          const offScreen = box.bottom < 4 || box.top > window.innerHeight - 4;
          if (box.width > 0 && box.height > 0 && offScreen) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_SKIP; // an element is not a line; its text is
        },
      },
    );
    while (found.length < 12 && measured < 400 && walker.nextNode()) {
      const node = walker.currentNode;
      const text = (node.nodeValue || "").replace(/\s+/g, " ").trim();
      if (text.length < 12) continue;
      const parent = node.parentElement;
      if (!parent || parent.closest("script,style,noscript,svg")) continue;
      measured += 1;
      const range = document.createRange();
      range.selectNodeContents(node);
      let taken = 0;
      for (const rect of range.getClientRects()) {
        if (taken >= 3 || found.length >= 12) break;
        if (rect.width < 80 || rect.height < 9 || rect.height > 96) continue;
        if (rect.bottom < 4 || rect.top > window.innerHeight - 4) continue;
        taken += 1;
        found.push({
          x: rect.left + window.scrollX,
          y: rect.top + window.scrollY,
          width: rect.width,
          height: rect.height,
          text,
        });
      }
    }
    // Document order is close to reading order but not the same thing under
    // absolute positioning, and a cursor that jumps back up the page reads as a
    // glitch rather than as reading.
    return found.sort((a, b) => a.y - b.y || a.x - b.x);
  }

  /** Short enough for a badge that is drawn into every screenshot. */
  function snip(text) {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    return value.length > 44 ? value.slice(0, 43) + "…" : value;
  }

  /**
   * The label, swapped without a jump cut.
   *
   * Written synchronously — anything reading the badge sees the new text on the
   * next tick, and only the fade is deferred. The animation is restarted by hand
   * because a swap arriving mid-fade would otherwise inherit whatever opacity
   * the last one had reached and never brighten.
   */
  function setBadgeText(next) {
    const text = shadow.getElementById("text");
    if (text.textContent === next) return;
    text.textContent = next;
    text.style.animation = "none";
    void text.offsetWidth;
    text.style.animation = "";
  }

  /**
   * Where the label goes, in viewport coordinates: what matters is where the
   * cursor currently sits on screen, not where on the page it is marking.
   *
   * Near an edge the badge flips back over the cursor, so the label is never the
   * thing that gets clipped. Past the edge — the cursor scrolled out of view
   * entirely — it stops following and docks, because a label that leaves with
   * the cursor tells a watcher nothing about what is still happening.
   */
  function placeBadge(atX, atY) {
    const outY = atY < 4 ? "↑" : atY > window.innerHeight - 4 ? "↓" : "";
    const outX = atX < 4 ? "←" : atX > window.innerWidth - 4 ? "→" : "";
    // Vertical first: pages scroll that way, so it is the direction that
    // actually carries the cursor off screen.
    const away = outY || outX;
    hint.textContent = away;

    // #layer already carries -scroll, so a viewport target has to be written
    // back into page coordinates to survive it.
    const toPage = (x, y) =>
      "translate(" +
      Math.round(x + window.scrollX) +
      "px," +
      Math.round(y + window.scrollY) +
      "px)";

    if (!away) {
      // Trailing the cursor at the offset it used to sit at as a child of it,
      // then flipped back over it near an edge so the label is never the thing
      // that gets clipped.
      badge.classList.remove("docked");
      badge.style.transform =
        toPage(atX + 20, atY + 22) +
        (atX + 340 > window.innerWidth ? " translateX(calc(-100% - 40px))" : "") +
        (atY + 70 > window.innerHeight ? " translateY(-60px)" : "");
      return;
    }

    // Parked against the edge the cursor left by, and held there while the page
    // keeps moving under it.
    const width = badge.offsetWidth || 240;
    const dockX = Math.min(Math.max(atX, 12), Math.max(12, window.innerWidth - width - 12));
    const dockY = Math.min(Math.max(atY, 12), Math.max(12, window.innerHeight - 40));
    badge.classList.add("docked");
    badge.style.transform = toPage(dockX, dockY);
  }

  /** The page's own cursor for this element is the honest source of shape. */
  function shapeFor(element) {
    if (!element) return "arrow";
    const style = getComputedStyle(element).cursor;
    if (style === "pointer") return "hand";
    if (style === "text" || style === "vertical-text") return "beam";
    return "arrow";
  }

  function showShape(root, id) {
    for (const shape of root.querySelectorAll("svg.shape")) {
      shape.classList.toggle("on", shape.id === id);
    }
  }

  /**
   * A short name for the thing under the cursor. Deliberately never reads an
   * input's value: the agent types passwords into these, and the badge is drawn
   * into every screenshot.
   */
  function describe(element) {
    if (!element) return "";
    const candidates = [
      element.getAttribute("aria-label"),
      // A form control's own <label> beats its placeholder: "typed into Your
      // name" reads like a sentence, "typed into type a name" does not.
      element.labels?.[0]?.textContent,
      element.getAttribute("alt"),
      element.getAttribute("placeholder"),
      element.getAttribute("title"),
      element.tagName === "INPUT" || element.tagName === "TEXTAREA"
        ? ""
        : element.textContent,
    ];
    for (const candidate of candidates) {
      const text = String(candidate || "")
        .replace(/\s+/g, " ")
        .trim();
      if (text) return text.length > 40 ? text.slice(0, 39) + "…" : text;
    }
    return "";
  }

  function focusedRect() {
    const active = document.activeElement;
    if (!active || active === document.body || active === document.documentElement) {
      return null;
    }
    const rect = active.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? rect : null;
  }
}
