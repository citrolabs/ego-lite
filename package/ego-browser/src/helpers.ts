import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { setOverrides, state } from "./state.js";
import { invokeEgo, probeAgentControl } from "./ego-errors.js";
import { help as helpRuntime, formatHelp } from "./help-runtime.js";
import { validatePublicApiOptions } from "./public-api-schema.js";
import { createStaleEgoBrowserGuard } from "./skill-migration.js";
import { cdp, decodeUnserializableJsValue, js } from "./cdp-eval.js";
import * as pointer from "./driver/pointer.js";
import * as keyboard from "./driver/keyboard.js";
import * as nav from "./driver/nav.js";
import * as observe from "./driver/observe.js";
import * as waits from "./driver/waits.js";
import * as files from "./driver/files.js";
import { browserFetch, serverFetch } from "./http.js";
import {
  captureTaskSpaceUserBoundary,
  createTaskSpaceHandle,
  initializeTaskSpaceHandle,
  rollbackCreatedTaskSpace,
} from "./page-model.js";
import {
  loadBrowserToolSource,
  loadLearnedContext,
  runNodeSiteTool,
  siteSkillsForUrl as siteSkillsForUrlCore,
  wrapBrowserTool,
} from "./learning/index.js";

export { NAME } from "./state.js";
export { cdp, js } from "./cdp-eval.js";
export {
  click,
  doubleClick,
  hover,
  dragMouse,
  scroll,
  scrollBy,
  scrollToBottomUntil,
} from "./driver/pointer.js";
export {
  pressKey,
  typeText,
  fillInput,
  dispatchKey,
} from "./driver/keyboard.js";
export {
  INTERNAL_URL_PREFIXES,
  pageInfo,
  listTabs,
  currentTab,
  switchTab,
  openOrReuseTab,
  closeTab,
  gotoUrl,
  gotoAndWait,
  ensureRealTab,
  iframeTarget,
} from "./driver/nav.js";
export {
  snapshot,
  snapshotRaw,
  snapshotText,
  captureScreenshot,
  elementCenter,
  drainEvents,
} from "./driver/observe.js";
export {
  wait,
  waitForLoad,
  waitForElement,
  waitForNetworkIdle,
} from "./driver/waits.js";
export { uploadFile } from "./driver/files.js";
export { browserFetch, serverFetch } from "./http.js";

/**
 * List Agent-owned and user-owned spaces exposed by Ego Lite.
 * Use the numeric id as the stable locator; display names may be duplicated.
 * @returns {Promise<Array<{taskId:string,id:number,name:string,createdBy?:string,ownership?:string,profileId?:string,profileName?:string,recentTabTitles?:string[]}>>}
 */
export async function listTaskSpaces() {
  const ego = globalThis.ego;
  if (!ego || typeof ego.listTaskSpaces !== "function") {
    throw new Error("listTaskSpaces requires ego.listTaskSpaces");
  }
  return normalizeTaskSpaces(
    await invokeEgo("listTaskSpaces", () => ego.listTaskSpaces()),
  );
}

/**
 * List browser profiles that may be selected when creating a task space.
 * Profile ids are stable locators; display names are not guaranteed unique.
 * @returns {Promise<Array<{id:string,name:string,isDefault:boolean}>>}
 */
export async function profiles() {
  const ego = globalThis.ego;
  if (!ego || typeof ego.listProfiles !== "function") {
    throw new Error("profiles requires ego.listProfiles");
  }
  const result = await invokeEgo("profiles", () => ego.listProfiles());
  if (
    !Array.isArray(result?.profiles) ||
    !result.profiles.every(
      (profile) =>
        profile &&
        typeof profile.id === "string" &&
        profile.id.length > 0 &&
        typeof profile.name === "string" &&
        typeof profile.isDefault === "boolean",
    )
  ) {
    throw new Error("profiles expected entries with id, name, and isDefault");
  }
  return result.profiles;
}

