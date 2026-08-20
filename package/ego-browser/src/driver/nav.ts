import {
  browserEgo,
  clearPreferredTarget,
  ensureSession,
  invalidateSession,
  isBrowserRuntime,
  pendingDialog,
  setPreferredTarget,
} from "../browser-runtime.js";
import { cdp, evaluate } from "../cdp-eval.js";
import { assertNoEgoError } from "../ego-errors.js";
import { state } from "../state.js";
import { waitForDocumentLoad } from "./load.js";

export const INTERNAL_URL_PREFIXES = [
  "chrome://",
  "chrome-untrusted://",
  "devtools://",
  "chrome-extension://",
  "about:",
];

type TabInfo = {
  targetId: string;
  title: string;
  url: string;
  active: boolean;
  index?: number;
};

type GotoOptions = {
  waitUntil?: "load" | "domcontentloaded" | "commit";
  timeout?: number;
  settle?: number;
};

type ListTabsOptions = {
  includeChrome?: boolean;
};

type UrlMatchMode = "exact" | "origin" | "origin+path" | "includes";

type OpenOrReuseTabOptions = {
  match?: UrlMatchMode;
  wait?: boolean;
  timeout?: number;
  settle?: number;
};

type TabTarget = string | { targetId: string };

/**
 * Navigate the current tab to a URL and, by default, wait for it to load.
 * @param {string} url Absolute or browser-supported URL to load.
 * @param {{waitUntil?: "load"|"domcontentloaded"|"commit", timeout?: number, settle?: number}} [options]
 *   `waitUntil: "commit"` returns once navigation is issued without waiting for the document to load.
 *   `timeout` and `settle` are in milliseconds.
 * @returns {Promise<{navigation: object, loaded: boolean}>}
 */
export async function goto(url: string, options: GotoOptions = {}) {
  const navigation = await cdp("Page.navigate", { url });
  const loaded =
    options.waitUntil === "commit"
      ? false
      : await waitForDocumentLoad({
          timeout: options.timeout ?? 20000,
          until:
            options.waitUntil === "domcontentloaded"
              ? "domcontentloaded"
              : "load",
        });
  const settle = Number(options.settle ?? 0);
  if (settle > 0) {
    await state.sleep(settle);
  }
  return { navigation, loaded };
}

/**
 * Read basic state for the current page.
 * @returns {Promise<{url:string,title:string,w:number,h:number,sx:number,sy:number,pw:number,ph:number}|{dialog:object}>}
 */
export async function pageInfo() {
  if (isBrowserRuntime()) {
    await ensureSession();
    const dialog = pendingDialog();
    if (dialog) {
      return { dialog };
    }
  }
  const expression = `(() => {
    const root = document.documentElement;
    return JSON.stringify({
      url: location.href,
      title: document.title,
      w: innerWidth,
      h: innerHeight,
      sx: scrollX,
      sy: scrollY,
      pw: root?.scrollWidth ?? innerWidth,
      ph: root?.scrollHeight ?? innerHeight,
    });
  })()`;
  return JSON.parse(await evaluate(expression));
}

/**
 * List open page targets known to the browser.
 * @param {{includeChrome?: boolean}} [options]
 * @returns {Promise<Array<{targetId:string,title:string,url:string}>>}
 */
export async function listTabs(
  options: ListTabsOptions = {},
): Promise<TabInfo[]> {
  const includeChrome = options.includeChrome ?? true;
  const result = assertNoEgoError(await browserEgo().listTabs(), "listTabs");
  const tabs = result.tabs || [];
  return tabs
    .filter(
      (tab) =>
        includeChrome ||
        !INTERNAL_URL_PREFIXES.some((prefix) =>
          (tab.url || "").startsWith(prefix),
        ),
    )
    .map((tab) => ({
      targetId: tab.targetId,
      title: tab.title || "",
      url: tab.url || "",
      active: Boolean(tab.active),
      index: tab.index,
    }));
}

/**
 * Return the currently attached tab.
 * @returns {Promise<{targetId:string,url:string,title:string}>}
 */
export async function currentTab() {
  const tabs = await listTabs();
  const active = tabs.find((tab) => tab.active) || tabs[0];
  if (!active) {
    throw new Error("no active browser tab");
  }
  return { targetId: active.targetId, url: active.url, title: active.title };
}

/**
 * Activate an existing tab target.
 * @param {string|{targetId:string}} target Target id or tab-like object.
 * @returns {Promise<string>} Target id.
 */
export async function switchTab(target: string | { targetId: string }) {
  const targetId = targetIdFrom(target, "switchTab");
  const tabs = await listTabs();
  currentTargetFrom(tabs, targetId, "switchTab");
  await cdp("Target.activateTarget", { targetId });
  invalidateSession();
  setPreferredTarget(targetId);
  return targetId;
}

/**
 * Open a new tab and optionally navigate it.
 * @param {string} [url="about:blank"] URL to open.
 * @returns {Promise<string>} New target id.
 */
export async function newTab(url = "about:blank") {
  const result = assertNoEgoError(await browserEgo().createTab(url), "newTab");
  if (!result.targetId) {
    throw new Error("newTab returned no targetId");
  }
  return result.targetId;
}

/**
 * Reuse an existing matching tab or open a new one.
 * @param {string} url URL to find or open.
 * @param {{match?: "exact"|"origin"|"origin+path"|"includes", wait?: boolean, timeout?: number, settle?: number}} [options]
 * @returns {Promise<{targetId:string,url:string,title:string,active:boolean,index?:number,reused:boolean}>}
 */
