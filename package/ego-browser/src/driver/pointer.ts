import { cdp, js } from "../cdp-eval.js";
import { browserCdp } from "../browser-runtime.js";
import { elementCenter } from "./observe.js";
import { resolveAndCall } from "./element-ops.js";

type MouseButton = "left" | "middle" | "right";
type Point = {
  x: number;
  y: number;
  sessionId?: string;
};
export type MouseTarget =
  | string
  | [number, number]
  | { x: number; y: number }
  | { selector: string; x?: number; y?: number };
type ClickOptions = {
  button?: MouseButton;
  clickCount?: number;
  clicks?: number;
  label?: string;
};
type DragMouseOptions = {
  button?: MouseButton;
  delayMs?: number;
  label?: string;
};
type HoverOptions = {
  label?: string;
};
type ScrollOptions = {
  x?: number;
  y?: number;
  dx?: number;
  dy?: number;
};
type ScrollByOptions = {
  dx?: number;
  dy?: number;
  left?: number;
  top?: number;
  behavior?: ScrollBehavior;
};
type ScrollState = {
  x: number;
  y: number;
  viewportHeight: number;
  scrollHeight: number;
  atBottom: boolean;
};
type ScrollUntilOptions = {
  step?: number;
  dy?: number;
  maxSteps?: number;
  wait?: number;
  waitSeconds?: number;
  stallLimit?: number;
};
type ScrollUntilCondition =
  | ((state: ScrollState) => boolean | Promise<boolean>)
  | string
  | null;
type MouseEventOptions = Record<string, unknown>;

const INPUT_EVENT_DELAY_MS = 25;
const INPUT_DISPATCH_TIMEOUT_MS = 1000;

/**
 * Mouse target accepted by mouse helpers.
 *
 * Forms:
 * - string: CSS selector or @ref, resolves to the element center.
 * - [x, y]: viewport coordinates in CSS pixels.
 * - {x, y}: viewport coordinates in CSS pixels.
 * - {selector}: CSS selector or @ref, resolves to the element center.
 * - {selector, x, y}: element top-left plus x/y offset in CSS pixels.
 *
 * @typedef {string | [number, number] | {x:number,y:number} | {selector:string,x?:number,y?:number}} MouseTarget
 */

/**
 * Click a mouse target.
 * @param {MouseTarget} target CSS selector, @ref, viewport point, or selector-relative point.
 * @param {{button?: "left"|"middle"|"right", clickCount?: number, clicks?: number, label?: string}} [options]
 * @returns {Promise<void>}
 */
export async function click(target: MouseTarget, options: ClickOptions = {}) {
  const point = await resolveMouseTarget(target);
  const button = options.button || "left";
  const buttons = pressedButtons(button);
  const clickCount = options.clickCount ?? options.clicks ?? 1;
  maybeHighlight(point, options.label);
  const probeId = await installClickProbe(point);
  let dispatchError: unknown = null;
  try {
    await dispatchMouse(point, "mouseMoved", {
      button: "none",
      buttons: 0,
    });
    await inputEventDelay();
    await dispatchMouse(point, "mousePressed", {
      button,
      buttons,
      clickCount,
    });
    await inputEventDelay();
    await dispatchMouse(point, "mouseReleased", {
      button,
      buttons: 0,
      clickCount,
    });
  } catch (error) {
    if (!isInputDispatchTimeout(error)) throw error;
    dispatchError = error;
  }
  const completed = await finishClickProbe(point, probeId, clickCount);
  if (dispatchError && !completed) throw dispatchError;
}

/**
 * Double-click a mouse target.
 * @param {MouseTarget} target CSS selector, @ref, viewport point, or selector-relative point.
 * @param {{button?: "left"|"middle"|"right", label?: string}} [options]
 * @returns {Promise<void>}
 */
export async function doubleClick(
  target: MouseTarget,
  options: ClickOptions = {},
) {
  await click(target, { ...options, clickCount: 2 });
}