/*
 * Task space ownership policy (`ownership`: "agent" | "agentDelegatedToUser" | "user").
 * "agent" and "agentDelegatedToUser" are both agent-owned (see isAgentOwned) — the
 * latter is the agent's own space with control temporarily handed to the user
 * (handoff or GUI takeover). The user-control boundary is enforced at the native
 * bridge when real commands run, not here. The rows below describe what each helper
 * does when the target space is user-owned:
 *
 *   switchTaskSpace                     -> throws (agent-owned only)
 *   claimTaskSpace                      -> claims it (ownership transfers to the agent), then selects it
 *   handOffTaskSpace                    -> skipped, resolves { done: false, skipped: "user-owned" }
 *   completeTaskSpace { keep: true }    -> skipped, resolves { done: false, skipped: "user-owned" }
 *   completeTaskSpace { keep: false }   -> claims it, then closes it
 *   takeOverTaskSpace / waitForAgentControl -> no ownership check (operates as-is)
 *
 * Keep this table in sync with the one in skills/ego-browser/SKILL.md.
 */

/**
 * Whether the agent owns the space. "agentDelegatedToUser" is still agent-owned —
 * the agent created it but control is temporarily with the user (handoff / GUI
 * takeover). Selecting such a space is fine; the user-control boundary is enforced
 * separately at the native bridge when real commands run.
 * @param {string|undefined} ownership
 * @returns {boolean}
 */
function isAgentOwned(ownership) {
  return ownership === "agent" || ownership === "agentDelegatedToUser";
}

/**
 * Select an existing task space by id/name for the current Node invocation.
 * @param {string|number} nameOrId Task space id or name.
 * @returns {Promise<{taskId:string,id:number,name:string,createdBy?:string,ownership?:string,recentTabTitles?:string[]}>}
 */
export async function switchTaskSpace(nameOrId) {
  const ego = globalThis.ego;
  if (!ego || typeof ego.useTaskSpace !== "function") {
    throw new Error("switchTaskSpace requires ego.useTaskSpace");
  }
  const space = await findTaskSpace(nameOrId);
  if (!isAgentOwned(space.ownership)) {
    throw new Error(
      `switchTaskSpace requires an agent-owned task space, got ownership ${JSON.stringify(space.ownership)}`,
    );
  }
  return selectTaskSpace(ego, space, "switchTaskSpace");
}

/**
 * Create an agent-owned task space and select it for the current Node invocation.
 * @param {string} name Task space name.
 * @param {string} [profileId] Profile id returned by profiles().
 * @returns {Promise<{taskId:string,id:number,name:string,createdBy?:string,ownership?:string,recentTabTitles?:string[]}>}
 */
export async function newTaskSpace(name, profileId?: string) {
  return (await createTaskSpaceResolution(name, profileId)).descriptor;
}

async function createTaskSpaceResolution(
  name,
  profileId?: string,
  options: { select?: boolean } = {},
) {
  const ego = globalThis.ego;
  if (!ego || typeof ego.createTaskSpace !== "function") {
    throw new Error("newTaskSpace requires ego.createTaskSpace");
  }
  // Do not pass an explicit undefined: older native bindings reject extra
  // arguments, while newer builds accept profileId as the second argument.
  const created = normalizeTaskSpace(
    await invokeEgo("newTaskSpace", () =>
      profileId === undefined
        ? ego.createTaskSpace(name)
        : ego.createTaskSpace(name, profileId),
    ),
  );
  if (!created) {
    throw new Error("newTaskSpace returned an invalid task space");
  }
  taskSpaceNumericId(created, "newTaskSpace");
  // The native create response currently omits ownership on some Ego Lite
  // builds. Creation through this Agent API is itself authoritative.
  const createdByAgent = {
    ...created,
    ownership: created.ownership || "agent",
  };
  const descriptor =
    options.select === false
      ? createdByAgent
      : await selectTaskSpace(ego, createdByAgent, "newTaskSpace");
  return {
    descriptor,
    created: true,
  };
}

