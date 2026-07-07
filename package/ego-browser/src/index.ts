#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import * as helpers from "./helpers.js";
import {
  clearPreferredTarget,
  invalidateSession,
  setPreferredTarget,
} from "./browser-runtime.js";
import { formatCliLogValue } from "./format.js";
import {
  beginOutputBoundary,
  bufferOutput,
  finishOutputBoundary,
  installLifecycleFlush,
  isInsideOutputBoundary,
  outputCaptureFromTarget,
  flushSink,
  resetSink,
  setNoticeTrailer,
} from "./output-sink.js";
import { runMain } from "./run.js";
import { emitUpdateNotice, type VersionSource } from "./update-notice.js";

type HelperFunction = (...args: unknown[]) => unknown;
type EgoRuntime = Record<string, unknown> & {
  helpers?: Record<string, HelperFunction>;
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
// Marks an ego runtime whose mutating methods have already been wrapped, so a
// second installEgoSdk call cannot double-wrap createTab / task-space methods.
const EGO_WRAPPED = Symbol.for("egoBrowser.sdkWrapped");
const OUTPUT_BOUNDARY_WRAPPED = Symbol.for("egoBrowser.outputBoundaryWrapped");

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
  const installed: Record<string, HelperFunction> = {};
  for (const [name, value] of Object.entries(context)) {
    if (typeof value !== "function") {
      continue;
    }
    const exposed = SYNC_HELPERS.has(name)
      ? value
      : async (...args: unknown[]) => {
          await readySignal;
          if (readyError) {
            throw readyError;
          }
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
  const usingDefaultLog = !options.cliLog;
  if (options.cliLog) {
    console.log = options.cliLog;
  } else {
    // Buffer console.log so a hard stop can collapse noisy business output into one
    // owned message. In app REPL mode, __egoCompleteReplEvaluation flushes this once
    // per cell; in short-lived SDK hosts, lifecycle hooks are the fallback.
    console.log = createBufferedLog();
  }
  resetSink();
  installLifecycleFlush(process.stdout);
  wrapEvaluationBoundary(target, "__egoEvaluateScript");
  wrapReplEvaluationBoundary(target);
  wrapReplCompleteBoundary(target);
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
    target.ego.learnings = {};
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

function wrapEvaluationBoundary(target: InstallTarget, name: string) {
  const original = target[name];
  if (typeof original !== "function") return;
  if (
    (original as unknown as Record<symbol, unknown>)[OUTPUT_BOUNDARY_WRAPPED]
  ) {
    return;
  }
  const wrapped = function (this: unknown, ...args: unknown[]) {
    beginOutputBoundary(outputCaptureFromTarget(target));
    try {
      const result = (original as HelperFunction).apply(this, args);
      if (result && typeof (result as Promise<unknown>).then === "function") {
        return (result as Promise<unknown>).then(
          (value) => {
            finishOutputBoundary(process.stdout, false);
            return value;
          },
          (error) => {
            finishOutputBoundary(process.stdout, true);
            throw error;
          },
        );
      }
      finishOutputBoundary(process.stdout, false);
      return result;
    } catch (error) {
      finishOutputBoundary(process.stdout, true);
      throw error;
    }
  };
  Object.defineProperty(wrapped, OUTPUT_BOUNDARY_WRAPPED, {
    value: true,
    enumerable: false,
  });
  Object.defineProperty(target, name, {
    value: wrapped,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

function wrapReplEvaluationBoundary(target: InstallTarget) {
  const original = target.__egoEvaluateReplScript;
  if (typeof original !== "function") return;
  if (
    (original as unknown as Record<symbol, unknown>)[OUTPUT_BOUNDARY_WRAPPED]
  ) {
    return;
  }
  const wrapped = function (this: unknown, ...args: unknown[]) {
    beginOutputBoundary(outputCaptureFromTarget(target));
    try {
      const result = (original as HelperFunction).apply(this, args);
      if (result && typeof (result as Promise<unknown>).then === "function") {
        return (result as Promise<unknown>).then(
          (value) => value,
          (error) => {
            finishOutputBoundary(process.stdout, true);
            throw error;
          },
        );
      }
      return result;
    } catch (error) {
      finishOutputBoundary(process.stdout, true);
      throw error;
    }
  };
  Object.defineProperty(wrapped, OUTPUT_BOUNDARY_WRAPPED, {
    value: true,
    enumerable: false,
  });
  Object.defineProperty(target, "__egoEvaluateReplScript", {
    value: wrapped,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

function wrapReplCompleteBoundary(target: InstallTarget) {
  const original = target.__egoCompleteReplEvaluation;
  if (typeof original !== "function") return;
  if (
    (original as unknown as Record<symbol, unknown>)[OUTPUT_BOUNDARY_WRAPPED]
  ) {
    return;
  }
  const wrapped = function (this: unknown, ...args: unknown[]) {
    let flush = { hardStop: false, wrote: false };
    if (!isInsideOutputBoundary()) {
      flush = flushSink(process.stdout, false);
    } else {
      flush = finishOutputBoundary(process.stdout, false);
    }
    if (flush.hardStop) {
      resetSink();
    }
    return (original as HelperFunction).apply(this, args);
  };
  Object.defineProperty(wrapped, OUTPUT_BOUNDARY_WRAPPED, {
    value: true,
    enumerable: false,
  });
  Object.defineProperty(target, "__egoCompleteReplEvaluation", {
    value: wrapped,
    writable: true,
    configurable: true,
    enumerable: false,
  });
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
