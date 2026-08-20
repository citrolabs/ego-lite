import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { state } from "../state.js";
import { cdp, evaluate } from "../cdp-eval.js";
import { pageInfo } from "./nav.js";
import {
  browserEgo,
  browserSnapshotRefsToRefMap,
  drainBrowserEvents,
  ensureSession,
  isBrowserRuntime,
  pendingDialog,
} from "../browser-runtime.js";
import { buildEgoError } from "../ego-errors.js";
import { resolveElementCenter } from "../element-resolver.js";
import {
  browserRefMap,
  ensureRefMapForRef,
  registerSnapshotForRefRefresh,
} from "../ref-state.js";

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

type ScreenshotOptions = {
  path?: string;
  fullPage?: boolean;
  raw?: boolean;
  clip?: ScreenshotClip;
};

export function drainEvents() {
  return drainBrowserEvents();
}

export async function snapshotRaw(options: SnapshotOptions = {}) {
  let result;
  try {
    result = await browserEgo().snapshot(options);
  } catch (err) {
    // ego.snapshot rejects directly (it never resolves with { error }), so it never
    // reached buildEgoError — the single birthplace that records a hard stop for the
    // output sink and swaps native wording for ego-browser's owned guidance. Route the
    // rejection through it so a swallowed snapshot hard stop collapses like every other
    // ego error instead of leaking repeated native text.
    throw buildEgoError(err, "snapshot");
  }
  browserSnapshotRefsToRefMap(browserRefMap, result.refs || []);
  return result;
}

registerSnapshotForRefRefresh(() => snapshotRaw());

/**
 * Return snapshot content with agent-friendly defaults. The text surface most
 * agents want; use snapshotRaw when you need the structured { content, refs }.
 * @param {{scope?: "only_within_viewport"|"full_page", includeActionMarks?: boolean, includeStableLocator?: boolean}} [options]
 * @returns {Promise<string>}
 */
export async function snapshot(options: SnapshotOptions = {}) {
  const result = await snapshotRaw({
    scope: options.scope ?? "full_page",
    includeActionMarks: options.includeActionMarks ?? true,
    includeStableLocator: options.includeStableLocator ?? true,
  });
  return result.content || "";
}

export async function elementCenter(selectorOrRef) {
  await ensureRefMapForRef(selectorOrRef);
  return resolveElementCenter(
    { sendRaw: cdp },
    undefined,
    browserRefMap,
    selectorOrRef,
  );
}

// Sequence number for default screenshot file names. Combined with the pid it
// keeps concurrent agent processes (parallel task spaces) from overwriting each
// other's shots in the shared tmpdir, and successive shots in one run distinct.
let screenshotSeq = 0;

export async function screenshot(options: ScreenshotOptions = {}) {
  const path =
    options.path ??
    join(tmpdir(), `ego-browser-shot-${process.pid}-${++screenshotSeq}.png`);
  const full = options.fullPage ?? false;
  const raw = options.raw ?? false;
  const params: any = {
    format: "png",
    captureBeyondViewport: full,
  };
  if (raw) {
    if (options.clip) {
      params.clip = { ...options.clip };
    }
  } else {
    if (isBrowserRuntime()) {
      await ensureSession();
    }
    if (!pendingDialog()) {
      const dpr = Number(await evaluate("window.devicePixelRatio")) || 1;
      const cssScale = 1 / dpr;
      if (options.clip) {
        params.clip = { scale: cssScale, ...options.clip };
      } else {
        const info = await pageInfo();
        if ("dialog" in info) {
          return screenshot({ ...options, path, raw: true });
        }
        params.clip = {
          x: full ? 0 : info.sx,
          y: full ? 0 : info.sy,
          width: full ? info.pw : info.w,
          height: full ? info.ph : info.h,
          scale: cssScale,
        };
      }
    }
  }
  const result = await cdp("Page.captureScreenshot", params);
  await mkdir(dirname(path), { recursive: true });
  await state.writeFile(path, Buffer.from(result.data, "base64"));
  return path;
}
