import { join } from "node:path";
import { tmpdir } from "node:os";

import { state } from "../state.js";
import { cdp, js } from "../cdp-eval.js";
import { pageInfo } from "./nav.js";
import { browserEgo, browserSnapshotRefsToRefMap, drainBrowserEvents } from "../browser-runtime.js";
import { resolveElementCenter, resolveElementObjectId } from "../element-resolver.js";
import { parseRef, RefMap } from "../ref-map.js";

const browserRefMap = new RefMap();
let ensuringRefMap = false;

async function ensureRefMapForRef(selectorOrRef: unknown) {
  if (ensuringRefMap) return;
  if (typeof selectorOrRef !== "string") return;
  if (!parseRef(selectorOrRef)) return;
  if (browserRefMap.map.size > 0) return;
  ensuringRefMap = true;
  try {
    await snapshot();
  } finally {
    ensuringRefMap = false;
  }
}

type SnapshotOptions = {
  scope?: "only_within_viewport" | "full_page";
  includeActionMarks?: boolean;
  includeStableLocator?: boolean;
};

type ScreenshotClip = {
  x: number;
  y: number;
  width: number;
  height: number;
  scale?: number;
};

type CaptureScreenshotOptions = {
  full?: boolean;
  raw?: boolean;
  clip?: ScreenshotClip;
};

export async function drainEvents() {
  return drainBrowserEvents();
}

export async function snapshot(options: SnapshotOptions = {}) {
  const result = await browserEgo().snapshot(options);
  browserSnapshotRefsToRefMap(browserRefMap, result.refs || []);
  return result;
}

export const snapshotRaw = snapshot;

/**
 * Return snapshot content with agent-friendly defaults.
 * @param {{scope?: "only_within_viewport"|"full_page", includeActionMarks?: boolean, includeStableLocator?: boolean}} [options]
 * @returns {Promise<string>}
 */
export async function snapshotText(options: SnapshotOptions = {}) {
  const result = await snapshot({
    scope: options.scope ?? "full_page",
    includeActionMarks: options.includeActionMarks ?? true,
    includeStableLocator: options.includeStableLocator ?? true
  });
  return result.content || "";
}

export async function elementEval(selectorOrRef, fn, ...args) {
  await ensureRefMapForRef(selectorOrRef);
  const functionDeclaration = typeof fn === "function" ? fn.toString() : String(fn);
  return evaluateBrowserElement(selectorOrRef, functionDeclaration, args);
}

export async function elementCenter(selectorOrRef) {
  await ensureRefMapForRef(selectorOrRef);
  return resolveElementCenter({ sendRaw: cdp }, undefined, browserRefMap, selectorOrRef);
}

export async function fillElement(selectorOrRef, value) {
  await ensureRefMapForRef(selectorOrRef);
  const resolved = await resolveElementObjectId({ sendRaw: cdp }, undefined, browserRefMap, selectorOrRef);
  await cdp("Runtime.callFunctionOn", {
    functionDeclaration: "function() { this.focus(); }",
    objectId: resolved.objectId,
    returnByValue: true,
    awaitPromise: false
  }, resolved.sessionId);
  await cdp("Runtime.callFunctionOn", {
    functionDeclaration: "function() { this.select && this.select(); this.value = ''; this.dispatchEvent(new Event('input', { bubbles: true })); }",
    objectId: resolved.objectId,
    returnByValue: true,
    awaitPromise: false
  }, resolved.sessionId);
  await cdp("Input.insertText", { text: String(value) });
}

export async function captureScreenshot(path = join(tmpdir(), "ego-browser-shot.png"), options: CaptureScreenshotOptions = {}) {
  const full = options.full ?? false;
  const raw = options.raw ?? false;
  const params: any = {
    format: "png",
    captureBeyondViewport: full
  };
  if (raw) {
    if (options.clip) {
      params.clip = { ...options.clip };
    }
  } else {
    const dpr = Number(await js("window.devicePixelRatio")) || 1;
    const cssScale = 1 / dpr;
    if (options.clip) {
      params.clip = { scale: cssScale, ...options.clip };
    } else {
      const info = await pageInfo();
      params.clip = {
        x: 0,
        y: 0,
        width: full ? info.pw : info.w,
        height: full ? info.ph : info.h,
        scale: cssScale
      };
    }
  }
  const result = await cdp("Page.captureScreenshot", params);
  await state.writeFile(path, Buffer.from(result.data, "base64"));
  return path;
}

async function evaluateBrowserElement(selectorOrRef, functionDeclaration, args) {
  const resolved = await resolveElementObjectId({ sendRaw: cdp }, undefined, browserRefMap, selectorOrRef);
  const response = await cdp("Runtime.callFunctionOn", {
    functionDeclaration,
    objectId: resolved.objectId,
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
    awaitPromise: true
  }, resolved.sessionId);
  return remoteValue(response);
}

function remoteValue(response) {
  const result = response.result || {};
  if (Object.hasOwn(result, "value")) {
    return result.value;
  }
  if (Object.hasOwn(result, "unserializableValue")) {
    return result.unserializableValue;
  }
  return null;
}