/**
 * Use an existing agent-owned task space, or create it when missing. User-owned
 * spaces are selected but not claimed (the EGO_TASK_SPACE_USER_IN_CONTROL error
 * surfaces) — call claimTaskSpace(nameOrId) to take ownership.
 * @param {string|number} nameOrId Task space name or numeric id.
 * @returns {Promise<{taskId:string,id:number,name:string,createdBy?:string,ownership?:string,recentTabTitles?:string[]}>}
 */
export async function useOrCreateTaskSpace(nameOrId) {
  return (await resolveTaskSpace(nameOrId)).descriptor;
}

async function resolveTaskSpace(nameOrId, options: { select?: boolean } = {}) {
  const spaces = await listTaskSpaces();
  const existing = findMatchingTaskSpace(spaces, nameOrId);
  if (!existing) {
    if (typeof nameOrId === "number") {
      throw new Error(`task space not found: ${nameOrId}`);
    }
    return createTaskSpaceResolution(nameOrId, undefined, {
      select: options.select,
    });
  }
  if (isAgentOwned(existing.ownership)) {
    return {
      descriptor:
        options.select === false
          ? existing
          : await selectTaskSpace(
              globalThis.ego,
              existing,
              "useOrCreateTaskSpace",
            ),
      created: false,
    };
  }
  if (existing.ownership === "user") {
    // Don't claim user-owned spaces here. Select it as-is; the user stays in
    // control, so EGO_TASK_SPACE_USER_IN_CONTROL surfaces (as ego-browser's owned
    // guidance, not the raw native text). Call claimTaskSpace(nameOrId) to take
    // ownership.
    return {
      descriptor:
        options.select === false
          ? existing
          : await selectTaskSpace(
              globalThis.ego,
              existing,
              "useOrCreateTaskSpace",
            ),
      created: false,
    };
  }
  throw new Error(
    `useOrCreateTaskSpace cannot use task space ${JSON.stringify(nameOrId)} with ownership ${JSON.stringify(existing.ownership)}`,
  );
}

/**
 * Return the v2 object handle for an existing task space, or create the space
 * when a string name does not exist.
 * @param {string|number} nameOrId Task space name or numeric id.
 * @param {{profileId?:string}} [options] Creation options for a new named space.
 * @returns {Promise<import('./page-model.js').TaskSpace>}
 */
export async function taskSpace(
  nameOrId,
  options: { profileId?: string } = {},
) {
  validatePublicApiOptions("taskSpace", options);
  const { profileId } = options;
  if (profileId === undefined) {
    return initializeResolvedTaskSpace(
      await resolveTaskSpace(nameOrId, { select: false }),
    );
  }
  if (typeof nameOrId !== "string") {
    throw new TypeError(
      "taskSpace profileId can only be used with a new task-space name",
    );
  }
  const existing = findMatchingTaskSpace(await listTaskSpaces(), nameOrId);
  if (existing) {
    throw new Error(
      `taskSpace profileId only applies when creating a new task space; ${JSON.stringify(nameOrId)} already exists`,
    );
  }
  return initializeResolvedTaskSpace(
    await createTaskSpaceResolution(nameOrId, profileId, { select: false }),
  );
}

async function initializeResolvedTaskSpace(resolution) {
  const task = createTaskSpaceHandle(resolution.descriptor);
  if (!resolution.created) {
    await initializeTaskSpaceHandle(task);
    return task;
  }

  try {
    await initializeTaskSpaceHandle(task, { created: true });
    return task;
  } catch (error) {
    // A fresh space must not survive without its canonical p1 ledger entry.
    // Preserve the initialization error if native rollback is unavailable.
    await rollbackCreatedTaskSpace(task).catch(() => {});
    throw error;
  }
}

/**
 * Claim a user-owned task space (ownership transfers to the agent) and select it
 * for the current Node invocation. Resolves the space by id/name, claims it via
 * ego.claimTaskSpace, then selects it.
 * @param {string|number} nameOrId Task space id or name.
 * @returns {Promise<import('./page-model.js').TaskSpace>}
 */
