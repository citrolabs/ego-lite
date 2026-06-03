import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { setOverrides, state } from "./state.js";
import { help as helpRuntime, formatHelp } from "./help-runtime.js";
import { cdp, decodeUnserializableJsValue, js } from "./cdp-eval.js";
import * as pointer from "./driver/pointer.js";
import * as keyboard from "./driver/keyboard.js";
import * as nav from "./driver/nav.js";
import * as observe from "./driver/observe.js";
import * as waits from "./driver/waits.js";
import * as files from "./driver/files.js";
import { browserFetch, serverFetch } from "./http.js";
import {
  loadBrowserToolSource,
  loadLearnedContext,
  runNodeSiteTool,
  siteSkillsForUrl as siteSkillsForUrlCore,
  wrapBrowserTool
} from "./learning/index.js";

export { NAME } from "./state.js";
export { cdp, js } from "./cdp-eval.js";
export { click, doubleClick, hover, dragMouse, scroll, scrollBy, scrollToBottomUntil } from "./driver/pointer.js";
export { pressKey, typeText, fillInput, dispatchKey } from "./driver/keyboard.js";
export {
  INTERNAL_URL_PREFIXES,
  pageInfo,
  listTabs,
  currentTab,
  switchTab,
  newTab,
  openOrReuseTab,
  gotoAndWait,
  ensureRealTab,
  iframeTarget
} from "./driver/nav.js";
export { snapshot, snapshotRaw, snapshotText, captureScreenshot, elementEval, elementCenter, drainEvents } from "./driver/observe.js";
export { wait, waitForLoad, waitForElement, waitForNetworkIdle } from "./driver/waits.js";
export { uploadFile } from "./driver/files.js";
export { browserFetch, serverFetch } from "./http.js";

/**
 * List all task spaces.
 * @returns {Promise<Array<{taskId:string,id:string,name:string}>>}
 */
export async function listTaskSpaces() {
  const ego = globalThis.ego;
  if (!ego || typeof ego.listTaskSpaces !== "function") {
    throw new Error("listTaskSpaces requires ego.listTaskSpaces");
  }
  return normalizeTaskSpaces(await ego.listTaskSpaces());
}

/**
 * Use an existing task space by id/name, or create it when missing.
 * @param {string} name Task space id or name.
 * @returns {Promise<{taskId:string,id:string,name:string}>}
 */
export async function useOrCreateTaskSpace(name) {
  const spaces = await listTaskSpaces();
  const existing = spaces.find((space) => space.taskId === name || space.id === name || space.name === name);
  if (existing) {
    globalThis.ego.useTaskSpace(existing.taskId);
    return existing;
  }
  if (typeof globalThis.ego.createTaskSpace !== "function") {
    throw new Error("useOrCreateTaskSpace requires ego.createTaskSpace");
  }
  const created = await globalThis.ego.createTaskSpace(name);
  const taskId = created?.taskId || created?.id || name;
  globalThis.ego.useTaskSpace(taskId);
  return { taskId, id: taskId, name };
}

async function switchTaskSpaceIfNamed(ego, name?: string) {
  if (name === undefined) return;
  const spaces = await listTaskSpaces();
  const match = spaces.find((s) => s.taskId === name || s.id === name || s.name === name);
  if (!match) throw new Error(`task space not found: ${name}`);
  ego.useTaskSpace(match.taskId);
}

/**
 * Finish working on a task space. With `{ keep: true }` the page stays open
 * with the agent overlay dismissed so the user can review the result; with
 * `{ keep: false }` the task space is closed entirely.
 * @param {string} name Task space id or name.
 * @param {{ keep: boolean }} options Required. `keep:true` hands the page to the user; `keep:false` closes the space.
 * @returns {Promise<void>}
 */
export async function completeTaskSpace(name: string, options: { keep: boolean }) {
  if (typeof name !== "string" || !name) {
    throw new Error("completeTaskSpace requires a task space name");
  }
  if (!options || typeof options.keep !== "boolean") {
    throw new Error("completeTaskSpace requires { keep: boolean }");
  }
  const ego = globalThis.ego;
  if (!ego) {
    throw new Error("completeTaskSpace requires ego runtime");
  }
  const spaces = await listTaskSpaces();
  const match = spaces.find((space) => space.taskId === name || space.id === name || space.name === name);
  if (!match) {
    throw new Error(`task space not found: ${name}`);
  }
  ego.useTaskSpace(match.taskId);
  if (options.keep) {
    if (typeof ego.completeTaskSpace !== "function") {
      throw new Error("completeTaskSpace requires ego.completeTaskSpace");
    }
    assertNoEgoError(await ego.completeTaskSpace(), "completeTaskSpace");
  } else {
    if (typeof ego.closeTaskSpace !== "function") {
      throw new Error("completeTaskSpace requires ego.closeTaskSpace");
    }
    assertNoEgoError(await ego.closeTaskSpace(), "completeTaskSpace");
  }
}