export async function openOrReuseTab(
  url: string,
  options: OpenOrReuseTabOptions = {},
) {
  const tabs = await listTabs({ includeChrome: false });
  const match = options.match || "exact";
  const existing = tabs.find((tab) => tabMatchesUrl(tab.url, url, match));
  if (existing) {
    await switchTab(existing.targetId);
    if (options.wait) {
      await waitForDocumentLoad({ timeout: options.timeout ?? 20000 });
    }
    const settle = Number(options.settle ?? 0);
    if (settle > 0) {
      await state.sleep(settle);
    }
    return { ...existing, active: true, reused: true };
  }
  const targetId = await newTab(url);
  if (options.wait !== false) {
    await waitForDocumentLoad({ timeout: options.timeout ?? 20000 });
  }
  const settle = Number(options.settle ?? 0);
  if (settle > 0) {
    await state.sleep(settle);
  }
  return { targetId, url, title: "", active: true, reused: false };
}

/**
 * Close a browser tab by target id, tab object, or the current tab when omitted.
 * Refuses to close the last tab because doing so also destroys the task space;
 * use taskSpaces.complete(..., { keep: false }) for that explicit lifecycle action.
 * @param {string|{targetId:string}} [target] Target id or tab-like object. Defaults to the current tab.
 * @returns {Promise<string>} Closed target id.
 */
export async function closeTab(target: TabTarget | undefined = undefined) {
  const tabs = await listTabs();
  const targetId =
    target === undefined
      ? (tabs.find((tab) => tab.active) || tabs[0])?.targetId
      : targetIdFrom(target, "closeTab");
  if (!targetId) throw new Error("closeTab requires a targetId");
  currentTargetFrom(tabs, targetId, "closeTab");
  if (tabs.length === 1) {
    throw new Error(
      "closeTab refuses to close the last tab because that would destroy the task space. " +
        "Use taskSpaces.complete(nameOrId, { keep: false }) to close the task space explicitly.",
    );
  }
  await cdp("Target.closeTarget", { targetId });
  invalidateSession();
  if (state.preferredTargetId === targetId) {
    clearPreferredTarget();
  }
  if (tabs.length > 1) {
    await waitForClosedTarget(targetId);
  }
  return targetId;
}

/**
 * Ensure the active harness session points at a real, non-internal page tab.
 * @returns {Promise<{targetId:string,title:string,url:string}|null>}
 */
export async function ensureRealTab() {
  const tabs = await listTabs({ includeChrome: false });
  if (tabs.length === 0) {
    return null;
  }
  const current = await currentTab().catch(() => null);
  if (
    current?.url &&
    !INTERNAL_URL_PREFIXES.some((prefix) => current.url.startsWith(prefix))
  ) {
    return current;
  }
  await switchTab(tabs[0].targetId);
  return tabs[0];
}

/**
 * Find an iframe target whose URL contains a substring.
 * @param {string} urlSubstring URL substring to match.
 * @returns {Promise<string|null>} Matching iframe target id, if any.
 */
export async function iframeTarget(urlSubstring) {
  const targets = (await cdp("Target.getTargets")).targetInfos || [];
  return (
    targets.find(
      (target) =>
        target.type === "iframe" && (target.url || "").includes(urlSubstring),
    )?.targetId || null
  );
}

function tabMatchesUrl(tabUrl: string, wantedUrl: string, match: UrlMatchMode) {
  if (!tabUrl) {
    return false;
  }
  if (match === "includes") {
    return tabUrl.includes(wantedUrl);
  }
  let tab;
  let wanted;
  try {
    tab = new URL(tabUrl);
    wanted = new URL(wantedUrl);
  } catch {
    return tabUrl === wantedUrl;
  }
  if (match === "origin") {
    return tab.origin === wanted.origin;
  }
  if (match === "origin+path") {
    return (
      tab.origin === wanted.origin &&
      trimSlash(tab.pathname) === trimSlash(wanted.pathname)
    );
  }
  return tab.href === wanted.href;
}

function trimSlash(pathname: string) {
  return pathname.replace(/\/+$/, "") || "/";
}

function targetIdFrom(target: TabTarget, operation: string) {
  const targetId =
    typeof target === "string"
      ? target
      : target && typeof target === "object"
        ? target.targetId
        : undefined;
  if (typeof targetId !== "string" || !targetId) {
    throw new Error(
      `${operation} requires a targetId; received ${JSON.stringify(target)}`,
    );
  }
  return targetId;
}

function currentTargetFrom(
  tabs: TabInfo[],
  targetId: string,
  operation: string,
) {
  const tab = tabs.find((candidate) => candidate.targetId === targetId);
  if (tab) return tab;
  const available = tabs.map(({ targetId, title, url }) => ({
    targetId,
    title,
    url,
  }));
  throw new Error(
    `${operation} target not found: ${JSON.stringify(targetId)}. ` +
      `Refresh browser.listTabs() and select a current targetId. ` +
      `Available tabs: ${JSON.stringify(available)}`,
  );
}

async function waitForClosedTarget(targetId: string) {
  const deadline = state.now() + 2000;
  while (true) {
    const tabs = await listTabs();
    if (!tabs.some((tab) => tab.targetId === targetId)) return tabs;
    if (state.now() >= deadline) {
      throw new Error(
        `closeTab timed out waiting for target to close: ${JSON.stringify(targetId)}`,
      );
    }
    await state.sleep(50);
  }
}