export async function claimTaskSpace(nameOrId) {
  const space = await findTaskSpace(nameOrId);
  const claimed = await claimResolvedTaskSpace(space, "claimTaskSpace");
  const task = createTaskSpaceHandle({ ...claimed, ownership: "agent" });
  await captureTaskSpaceUserBoundary(task);
  await initializeTaskSpaceHandle(task);
  return task;
}

async function claimResolvedTaskSpace(space, op = "claimTaskSpace") {
  const ego = globalThis.ego;
  if (!ego || typeof ego.claimTaskSpace !== "function") {
    throw new Error(`${op} requires ego.claimTaskSpace`);
  }
  const id = taskSpaceNumericId(space, op);
  const claimed = normalizeTaskSpace(
    await invokeEgo(op, () => ego.claimTaskSpace(id, space.name)),
  );
  if (!claimed) {
    throw new Error(`${op} returned an invalid task space`);
  }
  taskSpaceNumericId(claimed, op);
  return selectTaskSpace(ego, claimed, op);
}

async function selectTaskSpace(ego, space, op: string) {
  if (!ego || typeof ego.useTaskSpace !== "function") {
    throw new Error(`${op} requires ego.useTaskSpace`);
  }
  await invokeEgo(op, () => ego.useTaskSpace(taskSpaceNumericId(space, op)));
  return space;
}

async function selectTaskSpaceIfProvided(
  ego,
  nameOrId?: string | number,
  op = "taskSpace",
) {
  if (nameOrId === undefined) return;
  const match = await findTaskSpace(nameOrId);
  await selectTaskSpace(ego, match, op);
}

/**
 * Finish working on a task space. With `{ keep: true }` the page stays open
 * with the agent overlay dismissed so the user can review the result; with
 * `{ keep: false }` the task space is closed entirely.
 * User-owned spaces: `keep:true` is skipped (the user already has the page) and
 * resolves `{ done: false, skipped: "user-owned" }`; `keep:false` claims the
 * space first, then closes it.
 * @param {string|number} nameOrId Task space id or name.
 * @param {{ keep: boolean }} options Required. `keep:true` hands the page to the user; `keep:false` closes the space.
 * @returns {Promise<{done: boolean, skipped?: "user-owned"}>} `{ done: true }` when the space was completed or closed; `{ done: false, skipped: "user-owned" }` when nothing was done.
 */
export async function completeTaskSpace(
  nameOrId: string | number,
  options: { keep: boolean },
) {
  if (
    (typeof nameOrId !== "string" && typeof nameOrId !== "number") ||
    nameOrId === ""
  ) {
    throw new Error("completeTaskSpace requires a task space name or id");
  }
  if (!options || typeof options.keep !== "boolean") {
    throw new Error("completeTaskSpace requires { keep: boolean }");
  }
  const ego = globalThis.ego;
  if (!ego) {
    throw new Error("completeTaskSpace requires ego runtime");
  }
  const spaces = await listTaskSpaces();
  const match = findMatchingTaskSpace(spaces, nameOrId);
  if (!match) {
    throw new Error(`task space not found: ${nameOrId}`);
  }
  if (options.keep) {
    if (match.ownership === "user") {
      return { done: false, skipped: "user-owned" as const };
    }
    await selectTaskSpace(ego, match, "completeTaskSpace");
    if (typeof ego.completeTaskSpace !== "function") {
      throw new Error("completeTaskSpace requires ego.completeTaskSpace");
    }
    await invokeEgo("completeTaskSpace", () => ego.completeTaskSpace());
  } else {
    if (match.ownership === "user") {
      await claimResolvedTaskSpace(match, "completeTaskSpace");
    } else {
      await selectTaskSpace(ego, match, "completeTaskSpace");
    }
    if (typeof ego.closeTaskSpace !== "function") {
      throw new Error("completeTaskSpace requires ego.closeTaskSpace");
    }
    await invokeEgo("completeTaskSpace", () => ego.closeTaskSpace());
  }
  return { done: true };
}