/**
 * Move the mouse over a target without pressing a button.
 * @param {MouseTarget} target CSS selector, @ref, viewport point, or selector-relative point.
 * @param {{label?: string}} [options]
 * @returns {Promise<void>}
 */
export async function hover(target: MouseTarget, options: HoverOptions = {}) {
  const point = await resolveMouseTarget(target);
  maybeHighlight(point, options.label);
  const probeId = await installHoverProbe(point);
  let dispatchError: unknown = null;
  try {
    await dispatchMouse(point, "mouseMoved", { buttons: 0 });
  } catch (error) {
    if (!isInputDispatchTimeout(error)) throw error;
    dispatchError = error;
  }
  const completed = await finishHoverProbe(point, probeId);
  if (dispatchError && !completed) throw dispatchError;
}

/**
 * Drag the mouse through a sequence of targets while holding a button.
 * @param {MouseTarget[]} points Ordered drag path. Must contain at least two targets.
 * @param {{button?: "left"|"middle"|"right", delayMs?: number, label?: string}} [options]
 * @returns {Promise<void>}
 */
export async function dragMouse(
  points: MouseTarget[],
  options: DragMouseOptions = {},
) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error("dragMouse requires at least two points");
  }
  const resolved: Point[] = [];
  for (const point of points) {
    resolved.push(await resolveMouseTarget(point));
  }
  const button = options.button || "left";
  const buttons = pressedButtons(button);
  const first = resolved[0];
  const last = resolved.at(-1);
  maybeHighlight(first, options.label);
  const probeId = await installMouseUpProbe(last);
  let dispatchError: unknown = null;
  try {
    await dispatchMouse(first, "mousePressed", {
      button,
      buttons,
      clickCount: 1,
    });
    await inputEventDelay();
    for (let i = 1; i < resolved.length; i += 1) {
      const point = resolved[i];
      await dispatchMouse(
        { ...point, sessionId: point.sessionId ?? first.sessionId },
        "mouseMoved",
        {
          button,
          buttons,
        },
      );
      await inputEventDelay(options.delayMs > 0 ? options.delayMs : undefined);
    }
    await dispatchMouse(
      { ...last, sessionId: last.sessionId ?? first.sessionId },
      "mouseReleased",
      {
        button,
        buttons: 0,
        clickCount: 1,
      },
    );
  } catch (error) {
    if (!isInputDispatchTimeout(error)) throw error;
    dispatchError = error;
  }
  const completed = await finishDragProbe(resolved, probeId, button);
  if (dispatchError && !completed) throw dispatchError;
}

