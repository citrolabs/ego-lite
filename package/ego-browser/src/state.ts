import { writeFile } from "node:fs/promises";

import { agentWorkspace, loadEnv } from "./env.js";

loadEnv();

// Linux polyfill: auto-installs globalThis.ego on Linux when Chrome is available.
// Noop on macOS; safe to import unconditionally. Must run AFTER loadEnv() so
// EGO_LINUX from .env is visible to shouldActivate().
import "./linux/index.js";

export const NAME = process.env.EGO_BROWSER_NAME || "default";

export const state = {
  cdpOverride: null,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  platform: process.platform,
  agentWorkspace: () => agentWorkspace(),
  writeFile,
  preferredTargetId: null,
  // Last observed Network domain state on the default session (tracked in cdp()).
  networkDomainEnabled: false,
};

export function setOverrides(overrides) {
  const previous = { ...state };
  Object.assign(state, overrides);
  return () => {
    Object.assign(state, previous);
  };
}
