import { writeFile } from "node:fs/promises";

import { agentWorkspace, loadEnv } from "./env.js";
import { browserCdp } from "./browser-runtime.js";
import { runtimeState } from "./runtime-state.js";

loadEnv();

export const NAME = process.env.EGO_BROWSER_NAME || "default";

async function defaultSend(req) {
  if (!req || typeof req !== "object" || !req.method) {
    throw new Error(
      `unsupported browser runtime request: ${JSON.stringify(req)}`,
    );
  }
  const response = await browserCdp(
    req.method,
    req.params || {},
    req.session_id,
  );
  return { result: response.result || {} };
}

export const state = Object.assign(runtimeState, {
  send: defaultSend,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  platform: process.platform,
  agentWorkspace: () => agentWorkspace(),
  writeFile,
});

export async function send(req) {
  return state.send(req);
}

export function cdpAvailable() {
  return Boolean(state.cdpOverride) || state.send !== defaultSend;
}

export function setOverrides(overrides) {
  const previous = { ...state };
  Object.assign(state, overrides);
  return () => {
    Object.assign(state, previous);
  };
}
