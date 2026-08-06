import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { setOverrides, state } from "./state.js";
import { assertNoEgoError, isEgoUserControlError } from "./ego-errors.js";
import { help as helpRuntime, formatHelp } from "./help-runtime.js";
import { cdp, decodeUnserializableJsValue, evaluate } from "./cdp-eval.js";
import * as pointer from "./driver/pointer.js";
import * as keyboard from "./driver/keyboard.js";
import * as locator from "./driver/locator.js";
import * as nav from "./driver/nav.js";
import * as observe from "./driver/observe.js";
import * as waits from "./driver/waits.js";
import * as files from "./driver/files.js";
import * as downloads from "./driver/downloads.js";
import * as screencast from "./driver/screencast.js";
import { browserFetch, serverFetch } from "./http.js";
import {
  loadBrowserToolSource,
  loadLearnedContext,
  runNodeSiteTool,
  siteSkillsForUrl as siteSkillsForUrlCore,
  wrapBrowserTool,
} from "./learning/index.js";

export { NAME } from "./state.js";
export { cdp, evaluate } from "./cdp-eval.js";
export {
  click,
  dblclick,
  hover,
  drag,
  wheel,
  scrollIntoViewIfNeeded,
} from "./driver/pointer.js";
export {
  press,
  down,
  up,
  insertText,
  focus,
  fill,
  pressSequentially,
  check,
  uncheck,
  setChecked,
  selectOption,
  dispatchEvent,
} from "./driver/keyboard.js";
export {
  textContent,
  innerText,
  inputValue,
  isChecked,
  isVisible,
  isHidden,
  isEnabled,
  isDisabled,
  isEditable,
  getAttribute,
  blur,
  boundingBox,
  count,
  allInnerTexts,
  allTextContents,
  innerHTML,
  evaluateLocator,
  evaluateAll,
} from "./driver/locator.js";
export {
  INTERNAL_URL_PREFIXES,
  pageInfo,
  listTabs,
  currentTab,
  switchTab,
  openOrReuseTab,
  closeTab,
  goto,
  ensureRealTab,
  iframeTarget,
} from "./driver/nav.js";
export {
  snapshot,
  snapshotRaw,
  screenshot,
  elementCenter,
  drainEvents,
} from "./driver/observe.js";
export {
  waitForTimeout,
  waitForLoadState,
  waitForSelector,
  waitForFunction,
  waitForURL,
  waitForRequest,
  waitForResponse,
} from "./driver/waits.js";
export { setInputFiles } from "./driver/files.js";
export { startScreencast, stopScreencast } from "./driver/screencast.js";
export { browserFetch, serverFetch } from "./http.js";

/**
 * List all task spaces.
 * @returns {Promise<Array<{taskId:string,id:number,name:string,createdBy?:string,ownership?:string,recentTabTitles?:string[]}>>}
 */
