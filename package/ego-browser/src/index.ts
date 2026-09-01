#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import * as helpers from "./helpers.js";
import {
  clearPreferredTarget,
  disposeBrowserRuntime,
  invalidateSession,
  setPreferredTarget,
} from "./browser-runtime.js";
import { formatCliLogValue } from "./format.js";
import {
  bufferOutput,
  createRoundConsole,
  installLifecycleFlush,
  resetSink,
} from "./output-sink.js";
import { runMain } from "./run.js";
import { installStaleEgoBrowserGuard } from "./skill-migration.js";
import { emitUpdateNotice } from "./update-notice.js";
import { installPageContextGuard } from "./page-context-guard.js";
import { disposeDownloadArtifacts } from "./driver/downloads.js";

type HelperFunction = (...args: unknown[]) => unknown;
type EgoRuntime = Record<string, unknown> & {
  helpers?: Record<string, HelperFunction>;
  learnings?: Record<string, unknown>;
  getBrowserVersion?: () => unknown | Promise<unknown>;
  onCDPMessage?: (payload: string) => void;
  onSendCDPMessageError?: (message: unknown, errorCode?: string) => void;
};
type InstallTarget = Record<string, unknown> & {
  ego?: EgoRuntime;
};
type InstallEgoSdkOptions = {
  context?: Record<string, unknown>;
  ready?: unknown;
  cliLog?: HelperFunction;
};

export * from "./helpers.js";
export { runMain } from "./run.js";

/** Release native callbacks before the host discards an embedded Node context. */
export async function disposeEgoSdk(target: InstallTarget = globalThis) {
  disposeDownloadArtifacts();
  disposeBrowserRuntime(target.ego);
}

const SYNC_HELPERS = new Set(["help"]);
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
  if (target === globalThis) installPageContextGuard(target);
  const context = options.context || helpers.helperContext();
  const readySignal = Promise.resolve(options.ready);
  // The host may reject readiness before a helper is called. Mark the promise
  // as observed while preserving the same rejection for every helper await.
  void readySignal.catch(() => {});
  const installed: Record<string, HelperFunction> = {};
  for (const [name, value] of Object.entries(context)) {
    if (typeof value !== "function") {
      continue;
    }
    const exposed = SYNC_HELPERS.has(name)
      ? value
      : async (...args: unknown[]) => {
          await readySignal;
          return value(...args);
        };
    Object.defineProperty(target, name, {
      value: exposed,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    installed[name] = exposed as HelperFunction;
  }
  // Non-function values are intentionally absent from the normal helper loop.
  // Install the 1.3 migration guard explicitly so embedded SDK execution and
  // the direct CLI produce the same actionable error.
  installStaleEgoBrowserGuard(target);
  const usingDefaultCliLog = !options.cliLog;
  const cliLogFn = options.cliLog || createCliLog();
  Object.defineProperty(target, "cliLog", {
    value: cliLogFn,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  installed.cliLog = cliLogFn;
  Object.defineProperty(target, "console", {
    value: createRoundConsole(
      usingDefaultCliLog
        ? undefined
        : (line) => cliLogFn(line.endsWith("\n") ? line.slice(0, -1) : line),
    ),
    writable: true,
    configurable: true,
    enumerable: false,
  });
  if (usingDefaultCliLog) {
    // SDK path: the host runs each heredoc in a fresh short-lived process and never
    // calls execute(), so reset the per-run sink and flush it on process teardown.
    resetSink();
    installLifecycleFlush(process.stdout);
  }
  if (target.ego && typeof target.ego === "object") {
    void emitUpdateNotice(target.ego, (line) => {
      if (usingDefaultCliLog) bufferOutput(`${line}\n`);
      else cliLogFn(line);
    });
    target.ego.helpers = installed;
    target.ego.learnings = {};
    if (!(target.ego as Record<symbol, unknown>)[EGO_WRAPPED]) {
      const taskSelection: { spaceId?: unknown } = {};
      wrapCreateTab(target.ego);
      wrapUseTaskSpace(target.ego, taskSelection);
      wrapInvalidating(
        target.ego,
        ["closeTaskSpace", "createTaskSpace", "claimTaskSpace"],
        () => {
          taskSelection.spaceId = undefined;
        },
      );
      Object.defineProperty(target.ego, EGO_WRAPPED, {
        value: true,
        enumerable: false,
      });
    }
    exposeEgoMethods(target, target.ego);
  }
  return target;
}

if (isDirectCli()) {
  try {
    process.exitCode = await runMain();
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  } finally {
    disposeDownloadArtifacts();
  }
} else {
  installEgoSdk();
}

function createCliLog() {
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

function wrapInvalidating(
  ego: EgoRuntime,
  methodNames: string[],
  resetSelection: () => void = () => {},
) {
  for (const name of methodNames) {
    const original = ego[name];
    if (typeof original !== "function") continue;
    const after = () => {
      resetSelection();
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

function wrapUseTaskSpace(ego: EgoRuntime, selection: { spaceId?: unknown }) {
  // File chooser waits and other event subscriptions span multiple Page calls.
  // Re-selecting the same space must preserve their CDP session; changing the
  // space still invalidates every session because native routing is global.
  const original = ego.useTaskSpace;
  if (typeof original !== "function") return;
  const after = (spaceId: unknown, value: unknown) => {
    if (value && typeof value === "object" && Object.hasOwn(value, "error")) {
      return value;
    }
    if (selection.spaceId !== spaceId) {
      invalidateSession();
      clearPreferredTarget();
      selection.spaceId = spaceId;
    }
    return value;
  };
  ego.useTaskSpace = function (...args: unknown[]) {
    const result = original.apply(this, args);
    if (result && typeof result.then === "function") {
      return result.then((value) => after(args[0], value));
    }
    return after(args[0], result);
  };
}

function wrapCreateTab(ego: EgoRuntime) {
  const original = ego.createTab;
  if (typeof original !== "function") return;
  ego.createTab = function (...args: unknown[]) {
    const result = original.apply(this, args);
    if (result && typeof result.then === "function") {
      return result.then((value) => {
        const id = value?.targetId || value?.result?.targetId;
        if (id) setPreferredTarget(id);
        return value;
      });
    }
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