function inputEventDelay(ms = INPUT_EVENT_DELAY_MS) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function installClickProbe(point: Point) {
  if (!canProbeInputFallback()) return null;
  const id = `click_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  try {
    const result = await cdp(
      "Runtime.evaluate",
      {
        expression: `(() => {
        const target = document.elementFromPoint(${JSON.stringify(point.x)}, ${JSON.stringify(point.y)});
        window.__egoBrowserInputProbes ||= {};
        const probe = { seen: false, target };
        probe.handler = (event) => {
          if (event.isTrusted && target && (event.target === target || target.contains(event.target))) {
            probe.seen = true;
          }
        };
        document.addEventListener("click", probe.handler, true);
        window.__egoBrowserInputProbes[${JSON.stringify(id)}] = probe;
        return Boolean(target);
      })()`,
        returnByValue: true,
        awaitPromise: false,
      },
      point.sessionId,
    );
    return result.result?.value ? id : null;
  } catch {
    return null;
  }
}

async function finishClickProbe(
  point: Point,
  id: string | null,
  clickCount: number,
) {
  if (!id) return false;
  await inputEventDelay(50);
  try {
    const result = await cdp(
      "Runtime.evaluate",
      {
        expression: `(() => {
        const probes = window.__egoBrowserInputProbes || {};
        const probe = probes[${JSON.stringify(id)}];
        if (!probe) return { seen: false, fallback: false };
        document.removeEventListener("click", probe.handler, true);
        delete probes[${JSON.stringify(id)}];
        if (probe.seen || !probe.target) return { seen: probe.seen, fallback: false };
        const target = probe.target;
        const init = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: ${JSON.stringify(point.x)},
          clientY: ${JSON.stringify(point.y)},
          button: 0,
        };
        target.dispatchEvent(new MouseEvent("mousemove", { ...init, buttons: 0, detail: 0 }));
        target.dispatchEvent(new MouseEvent("mousedown", { ...init, buttons: 1, detail: ${JSON.stringify(clickCount)} }));
        target.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0, detail: ${JSON.stringify(clickCount)} }));
        target.dispatchEvent(new MouseEvent("click", { ...init, buttons: 0, detail: ${JSON.stringify(clickCount)} }));
        if (${JSON.stringify(clickCount)} > 1) {
          target.dispatchEvent(new MouseEvent("dblclick", { ...init, buttons: 0, detail: 2 }));
        }
        return { seen: false, fallback: true };
      })()`,
        returnByValue: true,
        awaitPromise: false,
      },
      point.sessionId,
    );
    const value = result.result?.value;
    return Boolean(value?.seen || value?.fallback);
  } catch {
    return false;
  }
}

async function installMouseUpProbe(point: Point) {
  if (!canProbeInputFallback()) return null;
  const id = `drag_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  try {
    const result = await cdp(
      "Runtime.evaluate",
      {
        expression: `(() => {
        const target = document.elementFromPoint(${JSON.stringify(point.x)}, ${JSON.stringify(point.y)});
        window.__egoBrowserInputProbes ||= {};
        const probe = { seen: false, target };
        probe.handler = (event) => {
          if (event.isTrusted && target && (event.target === target || target.contains(event.target))) {
            probe.seen = true;
          }
        };
        document.addEventListener("mouseup", probe.handler, true);
        window.__egoBrowserInputProbes[${JSON.stringify(id)}] = probe;
        return Boolean(target);
      })()`,
        returnByValue: true,
        awaitPromise: false,
      },
      point.sessionId,
    );
    return result.result?.value ? id : null;
  } catch {
    return null;
  }
}