/**
 * Hand off a task space back to the user, hiding the agent overlay.
 * @param {string} [name] Task space id or name. If provided, switches to that space first.
 * @returns {Promise<void>}
 */
export async function handOffTaskSpace(name?: string) {
  const ego = globalThis.ego;
  if (!ego || typeof ego.handOffTaskSpace !== "function") {
    throw new Error("handOffTaskSpace requires ego.handOffTaskSpace");
  }
  await switchTaskSpaceIfNamed(ego, name);
  assertNoEgoError(await ego.handOffTaskSpace(), "handOffTaskSpace");
}

/**
 * Take over a task space, showing the agent overlay to indicate work has resumed.
 * @param {string} [name] Task space id or name. If provided, switches to that space first.
 * @returns {Promise<void>}
 */
export async function takeOverTaskSpace(name?: string) {
  const ego = globalThis.ego;
  if (!ego || typeof ego.takeOverTaskSpace !== "function") {
    throw new Error("takeOverTaskSpace requires ego.takeOverTaskSpace");
  }
  await switchTaskSpaceIfNamed(ego, name);
  assertNoEgoError(await ego.takeOverTaskSpace(), "takeOverTaskSpace");
}

function assertNoEgoError(result, op: string) {
  if (result && typeof result === "object" && "error" in result && result.error != null) {
    throw new Error(`${op}: ${formatEgoError(result.error)}`);
  }
  return result;
}

function formatEgoError(err: unknown): string {
  if (err == null) return String(err);
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

function isUserControlError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /user control|user is controlling/i.test(message);
}

/**
 * Probe whether the agent currently holds control of the active task space.
 * Module-private; used by waitForAgentControl. Uses ego.snapshot, which
 * rejects under user-control (per ego-bindings spec) — a reliable
 * synchronous-error signal that raw CDP sends can't provide. Other rejections
 * (task not found, internal errors) propagate so the caller fails fast instead
 * of busy-looping until timeout.
 */
async function probeAgentControl() {
  const ego = globalThis.ego;
  if (!ego || typeof ego.snapshot !== "function") return false;
  try {
    await ego.snapshot({ maxResultLength: 1 });
    return true;
  } catch (err) {
    if (isUserControlError(err)) return false;
    throw err;
  }
}

/**
 * Block until the agent regains control of the named task space.
 * Polls a harmless probe until it succeeds, or throws when the timeout
 * elapses. Read-only — does not call takeOverTaskSpace.
 * @param {string} name Task space id or name.
 * @param {{ interval?: number, timeout?: number }} [options] interval & timeout in seconds (default 20s / 600s).
 * @returns {Promise<void>}
 */
export async function waitForAgentControl(name: string, options: { interval?: number; timeout?: number } = {}) {
  if (typeof name !== "string" || !name) {
    throw new Error("waitForAgentControl requires a task space name");
  }
  const ego = globalThis.ego;
  if (!ego) {
    throw new Error("waitForAgentControl requires ego runtime");
  }
  await switchTaskSpaceIfNamed(ego, name);
  const interval = typeof options.interval === "number" ? options.interval : 20;
  const timeout = typeof options.timeout === "number" ? options.timeout : 600;
  const deadline = Date.now() + timeout * 1000;
  while (true) {
    if (await probeAgentControl()) return;
    if (Date.now() >= deadline) {
      throw new Error(`waitForAgentControl timed out after ${timeout}s`);
    }
    await waits.wait(interval);
  }
}

/**
 * Navigate the current tab to a URL and include matching site skill hints when enabled.
 * @param {string} url URL to navigate to.
 * @returns {Promise<object>} CDP navigation result, optionally with domain_skills.
 */
export async function gotoUrl(url) {
  const result = await nav.gotoUrl(url);
  if (process.env.EGO_BROWSER_DOMAIN_SKILLS !== "1") {
    return result;
  }
  const host = new URL(url).hostname.replace(/^www\./, "").split(".")[0];
  const dir = join(state.agentWorkspace(), "domain-skills", host);
  if (!existsSync(dir)) {
    return result;
  }
  const skills = readdirSync(dir, { recursive: true })
    .filter((file) => String(file).endsWith(".md"))
    .map((file) => String(file).split("/").at(-1))
    .sort()
    .slice(0, 10);
  return { ...result, domain_skills: skills };
}

