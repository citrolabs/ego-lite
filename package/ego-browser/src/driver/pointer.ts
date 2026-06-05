import { cdp, js } from "../cdp-eval.js";
import { browserCdp } from "../browser-runtime.js";
import { elementCenter, elementEval } from "./observe.js";

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
type ScrollUntilCondition = ((state: ScrollState) => boolean | Promise<boolean>) | string | null;
type MouseEventOptions = Record<string, unknown>;

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
  const clickCount = options.clickCount ?? options.clicks ?? 1;
  maybeHighlight(point, options.label);
  await dispatchMouse(point, "mousePressed", { button, buttons: pressedButtons(button), clickCount });
  await dispatchMouse(point, "mouseReleased", { button, buttons: 0, clickCount });
}

/**
 * Double-click a mouse target.
 * @param {MouseTarget} target CSS selector, @ref, viewport point, or selector-relative point.
 * @param {{button?: "left"|"middle"|"right", label?: string}} [options]
 * @returns {Promise<void>}
 */
export async function doubleClick(target: MouseTarget, options: ClickOptions = {}) {
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
  await cdp("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    buttons: 0
  }, point.sessionId);
}

/**
 * Drag the mouse through a sequence of targets while holding a button.
 * @param {MouseTarget[]} points Ordered drag path. Must contain at least two targets.
 * @param {{button?: "left"|"middle"|"right", delayMs?: number, label?: string}} [options]
 * @returns {Promise<void>}
 */
export async function dragMouse(points: MouseTarget[], options: DragMouseOptions = {}) {
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
  await cdp("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: first.x,
    y: first.y,
    button,
    buttons,
    clickCount: 1
  }, first.sessionId);
  for (let i = 1; i < resolved.length; i += 1) {
    const point = resolved[i];
    await cdp("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      button,
      buttons
    }, point.sessionId ?? first.sessionId);
    if (options.delayMs > 0 && i < resolved.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
  }
  await cdp("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: last.x,
    y: last.y,
    button,
    buttons: 0,
    clickCount: 1
  }, last.sessionId ?? first.sessionId);
}

/**
 * Scroll by wheel coordinates.
 * @param {number|{x?:number,y?:number,dx?:number,dy?:number}} [x=0] Viewport x, or scroll options.
 * @param {number|{dx?: number, dy?: number}} [y=0] Viewport y, or scroll delta options.
 * @param {{dx?: number, dy?: number}} [options]
 * @returns {Promise<void>}
 */
export async function scroll(x: number | ScrollOptions = 0, y: number | ScrollOptions = 0, options: ScrollOptions = {}) {
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
    deltaY: options.dy ?? -300
  };
  try {
    await browserCdp("Input.dispatchMouseEvent", params, undefined, 1000);
  } catch {
    return scrollBy({ dx: params.deltaX, dy: params.deltaY });
  }
}

/**
 * Scroll the window with DOM APIs.
 * @param {number|{dx?:number,dy?:number,left?:number,top?:number,behavior?: ScrollBehavior}} [amount=900] Vertical pixels, or scroll options.
 * @param {{dx?:number,dy?:number,left?:number,top?:number,behavior?: ScrollBehavior}} [options]
 * @returns {Promise<{x:number,y:number}>} New window scroll position.
 */
export async function scrollBy(amount: number | ScrollByOptions = 900, options: ScrollByOptions = {}) {
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
export async function scrollToBottomUntil(condition: ScrollUntilCondition = null, options: ScrollUntilOptions = {}) {
  const step = numberValue(options.step ?? options.dy ?? 900);
  const maxSteps = Math.max(0, Math.floor(numberValue(options.maxSteps ?? 30)));
  const stallLimit = Math.max(1, Math.floor(numberValue(options.stallLimit ?? 2)));
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

async function dispatchMouse(point: Point, type: string, options: MouseEventOptions = {}) {
  await cdp("Input.dispatchMouseEvent", {
    type,
    x: point.x,
    y: point.y,
    ...options
  }, point.sessionId);
}

async function resolveMouseTarget(target: MouseTarget): Promise<Point> {
  if (typeof target === "string") {
    return elementCenter(target);
  }
  if (Array.isArray(target)) {
    return pointFrom(target);
  }
  if (target && typeof target === "object") {
    if ("selector" in target && typeof target.selector === "string" && target.selector) {
      if (target.x === undefined && target.y === undefined) {
        return elementCenter(target.selector);
      }
      const [topLeft, center] = await Promise.all([
        elementEval(target.selector, function () {
          const rect = this.getBoundingClientRect();
          return { x: rect.left, y: rect.top };
        }),
        elementCenter(target.selector)
      ]);
      return {
        x: topLeft.x + numberValue(target.x),
        y: topLeft.y + numberValue(target.y),
        sessionId: center.sessionId
      };
    }
    if (target.x !== undefined || target.y !== undefined) {
      return pointFrom(target);
    }
  }
  throw new Error(`invalid mouse target: ${JSON.stringify(target)}`);
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

function scrollByParams(amount: number | ScrollByOptions, options: ScrollByOptions) {
  const input = amount && typeof amount === "object" && !Array.isArray(amount) ? amount : options;
  const top = amount && typeof amount === "object" && !Array.isArray(amount)
    ? input.top ?? input.dy ?? 900
    : input.top ?? input.dy ?? amount;
  return {
    left: numberValue(input.left ?? input.dx ?? 0),
    top: numberValue(top),
    behavior: input.behavior === "smooth" ? "smooth" : "instant"
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

async function conditionMet(condition: ScrollUntilCondition, state: ScrollState) {
  if (!condition) {
    return false;
  }
  if (typeof condition === "function") {
    return Boolean(await condition(state));
  }
  if (typeof condition === "string") {
    return Boolean(await js(`Boolean(${condition})`));
  }
  throw new TypeError(`scrollToBottomUntil condition must be a function or string, got ${typeof condition}`);
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