async function installHoverProbe(point: Point) {
  if (!canProbeInputFallback()) return null;
  const id = `hover_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  try {
    const result = await cdp(
      "Runtime.evaluate",
      {
        expression: `(() => {
        const target = document.elementFromPoint(${JSON.stringify(point.x)}, ${JSON.stringify(point.y)});
        window.__egoBrowserInputProbes ||= {};
        const probe = { seen: false, target };
        probe.handler = (event) => {
          if (event.isTrusted && target && (event.target === target || target.contains(event.target))) {
            probe.seen = true;
          }
        };
        document.addEventListener("mousemove", probe.handler, true);
        document.addEventListener("mouseover", probe.handler, true);
        window.__egoBrowserInputProbes[${JSON.stringify(id)}] = probe;
        return Boolean(target);
      })()`,
        returnByValue: true,
        awaitPromise: false,
      },
      point.sessionId,
    );
    return result.result?.value ? id : null;
  } catch {
    return null;
  }
}

async function finishHoverProbe(point: Point, id: string | null) {
  if (!id) return false;
  await inputEventDelay(50);
  try {
    const result = await cdp(
      "Runtime.evaluate",
      {
        expression: `(() => {
        const probes = window.__egoBrowserInputProbes || {};
        const probe = probes[${JSON.stringify(id)}];
        if (!probe) return { seen: false, fallback: false };
        document.removeEventListener("mousemove", probe.handler, true);
        document.removeEventListener("mouseover", probe.handler, true);
        delete probes[${JSON.stringify(id)}];
        if (probe.seen || !probe.target) return { seen: probe.seen, fallback: false };
        const target = probe.target;
        const init = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: ${JSON.stringify(point.x)},
          clientY: ${JSON.stringify(point.y)},
          button: 0,
          buttons: 0,
        };
        target.dispatchEvent(new MouseEvent("mousemove", init));
        target.dispatchEvent(new MouseEvent("mouseover", init));
        return { seen: false, fallback: true };
      })()`,
        returnByValue: true,
        awaitPromise: false,
      },
      point.sessionId,
    );
    const value = result.result?.value;
    return Boolean(value?.seen || value?.fallback);
  } catch {
    return false;
  }
}

async function finishDragProbe(
  points: Point[],
  id: string | null,
  button: MouseButton,
) {
  if (!id) return false;
  await inputEventDelay(50);
  const first = points[0];
  const last = points.at(-1);
  try {
    const result = await cdp(
      "Runtime.evaluate",
      {
        expression: `(() => {
        const probes = window.__egoBrowserInputProbes || {};
        const probe = probes[${JSON.stringify(id)}];
        if (!probe) return { seen: false, fallback: false };
        document.removeEventListener("mouseup", probe.handler, true);
        delete probes[${JSON.stringify(id)}];
        if (probe.seen) return { seen: true, fallback: false };
        const mouseButton = ${JSON.stringify(button === "left" ? 0 : button === "middle" ? 1 : 2)};
        const eventFor = (type, point, buttons) => {
          const target = document.elementFromPoint(point.x, point.y) || document.body;
          target.dispatchEvent(new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: point.x,
            clientY: point.y,
            button: mouseButton,
            buttons,
            detail: type === "mousemove" ? 0 : 1,
          }));
        };
        const points = ${JSON.stringify(points.map(({ x, y }) => ({ x, y })))};
        eventFor("mousedown", points[0], 1);
        for (const point of points.slice(1)) eventFor("mousemove", point, 1);
        eventFor("mouseup", points.at(-1), 0);
        return { seen: false, fallback: true };
      })()`,
        returnByValue: true,
        awaitPromise: false,
      },
      last.sessionId ?? first.sessionId,
    );
    const value = result.result?.value;
    return Boolean(value?.seen || value?.fallback);
  } catch {
    return false;
  }
}

function canProbeInputFallback() {
  return Boolean((globalThis as any).ego?.sendCDPMessage);
}

/**
 * Scroll by dispatching a CDP mouse wheel event.
 * Sign convention follows DOM WheelEvent: positive dy scrolls down, negative dy scrolls up
 * (CDP negates deltas internally when building the Blink wheel event, so the DOM convention
 * applies end to end). Defaults to scrolling down by 300 CSS pixels, matching the downward
 * defaults of scrollBy and scrollToBottomUntil.
 * @param {number|{x?:number,y?:number,dx?:number,dy?:number}} [x=0] Viewport x, or scroll options.
 * @param {number|{dx?: number, dy?: number}} [y=0] Viewport y, or scroll delta options.
 * @param {{dx?: number, dy?: number}} [options] Deltas in CSS pixels; positive dy scrolls down.
 * @returns {Promise<void>}
 */
export async function scroll(
  x: number | ScrollOptions = 0,
  y: number | ScrollOptions = 0,
  options: ScrollOptions = {},
) {
  if (x && typeof x === "object" && !Array.isArray(x)) {
    options = x;
    y = options.y ?? 0;
    x = options.x ?? 0;
  } else if (y && typeof y === "object" && !Array.isArray(y)) {
    options = y;
    y = 0;
  }
  const params = {
    type: "mouseWheel",
    x: Number(x) || 0,
    y: Number(y) || 0,
    deltaX: options.dx ?? 0,
    deltaY: options.dy ?? 300,
  };
  try {
    // Chromium may acknowledge wheel input only after the compositor has
    // processed it. Use the normal CDP deadline; retrying a timed-out wheel is
    // unsafe because the original event may still be applied later.
    await browserCdp("Input.dispatchMouseEvent", params);
  } catch (error) {
    // Degrade to DOM scrolling only when the target genuinely cannot dispatch
    // wheel events. Everything else (timeouts, "user is controlling", session
    // loss) propagates — window.scrollBy is NOT equivalent to a real wheel
    // event (virtualized lists and inner scroll panes ignore window scrolling),
    // so a silent fallback would hide the failure behind a different behavior.
    if (!isWheelDispatchUnsupported(error)) {
      throw error;
    }
    if (!hasWarnedAboutWheelFallback) {
      hasWarnedAboutWheelFallback = true;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[ego-browser] scroll(): wheel dispatch unsupported on this target (${message}); ` +
          `falling back to DOM scrollBy(). Wheel-only behaviors (virtualized lists, inner scroll panes) may not trigger.\n`,
      );
    }
    return scrollBy({ dx: params.deltaX, dy: params.deltaY });
  }
}