/**
 * Hand off a task space back to the user, hiding the agent overlay.
 * User-owned spaces are skipped (the user already controls them) and resolve
 * `{ done: false, skipped: "user-owned" }`.
 * @param {string|number} [nameOrId] Task space id or name. If provided, switches to that space first.
 * @returns {Promise<{done: boolean, skipped?: "user-owned"}>} `{ done: true }` when control was handed off; `{ done: false, skipped: "user-owned" }` when nothing was done.
 */
export async function handOffTaskSpace(nameOrId?: string | number) {
  const ego = globalThis.ego;
  if (!ego || typeof ego.handOffTaskSpace !== "function") {
    throw new Error("handOffTaskSpace requires ego.handOffTaskSpace");
  }
  if (nameOrId !== undefined) {
    const match = await findTaskSpace(nameOrId);
    if (match.ownership === "user") {
      return { done: false, skipped: "user-owned" as const };
    }
    await selectTaskSpace(ego, match, "handOffTaskSpace");
  }
  await invokeEgo("handOffTaskSpace", () => ego.handOffTaskSpace());
  return { done: true };
}

/**
 * Take over a task space, showing the agent overlay to indicate work has resumed.
 * @param {string|number} [nameOrId] Task space id or name. If provided, switches to that space first.
 * @returns {Promise<import('./page-model.js').TaskSpace|void>} A TaskSpace when a name or id is provided; otherwise preserves the selected-space form's void result.
 */
export async function takeOverTaskSpace(nameOrId?: string | number) {
  const ego = globalThis.ego;
  if (!ego || typeof ego.takeOverTaskSpace !== "function") {
    throw new Error("takeOverTaskSpace requires ego.takeOverTaskSpace");
  }
  let descriptor;
  if (nameOrId !== undefined) {
    descriptor = await findTaskSpace(nameOrId);
    await selectTaskSpace(ego, descriptor, "takeOverTaskSpace");
  }
  await invokeEgo("takeOverTaskSpace", () => ego.takeOverTaskSpace());
  if (descriptor) {
    const task = createTaskSpaceHandle({ ...descriptor, ownership: "agent" });
    // Repeatedly ensuring control over an already agent-controlled space is a
    // no-op, not a user interaction boundary. Only delegated spaces can have
    // gained tabs through user activity since the Agent last controlled them.
    if (descriptor.ownership === "agentDelegatedToUser") {
      await captureTaskSpaceUserBoundary(task);
    }
    await initializeTaskSpaceHandle(task);
    return task;
  }
}

/**
 * Probe whether the agent currently holds control of the active task space.
 * Module-private; used by waitForAgentControl. Uses ego.snapshot, which
 * rejects under user-control (per ego-bindings spec) — a reliable
 * synchronous-error signal that raw CDP sends can't provide. Other rejections
 * (task not found, internal errors) propagate so the caller fails fast instead
 * of busy-looping until timeout.
 */
async function probeCurrentAgentControl() {
  const ego = globalThis.ego;
  if (!ego || typeof ego.snapshot !== "function") return false;
  return probeAgentControl(() => ego.snapshot({ maxResultLength: 1 }));
}

/**
 * Block until the agent regains control of the named task space.
 * Polls a harmless probe until it succeeds, or throws when the timeout
 * elapses. Read-only — does not call takeOverTaskSpace.
 * @param {string|number} nameOrId Task space id or name.
 * @param {{ interval?: number, timeout?: number }} [options] interval & timeout in seconds (default 20s / 600s).
 * @returns {Promise<void>}
 */
