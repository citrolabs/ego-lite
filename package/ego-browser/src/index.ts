#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import * as helpers from "./helpers.js";
import {
  clearPreferredTarget,
  invalidateSession,
  setPreferredTarget,
} from "./browser-runtime.js";
import { formatCliLogValue } from "./format.js";
import { installLegacySkillGuards } from "./legacy-skill-guard.js";
import {
  bufferOutput,
  installLifecycleFlush,
  resetSink,
  setNoticeTrailer,
} from "./output-sink.js";
import { runMain } from "./run.js";
import { emitUpdateNotice, type VersionSource } from "./update-notice.js";

type HelperFunction = (...args: unknown[]) => unknown;
type EgoRuntime = Record<string, unknown> & {
  helpers?: Record<string, unknown>;
  learnings?: Record<string, unknown>;
};
type InstallTarget = Record<string, unknown> & {
  ego?: EgoRuntime;
};
type InstallEgoSdkOptions = {
  context?: Record<string, unknown>;
  ready?: unknown;
  // Host-provided output sink, bound to console.log (the agent's output channel).
  // When omitted, the buffered default is used and flushed on process teardown.
  cliLog?: HelperFunction;
};

export * from "./helpers.js";
export { runMain } from "./run.js";

const SYNC_HELPERS = new Set(["help"]);
const SYNC_FACTORY_HELPERS = new Set([
  "page.locator",
  "page.getByRole",
  "page.getByText",
  "page.getByLabel",
  "page.getByPlaceholder",
  "page.getByAltText",
  "page.getByTitle",
  "page.getByTestId",
  "page.locator.first",
  "page.locator.nth",
  "page.locator.last",
  "page.locator.locator",
  "page.locator.getByRole",
  "page.locator.getByText",
  "page.locator.getByLabel",
  "page.locator.getByPlaceholder",
  "page.locator.getByAltText",
  "page.locator.getByTitle",
  "page.locator.getByTestId",
  "page.locator.filter",
]);
const SYNC_FACTORY_METHODS = new Set([
  "locator",
  "getByRole",
  "getByText",
  "getByLabel",
  "getByPlaceholder",
  "getByAltText",
  "getByTitle",
  "getByTestId",
  "first",
  "nth",
  "last",
  "filter",
]);
// Marks an ego runtime whose mutating methods have already been wrapped, so a
// second installEgoSdk call cannot double-wrap createTab / task-space methods.
const EGO_WRAPPED = Symbol.for("egoBrowser.sdkWrapped");