export async function listTaskSpaces() {
  const ego = globalThis.ego;
  if (!ego || typeof ego.listTaskSpaces !== "function") {
    throw new Error("listTaskSpaces requires ego.listTaskSpaces");
  }
  return normalizeTaskSpaces(
    assertNoEgoError(await ego.listTaskSpaces(), "listTaskSpaces"),
  );
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
 * @returns {Promise<{taskId:string,id:number,name:string,createdBy?:string,ownership?:string,recentTabTitles?:string[]}>}
 */
export async function newTaskSpace(name) {
  const ego = globalThis.ego;
  if (!ego || typeof ego.createTaskSpace !== "function") {
    throw new Error("newTaskSpace requires ego.createTaskSpace");
  }
  const created = normalizeTaskSpace(
    assertNoEgoError(await ego.createTaskSpace(name), "newTaskSpace"),
  );
  if (!created) {
    throw new Error("newTaskSpace returned an invalid task space");
  }
  taskSpaceNumericId(created, "newTaskSpace");
  return selectTaskSpace(ego, created, "newTaskSpace");
}

/**
 * Use an existing agent-owned task space, or create it when missing. User-owned
 * spaces are selected but not claimed (the EGO_TASK_SPACE_USER_IN_CONTROL error
 * surfaces) — call claimTaskSpace(nameOrId) to take ownership.
 * @param {string|number} nameOrId Task space name or numeric id.
 * @returns {Promise<{taskId:string,id:number,name:string,createdBy?:string,ownership?:string,recentTabTitles?:string[]}>}
 */
export async function useOrCreateTaskSpace(nameOrId) {
  const spaces = await listTaskSpaces();
  const existing = findMatchingTaskSpace(spaces, nameOrId);
  if (!existing) {
    if (typeof nameOrId === "number") {
      throw new Error(`task space not found: ${nameOrId}`);
    }
    return newTaskSpace(nameOrId);
  }
  if (isAgentOwned(existing.ownership)) {
    return selectTaskSpace(globalThis.ego, existing, "useOrCreateTaskSpace");
  }
  if (existing.ownership === "user") {
    // Don't claim user-owned spaces here. Select it as-is; the user stays in
    // control, so EGO_TASK_SPACE_USER_IN_CONTROL surfaces (as ego-browser's owned
    // guidance, not the raw native text). Call claimTaskSpace(nameOrId) to take
    // ownership.
    return selectTaskSpace(globalThis.ego, existing, "useOrCreateTaskSpace");
  }
  throw new Error(
    `useOrCreateTaskSpace cannot use task space ${JSON.stringify(nameOrId)} with ownership ${JSON.stringify(existing.ownership)}`,
  );
}

/**
 * Claim a user-owned task space (ownership transfers to the agent) and select it
 * for the current Node invocation. Resolves the space by id/name, claims it via
 * ego.claimTaskSpace, then selects it.
 * @param {string|number} nameOrId Task space id or name.
 * @returns {Promise<{taskId:string,id:number,name:string,createdBy?:string,ownership?:string,recentTabTitles?:string[]}>}
 */
export async function claimTaskSpace(nameOrId) {
  const space = await findTaskSpace(nameOrId);
  return claimResolvedTaskSpace(space, "claimTaskSpace");
}

async function claimResolvedTaskSpace(space, op = "claimTaskSpace") {
  const ego = globalThis.ego;
  if (!ego || typeof ego.claimTaskSpace !== "function") {
    throw new Error(`${op} requires ego.claimTaskSpace`);
  }
  const id = taskSpaceNumericId(space, op);
  const claimed = normalizeTaskSpace(
    assertNoEgoError(await ego.claimTaskSpace(id, space.name), op),
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
  assertNoEgoError(await ego.useTaskSpace(taskSpaceNumericId(space, op)), op);
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
    assertNoEgoError(await ego.completeTaskSpace(), "completeTaskSpace");
  } else {
    if (match.ownership === "user") {
      await claimResolvedTaskSpace(match, "completeTaskSpace");
    } else {
      await selectTaskSpace(ego, match, "completeTaskSpace");
    }
    if (typeof ego.closeTaskSpace !== "function") {
      throw new Error("completeTaskSpace requires ego.closeTaskSpace");
    }
    assertNoEgoError(await ego.closeTaskSpace(), "completeTaskSpace");
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
  assertNoEgoError(await ego.handOffTaskSpace(), "handOffTaskSpace");
  return { done: true };
}

/**
 * Take over a task space, showing the agent overlay to indicate work has resumed.
 * @param {string|number} [nameOrId] Task space id or name. If provided, switches to that space first.
 * @returns {Promise<void>}
 */
export async function takeOverTaskSpace(nameOrId?: string | number) {
  const ego = globalThis.ego;
  if (!ego || typeof ego.takeOverTaskSpace !== "function") {
    throw new Error("takeOverTaskSpace requires ego.takeOverTaskSpace");
  }
  await selectTaskSpaceIfProvided(ego, nameOrId, "takeOverTaskSpace");
  assertNoEgoError(await ego.takeOverTaskSpace(), "takeOverTaskSpace");
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
    if (isEgoUserControlError(err)) return false;
    throw err;
  }
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
    if (await probeAgentControl()) return;
    if (Date.now() >= deadline) {
      throw new Error(`waitForAgentControl timed out after ${timeout}s`);
    }
    await waits.waitForTimeout(interval * 1000);
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
  return evaluate(wrapBrowserTool(source, args));
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

function createLocator(selector) {
  return {
    selector,
    first: () => createLocator(nthSelector(selector, 0)),
    last: () => createLocator(`internal:last;${selector}`),
    nth: (index) => {
      const value = Number(index);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error("locator.nth requires a non-negative integer");
      }
      return createLocator(nthSelector(selector, value));
    },
    locator: (child) =>
      createLocator(scopedSelector(selector, locatorSelector(child))),
    getByRole: (role, options: any = {}) =>
      createLocator(scopedSelector(selector, roleSelector(role, options))),
    getByText: (text, options: any = {}) =>
      createLocator(
        scopedSelector(selector, textSelector("text", text, options)),
      ),
    getByLabel: (text, options: any = {}) =>
      createLocator(
        scopedSelector(selector, textSelector("label", text, options)),
      ),
    getByPlaceholder: (text, options: any = {}) =>
      createLocator(
        scopedSelector(selector, textSelector("placeholder", text, options)),
      ),
    getByAltText: (text, options: any = {}) =>
      createLocator(
        scopedSelector(selector, textSelector("alt", text, options)),
      ),
    getByTitle: (text, options: any = {}) =>
      createLocator(
        scopedSelector(selector, textSelector("title", text, options)),
      ),
    getByTestId: (testId) =>
      createLocator(scopedSelector(selector, testIdSelector(testId))),
    filter: (options: any = {}) =>
      createLocator(filterSelector(selector, options)),
    click: (options = {}) => pointer.click(selector, options),
    dblclick: (options = {}) => pointer.dblclick(selector, options),
    hover: (options = {}) => pointer.hover(selector, options),
    dragTo: (target, options = {}) =>
      pointer.drag([selector, target?.selector || target], options),
    scrollIntoViewIfNeeded: () => pointer.scrollIntoViewIfNeeded(selector),
    focus: () => keyboard.focus(selector),
    fill: (value, options = {}) => keyboard.fill(selector, value, options),
    clear: (options = {}) => keyboard.fill(selector, "", options),
    press: (key, options = {}) =>
      keyboard.pressOnSelector(selector, key, options),
    pressSequentially: (text, options = {}) =>
      keyboard.pressSequentially(selector, text, options),
    check: () => keyboard.check(selector),
    uncheck: () => keyboard.uncheck(selector),
    setChecked: (checked) => keyboard.setChecked(selector, checked),
    selectOption: (values) => keyboard.selectOption(selector, values),
    setInputFiles: (filesValue) => files.setInputFiles(selector, filesValue),
    dispatchEvent: (type, eventInit = {}) =>
      keyboard.dispatchEvent(selector, type, eventInit),
    blur: () => locator.blur(selector),
    textContent: () => locator.textContent(selector),
    innerText: () => locator.innerText(selector),
    innerHTML: () => locator.innerHTML(selector),
    inputValue: () => locator.inputValue(selector),
    isChecked: () => locator.isChecked(selector),
    isVisible: () => locator.isVisible(selector),
    isHidden: () => locator.isHidden(selector),
    isEnabled: () => locator.isEnabled(selector),
    isDisabled: () => locator.isDisabled(selector),
    isEditable: () => locator.isEditable(selector),
    getAttribute: (name) => locator.getAttribute(selector, name),
    boundingBox: () => locator.boundingBox(selector),
    screenshot: async (options = {}) => {
      const box = await locator.boundingBox(selector);
      if (!box) {
        throw new Error(
          `locator.screenshot target has no bounding box: ${selector}`,
        );
      }
      return observe.screenshot({ ...options, clip: box });
    },
    count: () => locator.count(selector),
    allInnerTexts: () => locator.allInnerTexts(selector),
    allTextContents: () => locator.allTextContents(selector),
    evaluate: (pageFunction, arg = undefined) =>
      locator.evaluateLocator(selector, pageFunction, arg),
    evaluateAll: (pageFunction, arg = undefined) =>
      locator.evaluateAll(selector, pageFunction, arg),
    waitFor: (options = {}) => waits.waitForSelector(selector, options),
  };
}

function nthSelector(selector, index) {
  return `internal:nth=${index};${selector}`;
}

function internalSelector(kind, data) {
  return `internal:${kind}:${encodeURIComponent(JSON.stringify(data))}`;
}

function scopedSelector(base, child) {
  return internalSelector("scope", { base, child });
}

function locatorSelector(value) {
  if (
    value &&
    typeof value === "object" &&
    typeof value.selector === "string"
  ) {
    return value.selector;
  }
  return String(value);
}

function textSelector(prefix, text, options: any = {}) {
  const value = `${options.exact ? "exact:" : ""}${JSON.stringify(String(text))}`;
  return `loc=${prefix}:${value}`;
}

function roleSelector(role, options: any = {}) {
  // A nullish name (e.g. getByRole("button", { name: label }) with an undefined
  // label) means "no name filter", matching all elements of the role, as in
  // Playwright. Gating on key presence would instead filter on the literal
  // string "undefined"/"null" and match nothing.
  const name =
    options && options.name != null
      ? `[name=${JSON.stringify(roleNameMatcher(options.name))}]`
      : "";
  return `loc=role:${role}${name}`;
}

function testIdSelector(testId) {
  return textSelector("testid", testId, { exact: true });
}

function filterSelector(base, options: any = {}) {
  // Gate every filter on the value being present, not just the key, so a nullish
  // option (a computed value that came out undefined) is treated as "no filter"
  // instead of matching the literal string "undefined"/"null".
  const data: any = { base };
  if (options.hasText != null) {
    data.hasText = textMatcher(options.hasText);
  }
  if (options.hasNotText != null) {
    data.hasNotText = textMatcher(options.hasNotText);
  }
  if (options.has != null) {
    data.has = locatorSelector(options.has);
  }
  if (options.hasNot != null) {
    data.hasNot = locatorSelector(options.hasNot);
  }
  return internalSelector("filter", data);
}

function textMatcher(value) {
  if (value instanceof RegExp) {
    return { regex: value.source, flags: value.flags };
  }
  return { text: String(value), exact: false };
}

function roleNameMatcher(value) {
  if (value instanceof RegExp) {
    return { regex: value.source, flags: value.flags };
  }
  return value;
}

function createPageFacade() {
  return {
    setDefaultTimeout: (timeout) => {
      const value = Number(timeout);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(
          "page.setDefaultTimeout requires a non-negative number",
        );
      }
      state.defaultTimeout = value;
    },
    goto: nav.goto,
    reload: async (options: any = {}) => {
      await cdp("Page.reload", { ignoreCache: Boolean(options.ignoreCache) });
      if (options.waitUntil === "commit") {
        return false;
      }
      return waits.waitForLoadState(options.waitUntil || "load", {
        timeout: options.timeout,
      });
    },
    info: nav.pageInfo,
    url: async () => (await nav.pageInfo()).url,
    title: async () => (await nav.pageInfo()).title,
    locator: createLocator,
    getByRole: (role, options: any = {}) => {
      return createLocator(roleSelector(role, options));
    },
    getByText: (text, options: any = {}) =>
      createLocator(textSelector("text", text, options)),
    getByLabel: (text, options: any = {}) =>
      createLocator(textSelector("label", text, options)),
    getByPlaceholder: (text, options: any = {}) =>
      createLocator(textSelector("placeholder", text, options)),
    getByAltText: (text, options: any = {}) =>
      createLocator(textSelector("alt", text, options)),
    getByTitle: (text, options: any = {}) =>
      createLocator(textSelector("title", text, options)),
    getByTestId: (testId) => createLocator(testIdSelector(testId)),
    waitForTimeout: waits.waitForTimeout,
    waitForLoadState: waits.waitForLoadState,
    waitForSelector: waits.waitForSelector,
    waitForFunction: waits.waitForFunction,
    waitForURL: waits.waitForURL,
    waitForRequest: waits.waitForRequest,
    waitForResponse: waits.waitForResponse,
    waitForEvent: downloads.waitForEvent,
    evaluate,
    screenshot: observe.screenshot,
    snapshot: observe.snapshot,
    snapshotRaw: observe.snapshotRaw,
    elementCenter: observe.elementCenter,
    drainEvents: observe.drainEvents,
    screencast: {
      start: screencast.startScreencast,
      stop: screencast.stopScreencast,
    },
    keyboard: {
      press: keyboard.press,
      down: keyboard.down,
      up: keyboard.up,
      insertText: keyboard.insertText,
      type: keyboard.typeText,
    },
    mouse: {
      click: (x, y, options = {}) => {
        const [target, effectiveOptions] = mousePointArgs(x, y, options);
        return pointer.click(target, effectiveOptions);
      },
      dblclick: (x, y, options = {}) => {
        const [target, effectiveOptions] = mousePointArgs(x, y, options);
        return pointer.dblclick(target, effectiveOptions);
      },
      move: (x, y) => pointer.hover([x, y]),
      down: pointer.down,
      up: pointer.up,
      wheel: pointer.wheel,
      drag: pointer.drag,
    },
  };
}

