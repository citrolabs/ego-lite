import { cdp, evaluate } from "../cdp-eval.js";
import { browserCdp } from "../browser-runtime.js";
import { elementCenter } from "./observe.js";
import { resolveAndCall, withHandle } from "./element-ops.js";
import { waitForSelector } from "./waits.js";

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
  label?: string;
  timeout?: number;
};
type DragOptions = {
  button?: MouseButton;
  delay?: number;
  label?: string;
  timeout?: number;
};
type HoverOptions = {
  label?: string;
  timeout?: number;
};
type WheelOptions = {
  x?: number;
  y?: number;
};
type MouseEventOptions = Record<string, unknown>;

const INPUT_EVENT_DELAY_MS = 25;
const INPUT_DISPATCH_TIMEOUT_MS = 1000;
let currentMousePoint: Point = { x: 0, y: 0, sessionId: undefined };

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
 * @param {{button?: "left"|"middle"|"right", clickCount?: number, label?: string}} [options]
 * @returns {Promise<void>}
 */
export async function click(target: MouseTarget, options: ClickOptions = {}) {
  const point = await resolveMouseTarget(target, options.timeout);
  rememberMousePoint(point);
  const button = options.button || "left";
  const buttons = pressedButtons(button);
  const clickCount = options.clickCount ?? 1;
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
export async function dblclick(
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
  const point = await resolveMouseTarget(target, options.timeout);
  rememberMousePoint(point);
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
 * @param {{button?: "left"|"middle"|"right", delay?: number, label?: string}} [options]
 * @returns {Promise<void>}
 */
export async function drag(points: MouseTarget[], options: DragOptions = {}) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error("drag requires at least two points");
  }
  const resolved: Point[] = [];
  for (const point of points) {
    resolved.push(await resolveMouseTarget(point, options.timeout));
  }
  const button = options.button || "left";
  const buttons = pressedButtons(button);
  const first = resolved[0];
  const last = resolved.at(-1);
  if (last) {
    rememberMousePoint(last);
  }
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
      await inputEventDelay(options.delay > 0 ? options.delay : undefined);
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

/**
 * Press a mouse button at the current mouse position, Playwright-style.
 * @param {{button?: "left"|"middle"|"right", clickCount?: number}} [options]
 * @returns {Promise<void>}
 */
export async function down(options: ClickOptions = {}) {
  const button = options.button || "left";
  await dispatchMouse(currentMousePoint, "mousePressed", {
    button,
    buttons: pressedButtons(button),
    clickCount: options.clickCount ?? 1,
  });
}

/**
 * Release a mouse button at the current mouse position, Playwright-style.
 * @param {{button?: "left"|"middle"|"right", clickCount?: number}} [options]
 * @returns {Promise<void>}
 */
export async function up(options: ClickOptions = {}) {
  const button = options.button || "left";
  await dispatchMouse(currentMousePoint, "mouseReleased", {
    button,
    buttons: 0,
    clickCount: options.clickCount ?? 1,
  });
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
 * Dispatch a mouse wheel scroll, Playwright-style (mouse.wheel(deltaX, deltaY)).
 *
 * Sign convention follows the DOM WheelEvent: positive deltaY scrolls down,
 * negative scrolls up (CDP negates deltas internally when building the Blink
 * wheel event, so the DOM convention applies end to end). Defaults to scrolling
 * down by 300 CSS pixels.
 *
 * A visible, focused page receives the wheel through CDP
 * (Input.dispatchMouseEvent), exactly like Playwright. A backgrounded or
 * unfocused tab silently drops CDP wheel input, so there the scroll is
 * dispatched as a synthetic WheelEvent on the element at (x, y) instead.
 *
 * @param {number} [deltaX=0] Horizontal scroll delta in CSS pixels.
 * @param {number} [deltaY=300] Vertical scroll delta in CSS pixels; positive scrolls down.
 * @param {{x?: number, y?: number}} [options] Viewport point to dispatch the wheel at (default 0,0).
 * @returns {Promise<void>}
 */
export async function wheel(
  deltaX = 0,
  deltaY = 300,
  options: WheelOptions = {},
) {
  const x = numberValue(options.x ?? 0);
  const y = numberValue(options.y ?? 0);
  const dx = numberValue(deltaX);
  const dy = numberValue(deltaY);
  if (await isVisibleAndFocused()) {
    await browserCdp(
      "Input.dispatchMouseEvent",
      { type: "mouseWheel", x, y, deltaX: dx, deltaY: dy },
      undefined,
      1000,
    );
    return;
  }
  await dispatchSyntheticWheel(x, y, dx, dy);
}

/**
 * Whether the page is currently visible and focused. CDP wheel input is
 * delivered only to a foreground, focused target; otherwise wheel() routes
 * through a synthetic WheelEvent. Defaults to true when the probe fails so a
 * flaky probe never blocks a real foreground scroll.
 */
async function isVisibleAndFocused() {
  try {
    return Boolean(
      await evaluate(
        "document.visibilityState === 'visible' && document.hasFocus()",
      ),
    );
  } catch {
    return true;
  }
}

/**
 * Dispatch a synthetic WheelEvent on the element under (x, y), then perform the
 * native scroll. Used when the tab is backgrounded/unfocused and CDP wheel input
 * would be dropped. The WheelEvent triggers page wheel handlers (virtualized
 * lists, custom scrollers); the window.scrollBy actually moves an ordinary page,
 * since an untrusted WheelEvent does not perform the default scroll action.
 * The manual scroll is skipped when a handler calls preventDefault(), matching
 * how a real CDP wheel leaves the page in place (maps, canvases, custom scrollers).
 */
async function dispatchSyntheticWheel(
  x: number,
  y: number,
  deltaX: number,
  deltaY: number,
) {
  await evaluate(`(() => {
    const target = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)})
      || document.scrollingElement || document.body;
    if (!target) return;
    const notPrevented = target.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaX: ${JSON.stringify(deltaX)},
      deltaY: ${JSON.stringify(deltaY)},
      clientX: ${JSON.stringify(x)},
      clientY: ${JSON.stringify(y)}
    }));
    if (notPrevented) {
      window.scrollBy(${JSON.stringify(deltaX)}, ${JSON.stringify(deltaY)});
    }
  })()`);
}

/**
 * Scroll an element into view only if it is not already fully visible,
 * mirroring Playwright's locator.scrollIntoViewIfNeeded.
 *
 * Scrolls browser-side through CDP DOM.scrollIntoViewIfNeeded, as Playwright
 * does: the scroll must be instant — under an animated scroll, callers that
 * read the element's position right after this (click() resolving its point,
 * for one) would aim at where the element used to be — and the browser-side
 * scroll stays instant regardless of CSS `scroll-behavior: smooth`, is not
 * subject to the page's CSP, and moves scroll containers in ancestor
 * documents. When the CDP method fails (bridge without the DOM domain, no
 * layout box), it falls back to an in-page scroll under a temporary
 * scroll-behavior override; a strict `style-src` CSP can reject that override,
 * which is why the CDP path comes first.
 * @param {string} selector CSS selector or @ref of the element to reveal.
 * @returns {Promise<void>}
 */
export async function scrollIntoViewIfNeeded(selector: string) {
  const scrolled = await withHandle(
    selector,
    async ({ objectId, sessionId }) => {
      try {
        await cdp("DOM.scrollIntoViewIfNeeded", { objectId }, sessionId);
        return true;
      } catch {
        return false;
      }
    },
  );
  if (scrolled) return;
  await resolveAndCall(
    selector,
    `function(){
      const override = document.createElement("style");
      override.textContent = "*{scroll-behavior:auto !important}";
      (document.head || document.documentElement).appendChild(override);
      try {
        if (typeof this.scrollIntoViewIfNeeded === "function") {
          this.scrollIntoViewIfNeeded(true);
        } else {
          this.scrollIntoView({ block: "center", inline: "center" });
        }
      } finally {
        override.remove();
      }
    }`,
  );
}

function maybeHighlight(point: Point, label?: string) {
  const ego = (globalThis as any).ego;
  if (!ego) return;
  ego.animationHighlightMouseToPosition?.(point.x, point.y);
  if (label) {
    ego.setAgentTaskState?.(label);
  }
}

function rememberMousePoint(point: Point) {
  currentMousePoint = { ...point };
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

async function resolveMouseTarget(
  target: MouseTarget,
  timeout = undefined,
): Promise<Point> {
  if (typeof target === "string") {
    await waitForSelector(target, { timeout, state: "visible" });
    await scrollIntoViewIfNeeded(target);
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
        await waitForSelector(target.selector, { timeout, state: "visible" });
        await scrollIntoViewIfNeeded(target.selector);
        return elementCenter(target.selector);
      }
      await waitForSelector(target.selector, { timeout, state: "visible" });
      await scrollIntoViewIfNeeded(target.selector);
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
