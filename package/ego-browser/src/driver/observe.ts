import { randomInt } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";

import { state } from "../state.js";
import { cdp, runtimeValue } from "../cdp-eval.js";
import {
  browserEgo,
  browserSnapshotRefsToRefMap,
  drainBrowserEvents,
  ensureSession,
  isBrowserRuntime,
} from "../browser-runtime.js";
import { invokeEgo } from "../ego-errors.js";
import { resolveElementCenter } from "../element-resolver.js";
import { resolveInPageFrames } from "./element-ops.js";
import { compactSnapshotResult } from "../snapshot-result.js";
import {
  browserRefMap,
  ensureRefMapForRef,
  registerSnapshotForRefRefresh,
} from "../ref-state.js";
import {
  filterSnapshotContent,
  type SnapshotFilterOptions,
} from "./snapshot-filter.js";

export type SnapshotOptions = SnapshotFilterOptions & {
  scope?: "only_within_viewport" | "full_page" | "subtree";
  root?: number;
  includeActionMarks?: boolean;
  includeStableLocator?: boolean;
};

// Post-processing-only options that the native `ego.snapshot` contract does not
// understand. Keeping them here means adding a filter never leaks a foreign key
// into the browser bridge.
const FILTER_OPTION_KEYS = [
  "interactiveOnly",
  "roles",
  "match",
  "maxChars",
  "urls",
] as const;

type ScreenshotClip = {
  x: number;
  y: number;
  width: number;
  height: number;
  scale?: number;
};

export type ScreenshotScale = "css";

export type CaptureScreenshotOptions = {
  full?: boolean;
  raw?: boolean;
  clip?: ScreenshotClip;
  scale?: ScreenshotScale;
};

function egoSnapshotOptions(options: SnapshotOptions = {}) {
  const egoOptions: Record<string, unknown> = { ...options };
  for (const key of FILTER_OPTION_KEYS) {
    delete egoOptions[key];
  }
  return egoOptions;
}

function filterOptions(options: SnapshotOptions = {}): SnapshotFilterOptions {
  return {
    interactiveOnly: options.interactiveOnly,
    roles: options.roles,
    match: options.match,
    maxChars: options.maxChars,
    urls: options.urls,
  };
}

export async function drainEvents() {
  const sessionId = isBrowserRuntime() ? await ensureSession() : undefined;
  return drainBrowserEvents(sessionId);
}

export async function snapshot(options: SnapshotOptions = {}) {
  // Filter keys are post-processing only; the native ego.snapshot bridge must
  // never receive them.
  let result: any = await invokeEgo("snapshot", () =>
    browserEgo().snapshot(egoSnapshotOptions(options)),
  );
  compactSnapshotResult(result);
  browserSnapshotRefsToRefMap(browserRefMap, result.refs || []);
  const filters = filterOptions(options);
  if (result.content != null) {
    result = {
      ...result,
      content: filterSnapshotContent(result.content, filters),
    };
  }
  return result;
}

registerSnapshotForRefRefresh(() => snapshot());

export const snapshotRaw = snapshot;

/**
 * Return snapshot content with agent-friendly defaults. Use snapshotRaw / snapshot
 * when you need the structured { content, refs } result.
 * @param {{scope?: "only_within_viewport"|"full_page"|"subtree", root?: number, includeActionMarks?: boolean, includeStableLocator?: boolean, interactiveOnly?: boolean, roles?: string[], match?: string|RegExp, maxChars?: number, urls?: "none"|"host_path"}} [options]
 * @returns {Promise<string>}
 */
export async function snapshotText(options: SnapshotOptions = {}) {
  const result = await snapshot({
    scope: options.scope ?? "full_page",
    ...(options.root === undefined ? {} : { root: options.root }),
    includeActionMarks: options.includeActionMarks ?? true,
    includeStableLocator: options.includeStableLocator ?? true,
    interactiveOnly: options.interactiveOnly,
    roles: options.roles,
    match: options.match,
    maxChars: options.maxChars,
    urls: options.urls,
  });
  return result.content || "";
}

export async function elementCenter(selectorOrRef) {
  await ensureRefMapForRef(selectorOrRef);
  return resolveInPageFrames(selectorOrRef, (iframeSessions) =>
    resolveElementCenter(
      { sendRaw: cdp },
      undefined,
      browserRefMap,
      selectorOrRef,
      iframeSessions,
    ),
  );
}

