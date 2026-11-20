import { writeFile } from "node:fs/promises";

import { agentWorkspace, loadEnv } from "./env.js";

loadEnv();

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