function mousePointArgs(x, y, options) {
  if (Array.isArray(x) || (x && typeof x === "object")) {
    return [x, y || {}];
  }
  return [[x, y], options || {}];
}

function createBrowserFacade() {
  return {
    listTabs: nav.listTabs,
    currentTab: nav.currentTab,
    switchTab: nav.switchTab,
    openOrReuseTab: nav.openOrReuseTab,
    closeTab: nav.closeTab,
    ensureRealTab: nav.ensureRealTab,
    iframeTarget: nav.iframeTarget,
  };
}

function createTaskSpacesFacade() {
  return {
    list: listTaskSpaces,
    switch: switchTaskSpace,
    new: newTaskSpace,
    useOrCreate: useOrCreateTaskSpace,
    claim: claimTaskSpace,
    complete: completeTaskSpace,
    handOff: handOffTaskSpace,
    takeOver: takeOverTaskSpace,
    waitForAgentControl,
  };
}

function createSiteFacade() {
  return {
    skills: siteSkills,
    skillsForUrl: siteSkillsForUrl,
    runTool: runSiteTool,
    runBrowserTool: runSiteBrowserTool,
    learnContext,
  };
}

const FACADE_HELP: Record<string, string> = {
  page: 'page: Playwright-style page facade. page.url() asynchronously returns the current URL; always call await page.url() before using the string. Use page.goto(url), page.locator(selector), page.getByText(text), page.getByLabel(text), page.getByPlaceholder(text), page.getByTestId(testId), page.setDefaultTimeout(ms), page.waitForEvent("download"), page.waitForLoadState(state, options), page.waitForURL(url, options), page.waitForRequest(urlOrPredicate, options), page.waitForResponse(urlOrPredicate, options), page.evaluate(expression), page.screenshot(options), page.screencast.start({ path, size, quality }), page.screencast.stop(), page.keyboard.press(key), page.keyboard.type(text), and page.mouse.click(x, y). waitForURL predicates receive URL objects and waitUntil defaults to load.',
  locator:
    "page.locator(selector): returns a strict, auto-waiting locator facade with locator(), getByRole(), getByText(), filter(), first(), nth(index), last(), click(), hover(), dragTo(target), scrollIntoViewIfNeeded(), fill(value), clear(), press(key), check(), selectOption(value), textContent(), innerText(), innerHTML(), isVisible(), isEnabled(), getAttribute(name), screenshot(), count(), evaluate(fn, arg), evaluateAll(fn, arg), and waitFor(options). Narrow multiple matches; use first()/nth() only for confirmed legitimate duplicates.",
  browser:
    "browser: tab facade. Use browser.listTabs(), browser.currentTab(), browser.switchTab(target), browser.openOrReuseTab(url, options), and browser.closeTab(target). Treat targetId as short-lived: obtain and validate it in the current script; switchTab/closeTab refresh the tab list before acting.",
  taskSpaces:
    "taskSpaces: task-space facade. Use taskSpaces.useOrCreate(nameOrId), taskSpaces.claim(nameOrId), taskSpaces.switch(nameOrId), taskSpaces.complete(nameOrId, options), taskSpaces.handOff(nameOrId), taskSpaces.takeOver(nameOrId), and taskSpaces.waitForAgentControl(nameOrId, options).",
  site: "site: learned site-skill facade. Use site.skills(url), site.skillsForUrl(url), site.runTool(siteId, toolName, args), site.runBrowserTool(siteId, toolName, args), and site.learnContext(url).",
  fetch:
    "fetch: network facade. Use fetch.server(url, options) for Node-side fetch and fetch.browser(url, options) for browser-origin fetch.",
};

export function helperContext(extra: any = {}) {
  const all = {
    page: createPageFacade(),
    browser: createBrowserFacade(),
    taskSpaces: createTaskSpacesFacade(),
    site: createSiteFacade(),
    fetch: {
      server: serverFetch,
      browser: browserFetch,
    },
    cdp,
    ...extra,
  };
  return {
    ...all,
    help: (...names: string[]) => {
      if (names.length === 1 && FACADE_HELP[names[0]]) {
        return FACADE_HELP[names[0]];
      }
      if (names.length === 0) {
        return Object.values(FACADE_HELP).join("\n\n");
      }
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