let hasWarnedAboutWheelFallback = false;

function isWheelDispatchUnsupported(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /not (?:supported|implemented)|wasn't found|isn't found|unknown (?:method|command)|method not found/i.test(
    message,
  );
}

/**
 * Scroll the window with DOM APIs. Positive dy scrolls down, negative dy scrolls up
 * (same sign convention as scroll()).
 * @param {number|{dx?:number,dy?:number,left?:number,top?:number,behavior?: ScrollBehavior}} [amount=900] Vertical pixels (positive scrolls down), or scroll options.
 * @param {{dx?:number,dy?:number,left?:number,top?:number,behavior?: ScrollBehavior}} [options]
 * @returns {Promise<{x:number,y:number}>} New window scroll position.
 */
export async function scrollBy(
  amount: number | ScrollByOptions = 900,
  options: ScrollByOptions = {},
) {
  const params = scrollByParams(amount, options);
  return js(`(() => {
    window.scrollBy({
      left: ${JSON.stringify(params.left)},
      top: ${JSON.stringify(params.top)},
      behavior: ${JSON.stringify(params.behavior)}
    });
    return { x: window.scrollX, y: window.scrollY };
  })()`);
}

/**
 * Scroll downward until a condition is met, the page bottom is reached, or scrolling stalls.
 * @param {Function|string|null} [condition] Function receiving scroll state, or browser JS expression string.
 * @param {{step?:number,dy?:number,maxSteps?:number,wait?:number,waitSeconds?:number,stallLimit?:number}} [options]
 * @returns {Promise<{done:boolean,reason:string,steps:number,state:object}>}
 */
export async function scrollToBottomUntil(
  condition: ScrollUntilCondition = null,
  options: ScrollUntilOptions = {},
) {
  const step = numberValue(options.step ?? options.dy ?? 900);
  const maxSteps = Math.max(0, Math.floor(numberValue(options.maxSteps ?? 30)));
  const stallLimit = Math.max(
    1,
    Math.floor(numberValue(options.stallLimit ?? 2)),
  );
  const waitSeconds = numberValue(options.waitSeconds ?? options.wait ?? 0.5);
  let previousY = -1;
  let stalls = 0;
  let state = await scrollState();

  for (let steps = 0; steps <= maxSteps; steps += 1) {
    if (await conditionMet(condition, state)) {
      return { done: true, reason: "condition", steps, state };
    }
    if (state.atBottom) {
      return { done: false, reason: "bottom", steps, state };
    }
    if (steps === maxSteps) {
      return { done: false, reason: "maxSteps", steps, state };
    }

    await scrollBy(step);
    if (waitSeconds > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
    }
    state = await scrollState();
    stalls = state.y === previousY ? stalls + 1 : 0;
    previousY = state.y;
    if (stalls >= stallLimit) {
      return { done: false, reason: "stalled", steps: steps + 1, state };
    }
  }
  return { done: false, reason: "maxSteps", steps: maxSteps, state };
}

function maybeHighlight(point: Point, label?: string) {
  const ego = (globalThis as any).ego;
  if (!ego) return;
  ego.animationHighlightMouseToPosition?.(point.x, point.y);
  if (label) {
    ego.setAgentTaskState?.(label);
  }
}

async function dispatchMouse(
  point: Point,
  type: string,
  options: MouseEventOptions = {},
) {
  await browserCdp(
    "Input.dispatchMouseEvent",
    {
      type,
      x: point.x,
      y: point.y,
      ...options,
    },
    point.sessionId,
    INPUT_DISPATCH_TIMEOUT_MS,
  );
}

