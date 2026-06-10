#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import * as helpers from "./helpers.js";
import { clearPreferredTarget, invalidateSession, setPreferredTarget } from "./browser-runtime.js";
import { formatCliLogValue } from "./format.js";
import { runMain } from "./run.js";

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
  cliLog?: HelperFunction;
};

export * from "./helpers.js";
export { runMain } from "./run.js";

const SYNC_HELPERS = new Set(["help"]);
// Marks an ego runtime whose mutating methods have already been wrapped, so a
// second installEgoSdk call cannot double-wrap createTab / task-space methods.
const EGO_WRAPPED = Symbol.for("egoBrowser.sdkWrapped");

export function installEgoSdk(target: InstallTarget = globalThis, options: InstallEgoSdkOptions = {}) {
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
    const exposed = SYNC_HELPERS.has(name) ? value : async (...args: unknown[]) => {
      await readySignal;
      if (readyError) {
        throw readyError;
      }
      return value(...args);
    };
    Object.defineProperty(target, name, { value: exposed, writable: true, configurable: true, enumerable: false });
    installed[name] = exposed as HelperFunction;
  }
  const cliLogFn = options.cliLog || createCliLog();
  Object.defineProperty(target, "cliLog", { value: cliLogFn, writable: true, configurable: true, enumerable: false });
  installed.cliLog = cliLogFn;
  if (target.ego && typeof target.ego === "object") {
    target.ego.helpers = installed;
    target.ego.learnings = {};
    if (!(target.ego as Record<symbol, unknown>)[EGO_WRAPPED]) {
      wrapCreateTab(target.ego);
      wrapInvalidating(target.ego, ["useTaskSpace", "closeTaskSpace", "createTaskSpace", "claimTaskSpace"]);
      Object.defineProperty(target.ego, EGO_WRAPPED, { value: true, enumerable: false });
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

function createCliLog(stream: { write(chunk: string): unknown } = process.stdout) {
  return (...args: unknown[]) => {
    stream.write(`${args.map(formatCliLogValue).join(" ")}\n`);
  };
}

function isDirectCli() {
  return process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
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
  const skip = new Set(["helpers", "learnings", "useTaskSpace", "createTaskSpace", "claimTaskSpace", "closeTaskSpace"]);
  for (const key of Object.keys(ego)) {
    if (skip.has(key)) continue;
    if (key in target) continue;
    const value = ego[key];
    if (typeof value !== "function") continue;
    const bound = value.bind(ego);
    Object.defineProperty(target, key, { value: bound, writable: true, configurable: true, enumerable: false });
  }
}