function normalizeTaskSpaces(raw) {
  if (Array.isArray(raw)) {
    return raw.map(normalizeTaskSpace).filter(Boolean);
  }
  if (Array.isArray(raw?.taskSpaces)) {
    return raw.taskSpaces.map(normalizeTaskSpace).filter(Boolean);
  }
  if (Array.isArray(raw?.spaces)) {
    return raw.spaces.map(normalizeTaskSpace).filter(Boolean);
  }
  if (Array.isArray(raw?.taskIds)) {
    return raw.taskIds.map((taskId) => ({ taskId, id: taskId, name: taskId }));
  }
  return [];
}

function normalizeTaskSpace(space) {
  if (typeof space === "string") {
    return { taskId: space, id: space, name: space };
  }
  const taskId = space?.taskId || space?.id || space?.name;
  if (!taskId) {
    return null;
  }
  return {
    ...space,
    taskId,
    id: space.id || taskId,
    name: space.name || taskId
  };
}

export async function siteSkillsForUrl(url) {
  return siteSkillsForUrlCore(url, {
    agentWorkspace: state.agentWorkspace()
  });
}

/**
 * Return site skills matching a URL, or the current page URL when omitted.
 * @param {string} [url] URL to inspect for site skills.
 * @returns {Promise<Array<object|string>>}
 */
export async function siteSkills(url = undefined) {
  const targetUrl = url ?? (await nav.pageInfo()).url ?? "";
  return siteSkillsForUrl(targetUrl);
}

/**
 * Run a learned Node site tool with the helper context.
 * @param {string} siteId Site identifier.
 * @param {string} toolName Tool name within the site.
 * @param {object} [args] Tool arguments.
 * @returns {Promise<any>} Tool result.
 */
export async function runSiteTool(siteId, toolName, args: any = {}) {
  return runNodeSiteTool(siteId, toolName, args, helperContext(), {
    agentWorkspace: state.agentWorkspace()
  });
}

/**
 * Run a learned browser-side site tool in the current page.
 * @param {string} siteId Site identifier.
 * @param {string} toolName Tool name within the site.
 * @param {object} [args] Tool arguments.
 * @returns {Promise<any>} Browser tool result.
 */
export async function runSiteBrowserTool(siteId, toolName, args: any = {}) {
  const source = await loadBrowserToolSource(siteId, toolName, {
    agentWorkspace: state.agentWorkspace()
  });
  return js(wrapBrowserTool(source, args));
}

/**
 * Load learned context for the current page or a given URL.
 * Returns accumulated site knowledge: notes content, available tools, usage examples.
 * @param {string} [url] URL to inspect. Defaults to current page.
 * @returns {Promise<object>} Learned context with knowledge and tool signatures.
 */
export async function learnContext(url = undefined) {
  const targetUrl = url ?? (await nav.pageInfo()).url ?? "";
  return loadLearnedContext(targetUrl, {
    agentWorkspace: state.agentWorkspace()
  });
}

export function helperContext(extra: any = {}) {
  const all = {
    ...pointer,
    ...keyboard,
    ...nav,
    ...observe,
    ...waits,
    ...files,
    cdp,
    js,
    serverFetch,
    browserFetch,
    gotoUrl,
    siteSkills,
    siteSkillsForUrl,
    runSiteTool,
    runSiteBrowserTool,
    learnContext,
    listTaskSpaces,
    useOrCreateTaskSpace,
    completeTaskSpace,
    handOffTaskSpace,
    takeOverTaskSpace,
    waitForAgentControl,
    ...extra
  };
  return {
    ...all,
    help: (...names: string[]) => {
      const result = helpRuntime(all, ...names);
      if (typeof result === "string") return result;
      if (Array.isArray(result)) return result.map(formatHelp).join("\n\n");
      return formatHelp(result);
    }
  };
}

export async function loadAgentHelpers() {
  const path = join(state.agentWorkspace(), "agent_helpers.js");
  if (!existsSync(path)) {
    return {};
  }
  const module = await import(`${pathToFileURL(path).href}?t=${Date.now()}`);
  const out: Record<string, any> = {};
  for (const [name, value] of Object.entries(module)) {
    if (!name.startsWith("_")) {
      out[name] = value;
    }
  }
  return out;
}

export const __testing = { setOverrides, decodeUnserializableJsValue };