export function installEgoSdk(
  target: InstallTarget = globalThis,
  options: InstallEgoSdkOptions = {},
) {
  if (!target || typeof target !== "object") {
    return target;
  }
  const context = options.context || helpers.helperContext();
  const readySignal = Promise.resolve(options.ready);
  let readyError = null;
  readySignal.catch((error) => {
    readyError = error;
  });
  const installed: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(context)) {
    const exposed = SYNC_HELPERS.has(name)
      ? value
      : wrapReady(value, readySignal, () => readyError, [name]);
    Object.defineProperty(target, name, {
      value: exposed,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    installed[name] = exposed;
  }
  installLegacySkillGuards(target);
  const usingDefaultLog = !options.cliLog;
  // The agent's primary output channel is console.log. Route it through the host's
  // sink (options.cliLog) when provided, otherwise the buffered default. There is no
  // dedicated cliLog global anymore; console.error/warn are left untouched. Each
  // heredoc runs in its own short-lived process, so overriding the global is per-run.
  console.log = options.cliLog || createBufferedLog();
  if (usingDefaultLog) {
    // SDK path: the host runs each heredoc in a fresh short-lived process and never
    // calls execute(), so reset the per-run sink and flush it on process teardown.
    resetSink();
    installLifecycleFlush(process.stdout);
  }
  if (target.ego && typeof target.ego === "object") {
    // Fire-and-forget update hint. Route the resolved line to the same channel the
    // command's own output uses: the buffered-sink path registers it as a trailer the
    // sink appends after that output (so it reads as a footer, not a prefix), while a
    // host-provided cliLog gets the line directly. Never touches process.stdout blindly.
    emitUpdateNotice(
      target.ego as { getBrowserVersion?: VersionSource },
      usingDefaultLog ? setNoticeTrailer : (line) => options.cliLog?.(line),
    );
    target.ego.helpers = installed;
    target.ego.learnings =
      installed.site && typeof installed.site === "object"
        ? (installed.site as Record<string, unknown>)
        : {};
    if (!(target.ego as Record<symbol, unknown>)[EGO_WRAPPED]) {
      wrapCreateTab(target.ego);
      wrapInvalidating(target.ego, [
        "useTaskSpace",
        "closeTaskSpace",
        "createTaskSpace",
        "claimTaskSpace",
      ]);
      Object.defineProperty(target.ego, EGO_WRAPPED, {
        value: true,
        enumerable: false,
      });
    }
    exposeEgoMethods(target, target.ego);
  }
  return target;
}

function wrapReady(
  value: unknown,
  readySignal: Promise<unknown>,
  readyError: () => unknown,
  path: string[] = [],
): unknown {
  if (typeof value === "function") {
    if (isSyncFactoryHelper(path)) {
      return (...args: unknown[]) =>
        wrapReady(value(...args), readySignal, readyError, path);
    }
    return async (...args: unknown[]) => {
      await readySignal;
      const error = readyError();
      if (error) {
        throw error;
      }
      return value(...args);
    };
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const wrapped: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    wrapped[key] = wrapReady(child, readySignal, readyError, [...path, key]);
  }
  return wrapped;
}

function isSyncFactoryHelper(path: string[]) {
  if (SYNC_FACTORY_HELPERS.has(path.join("."))) {
    return true;
  }
  return path[0] === "page" && SYNC_FACTORY_METHODS.has(path.at(-1) || "");
}

if (isDirectCli()) {
  try {
    process.exitCode = await runMain();
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }
} else {
  installEgoSdk();
}

function createBufferedLog() {
  return (...args: unknown[]) => {
    // Buffer instead of writing through: a hard stop later in the run must be able to
    // discard everything logged so far. The buffer is flushed on process teardown.
    bufferOutput(`${args.map(formatCliLogValue).join(" ")}\n`);
  };
}

function isDirectCli() {
  return (
    process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
  );
}

function wrapInvalidating(ego: EgoRuntime, methodNames: string[]) {
  for (const name of methodNames) {
    const original = ego[name];
    if (typeof original !== "function") continue;
    const after = () => {
      invalidateSession();
      clearPreferredTarget();
    };
    ego[name] = function (...args: unknown[]) {
      const result = original.apply(this, args);
      if (result && typeof result.then === "function") {
        return result.then((value) => {
          after();
          return value;
        });
      }
      after();
      return result;
    };
  }
}

function wrapCreateTab(ego: EgoRuntime) {
  const original = ego.createTab;
  if (typeof original !== "function") return;
  ego.createTab = function (...args: unknown[]) {
    const result = original.apply(this, args);
    if (result && typeof result.then === "function") {
      return result.then((value) => {
        invalidateSession();
        const id = value?.targetId || value?.result?.targetId;
        if (id) setPreferredTarget(id);
        return value;
      });
    }
    invalidateSession();
    return result;
  };
}

function exposeEgoMethods(target: InstallTarget, ego: EgoRuntime) {
  const skip = new Set([
    "helpers",
    "learnings",
    "useTaskSpace",
    "createTaskSpace",
    "claimTaskSpace",
    "closeTaskSpace",
  ]);
  for (const key of Object.keys(ego)) {
    if (skip.has(key)) continue;
    if (key in target) continue;
    const value = ego[key];
    if (typeof value !== "function") continue;
    const bound = value.bind(ego);
    Object.defineProperty(target, key, {
      value: bound,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
}