/**
 * Directory and name for a screenshot taken without an explicit path.
 *
 * The embedded host runs every script in one long-lived Node process, giving
 * each run its own `globalThis` but sharing `process.env`, `os.tmpdir()` and
 * the pid. A host that needs per-run output sets
 * `globalThis.EGO_BROWSER_OUTPUT_DIR` to an absolute directory; a random
 * six-digit suffix keeps concurrent runs in the shared default directory from
 * overwriting each other while staying short enough to read back easily.
 */
function defaultScreenshotPath(): string {
  const outputDir = (globalThis as { EGO_BROWSER_OUTPUT_DIR?: unknown })
    .EGO_BROWSER_OUTPUT_DIR;
  let directory = tmpdir();
  if (outputDir !== undefined) {
    // Same rule as an explicit screenshot path: the Node context does not run
    // in the caller's working directory, so a relative directory would land
    // somewhere unexpected (or fail with EPERM on Windows).
    if (
      typeof outputDir !== "string" ||
      outputDir.length === 0 ||
      !isAbsolute(outputDir)
    ) {
      throw new TypeError(
        "globalThis.EGO_BROWSER_OUTPUT_DIR must be an absolute directory path",
      );
    }
    directory = outputDir;
  }
  const suffix = String(randomInt(0, 1_000_000)).padStart(6, "0");
  return join(directory, `ego-browser-shot-${suffix}.png`);
}

export async function captureScreenshot(
  path?: string,
  options: CaptureScreenshotOptions = {},
) {
  assertScreenshotScale(options.scale);
  const sessionId = isBrowserRuntime() ? await ensureSession() : undefined;
  return captureScreenshotForSession(path, options, sessionId);
}

/**
 * Capture a screenshot through one explicit target session. Page objects use
 * this entry point so another active tab cannot affect evaluation or capture.
 */
export async function captureScreenshotForSession(
  path?: string,
  options: CaptureScreenshotOptions = {},
  sessionId?: string,
) {
  assertScreenshotScale(options.scale);
  const outputPath = path ?? defaultScreenshotPath();
  const full = options.full ?? false;
  // CSS-pixel sizing is the default and the only declarative scale mode. Keep
  // the legacy raw flag as an internal compatibility escape hatch.
  const scale = options.scale ?? "css";
  const raw = scale === "css" ? false : (options.raw ?? false);
  const params: any = {
    format: "png",
    captureBeyondViewport: full,
  };
  if (raw) {
    if (options.clip) {
      params.clip = { ...options.clip };
    }
  } else {
    const dprExpression = "window.devicePixelRatio";
    const dpr =
      Number(
        runtimeValue(
          await cdp(
            "Runtime.evaluate",
            {
              expression: dprExpression,
              returnByValue: true,
            },
            sessionId,
          ),
          dprExpression,
        ),
      ) || 1;
    const cssScale = 1 / dpr;
    if (options.clip) {
      params.clip = { scale: cssScale, ...options.clip };
    } else {
      const infoExpression =
        "({url:location.href,title:document.title,w:innerWidth,h:innerHeight,sx:scrollX,sy:scrollY,pw:document.documentElement.scrollWidth,ph:document.documentElement.scrollHeight})";
      const info = runtimeValue(
        await cdp(
          "Runtime.evaluate",
          {
            expression: infoExpression,
            returnByValue: true,
          },
          sessionId,
        ),
        infoExpression,
      );
      params.clip = {
        // CDP interprets clip coordinates in the page's document coordinate
        // space. A viewport screenshot therefore starts at the current scroll
        // offset, while a full-page screenshot still starts at the document
        // origin.
        x: full ? 0 : info.sx,
        y: full ? 0 : info.sy,
        width: full ? info.pw : info.w,
        height: full ? info.ph : info.h,
        scale: cssScale,
      };
    }
  }
  const result = await cdp("Page.captureScreenshot", params, sessionId);
  await mkdir(dirname(outputPath), { recursive: true });
  await state.writeFile(outputPath, Buffer.from(result.data, "base64"));
  return outputPath;
}

function assertScreenshotScale(
  scale: unknown,
): asserts scale is ScreenshotScale | undefined {
  if (scale !== undefined && scale !== "css") {
    throw new TypeError("captureScreenshot scale must be css");
  }
}

export {
  filterSnapshotContent,
  type SnapshotFilterOptions,
} from "./snapshot-filter.js";