function isInputDispatchTimeout(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /CDP request timed out: Input\.dispatchMouseEvent/.test(message);
}

async function resolveMouseTarget(target: MouseTarget): Promise<Point> {
  if (typeof target === "string") {
    return elementCenter(target);
  }
  if (Array.isArray(target)) {
    return pointFrom(target);
  }
  if (target && typeof target === "object") {
    if (
      "selector" in target &&
      typeof target.selector === "string" &&
      target.selector
    ) {
      if (target.x === undefined && target.y === undefined) {
        return elementCenter(target.selector);
      }
      const [topLeft, center] = await Promise.all([
        elementTopLeft(target.selector),
        elementCenter(target.selector),
      ]);
      return {
        x: topLeft.x + numberValue(target.x),
        y: topLeft.y + numberValue(target.y),
        sessionId: center.sessionId,
      };
    }
    if (target.x !== undefined || target.y !== undefined) {
      return pointFrom(target);
    }
  }
  throw new Error(`invalid mouse target: ${JSON.stringify(target)}`);
}

async function elementTopLeft(selectorOrRef: string): Promise<Point> {
  const { result } = await resolveAndCall(
    selectorOrRef,
    "function(){const rect=this.getBoundingClientRect();return {x:rect.left,y:rect.top};}",
  );
  const value = result.result?.value;
  if (typeof value?.x !== "number" || typeof value?.y !== "number") {
    throw new Error(`element top-left unavailable: ${selectorOrRef}`);
  }
  return { x: value.x, y: value.y };
}

function pointFrom(point: [number, number] | { x?: number; y?: number }) {
  const x = Array.isArray(point) ? point[0] : point?.x;
  const y = Array.isArray(point) ? point[1] : point?.y;
  if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) {
    throw new Error(`invalid mouse target: ${JSON.stringify(point)}`);
  }
  return { x: Number(x), y: Number(y), sessionId: undefined };
}

function numberValue(value: unknown) {
  const out = value === undefined ? 0 : Number(value);
  if (!Number.isFinite(out)) {
    throw new Error(`invalid mouse offset: ${JSON.stringify(value)}`);
  }
  return out;
}

function scrollByParams(
  amount: number | ScrollByOptions,
  options: ScrollByOptions,
) {
  const input =
    amount && typeof amount === "object" && !Array.isArray(amount)
      ? amount
      : options;
  const top =
    amount && typeof amount === "object" && !Array.isArray(amount)
      ? (input.top ?? input.dy ?? 900)
      : (input.top ?? input.dy ?? amount);
  return {
    left: numberValue(input.left ?? input.dx ?? 0),
    top: numberValue(top),
    behavior: input.behavior === "smooth" ? "smooth" : "instant",
  };
}

async function scrollState(): Promise<ScrollState> {
  return js(`(() => {
    const doc = document.documentElement;
    const body = document.body;
    const height = Math.max(
      doc?.scrollHeight || 0,
      body?.scrollHeight || 0,
      doc?.offsetHeight || 0,
      body?.offsetHeight || 0
    );
    const viewportHeight = window.innerHeight || doc?.clientHeight || 0;
    const y = window.scrollY || window.pageYOffset || 0;
    return {
      x: window.scrollX || window.pageXOffset || 0,
      y,
      viewportHeight,
      scrollHeight: height,
      atBottom: y + viewportHeight >= height - 2
    };
  })()`);
}

async function conditionMet(
  condition: ScrollUntilCondition,
  state: ScrollState,
) {
  if (!condition) {
    return false;
  }
  if (typeof condition === "function") {
    return Boolean(await condition(state));
  }
  if (typeof condition === "string") {
    return Boolean(await js(`Boolean(${condition})`));
  }
  throw new TypeError(
    `scrollToBottomUntil condition must be a function or string, got ${typeof condition}`,
  );
}

function pressedButtons(button: MouseButton) {
  if (button === "left") {
    return 1;
  }
  if (button === "right") {
    return 2;
  }
  if (button === "middle") {
    return 4;
  }
  throw new Error(`unsupported mouse button: ${button}`);
}