export async function waitForAgentControl(
  nameOrId: string | number,
  options: { interval?: number; timeout?: number } = {},
) {
  if (
    (typeof nameOrId !== "string" && typeof nameOrId !== "number") ||
    nameOrId === ""
  ) {
    throw new Error("waitForAgentControl requires a task space name or id");
  }
  const ego = globalThis.ego;
  if (!ego) {
    throw new Error("waitForAgentControl requires ego runtime");
  }
  await selectTaskSpaceIfProvided(ego, nameOrId, "waitForAgentControl");
  const interval = typeof options.interval === "number" ? options.interval : 20;
  const timeout = typeof options.timeout === "number" ? options.timeout : 600;
  const deadline = Date.now() + timeout * 1000;
  while (true) {
    if (await probeCurrentAgentControl()) return;
    if (Date.now() >= deadline) {
      throw new Error(`waitForAgentControl timed out after ${timeout}s`);
    }
    await waits.wait(interval);
  }
}

function normalizeTaskSpaces(raw) {
  if (Array.isArray(raw?.taskSpaces)) {
    return raw.taskSpaces.map(normalizeTaskSpace).filter(Boolean);
  }
  throw new Error("listTaskSpaces expected { taskSpaces: [...] }");
}

function normalizeTaskSpace(space) {
  const taskId = space?.taskId ?? space?.name ?? space?.id;
  if (taskId === undefined || taskId === null || taskId === "") {
    return null;
  }
  return {
    ...space,
    taskId,
    id: space?.id ?? taskId,
    name: space?.name ?? taskId,
  };
}

function taskSpaceNumericId(space, op: string) {
  if (typeof space?.id !== "number" || !Number.isFinite(space.id)) {
    throw new Error(
      `${op} requires a numeric task space id, got ${JSON.stringify(space?.id)}`,
    );
  }
  return space.id;
}

async function findTaskSpace(nameOrId) {
  const spaces = await listTaskSpaces();
  const match = findMatchingTaskSpace(spaces, nameOrId);
  if (!match) throw new Error(`task space not found: ${nameOrId}`);
  return match;
}

function findMatchingTaskSpace(spaces, nameOrId) {
  if (typeof nameOrId === "number") {
    return spaces.find((space) => space.id === nameOrId);
  }
  const byName = spaces.find(
    (space) => space.name === nameOrId || space.taskId === nameOrId,
  );
  if (byName) return byName;
  if (/^\d+$/.test(nameOrId)) {
    const id = Number(nameOrId);
    if (Number.isFinite(id)) {
      return spaces.find((space) => space.id === id);
    }
  }
  return undefined;
}

export async function siteSkillsForUrl(url) {
  return siteSkillsForUrlCore(url, {
    agentWorkspace: state.agentWorkspace(),
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
    agentWorkspace: state.agentWorkspace(),
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
    agentWorkspace: state.agentWorkspace(),
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
    agentWorkspace: state.agentWorkspace(),
  });
}

export function helperContext(extra: any = {}) {
  const { newTab: _newTab, ...publicNav } = nav;
  const all = {
    ...pointer,
    ...keyboard,
    ...publicNav,
    ...observe,
    ...waits,
    ...files,
    cdp,
    js,
    serverFetch,
    browserFetch,
    siteSkills,
    siteSkillsForUrl,
    runSiteTool,
    runSiteBrowserTool,
    learnContext,
    profiles,
    listTaskSpaces,
    switchTaskSpace,
    newTaskSpace,
    taskSpace,
    useOrCreateTaskSpace,
    claimTaskSpace,
    completeTaskSpace,
    handOffTaskSpace,
    takeOverTaskSpace,
    waitForAgentControl,
    ...extra,
  };
  return {
    ...all,
    // The formal 1.3 Skill starts through egoBrowser.*. Keep a narrow guard so
    // stale conversations get a recovery instruction instead of a ReferenceError.
    egoBrowser: createStaleEgoBrowserGuard(),
    help: (...names: string[]) => {
      const result = helpRuntime(all, ...names);
      if (typeof result === "string") return result;
      if (Array.isArray(result)) return result.map(formatHelp).join("\n\n");
      return formatHelp(result);
    },
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
