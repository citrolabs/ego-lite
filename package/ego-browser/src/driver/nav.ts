import { browserEgo, invalidateSession, setPreferredTarget } from "../browser-runtime.js";
import { cdp, js } from "../cdp-eval.js";
import { state } from "../state.js";
import { waitForDocumentLoad } from "./load.js";

export const INTERNAL_URL_PREFIXES = ["chrome://", "chrome-untrusted://", "devtools://", "chrome-extension://", "about:"];

type TabInfo = {
  targetId: string;
  title: string;
  url: string;
  active: boolean;
  index?: number;
};

type GotoAndWaitOptions = {
  timeout?: number;
  settle?: number;
  wait?: boolean;
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

/**
 * Navigate the current tab to a URL using CDP Page.navigate.
 * @param {string} url Absolute or browser-supported URL to load.
 * @returns {Promise<object>} CDP Page.navigate result.
 */
export async function gotoUrl(url) {
  return cdp("Page.navigate", { url });
}

/**
 * Navigate the current tab and wait for load/settle in one call.
 * @param {string} url Absolute or browser-supported URL to load.
 * @param {{timeout?: number, settle?: number, wait?: boolean}} [options]
 * @returns {Promise<{navigation: object, loaded: boolean}>}
 */
export async function gotoAndWait(url: string, options: GotoAndWaitOptions = {}) {
  const navigation = await gotoUrl(url);
  const loaded = options.wait === false ? false : await waitForDocumentLoad({ timeout: options.timeout ?? 20 });
  const settle = Number(options.settle ?? 0);
  if (settle > 0) {
    await state.sleep(settle * 1000);
  }
  return { navigation, loaded };
}

/**
 * Read basic state for the current page.
 * @returns {Promise<{url:string,title:string,w:number,h:number,sx:number,sy:number,pw:number,ph:number}>}
 */
export async function pageInfo() {
  const expression = "JSON.stringify({url:location.href,title:document.title,w:innerWidth,h:innerHeight,sx:scrollX,sy:scrollY,pw:document.documentElement.scrollWidth,ph:document.documentElement.scrollHeight})";
  return JSON.parse(await js(expression));
}

/**
 * List open page targets known to the browser.
 * @param {{includeChrome?: boolean}} [options]
 * @returns {Promise<Array<{targetId:string,title:string,url:string}>>}
 */
export async function listTabs(options: ListTabsOptions = {}): Promise<TabInfo[]> {
  const includeChrome = options.includeChrome ?? true;
  const result = await browserEgo().listTabs();
  const tabs = result.tabs || [];
  return tabs
    .filter((tab) => includeChrome || !INTERNAL_URL_PREFIXES.some((prefix) => (tab.url || "").startsWith(prefix)))
    .map((tab) => ({ targetId: tab.targetId, title: tab.title || "", url: tab.url || "", active: Boolean(tab.active), index: tab.index }));
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
  const targetId = typeof target === "object" ? target.targetId : target;
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
  const result = await browserEgo().createTab(url);
  return result.targetId;
}

/**
 * Reuse an existing matching tab or open a new one.
 * @param {string} url URL to find or open.
 * @param {{match?: "exact"|"origin"|"origin+path"|"includes", wait?: boolean, timeout?: number, settle?: number}} [options]
 * @returns {Promise<{targetId:string,url:string,title:string,active:boolean,index?:number,reused:boolean}>}
 */
export async function openOrReuseTab(url: string, options: OpenOrReuseTabOptions = {}) {
  const tabs = await listTabs({ includeChrome: false });
  const match = options.match || "exact";
  const existing = tabs.find((tab) => tabMatchesUrl(tab.url, url, match));
  if (existing) {
    await switchTab(existing.targetId);
    if (options.wait) {
      await waitForDocumentLoad({ timeout: options.timeout ?? 20 });
    }
    const settle = Number(options.settle ?? 0);
    if (settle > 0) {
      await state.sleep(settle * 1000);
    }
    return { ...existing, active: true, reused: true };
  }
  const targetId = await newTab(url);
  if (options.wait !== false) {
    await waitForDocumentLoad({ timeout: options.timeout ?? 20 });
  }
  const settle = Number(options.settle ?? 0);
  if (settle > 0) {
    await state.sleep(settle * 1000);
  }
  return { targetId, url, title: "", active: true, reused: false };
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
  if (current?.url && !INTERNAL_URL_PREFIXES.some((prefix) => current.url.startsWith(prefix))) {
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
  return targets.find((target) => target.type === "iframe" && (target.url || "").includes(urlSubstring))?.targetId || null;
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
    return tab.origin === wanted.origin && trimSlash(tab.pathname) === trimSlash(wanted.pathname);
  }
  return tab.href === wanted.href;
}

function trimSlash(pathname: string) {
  return pathname.replace(/\/+$/, "") || "/";
}
