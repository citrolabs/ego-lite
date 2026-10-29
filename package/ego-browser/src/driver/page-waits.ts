import {
  isCdpRequestTimeoutError,
  isFrameLifecycleError,
  isSessionLostError,
} from "../browser-runtime.js";
import {
  ElementResolutionError,
  resolveElementObjectId,
} from "../element-resolver.js";
import { type RefMap } from "../ref-map.js";

const SELECTOR_POLL_INTERVAL_MS = 100;
/** How often a polling wait re-enumerates iframe sessions to catch late frames. */
const FRAME_DISCOVERY_REFRESH_INTERVAL_MS = 500;
/**
 * An element failure worth another resolution attempt: the resolver reported a
 * transient state, or a frame vanished mid-resolution. Session loss is not
 * included; callers decide whether the lost session was the Page itself.
 */
export function isTransientElementError(error: unknown): error is Error {
  return (
    isFrameLifecycleError(error) ||
    (error instanceof ElementResolutionError && error.kind === "transient")
  );
}

type PageWaitServices = {
  cdp(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<any>;
  ensureNetworkTracking(
    sessionIds: string[],
    timeoutMs?: number,
  ): Promise<void>;
  pageNetworkSessions(sessionId: string, timeoutMs?: number): Promise<string[]>;
  networkActivity(sessionIds: string[]): {
    tracking: boolean;
    inflight: number;
    lastActivityAt: number;
    pendingRequests?: string[];
  };
  now(): number;
  sleep(ms: number): Promise<void>;
};

export type PageWaitForSelectorOptions = {
  timeout?: number;
  state?: "attached" | "detached" | "visible" | "hidden";
};

export type PageWaitForLoadStateOptions = {
  timeout?: number;
  idleMs?: number;
};

export type PageGotoWaitUntil =
  | "commit"
  | "domcontentloaded"
  | "load"
  | "networkidle";

export type PageNavigationOptions = {
  timeoutMs: number;
  waitUntil: PageGotoWaitUntil;
  referer?: string;
  /**
   * Absolute deadline when the public call started before this function,
   * so session setup counts against the caller's timeout.
   */
  deadline?: number;
};

export type PageWaitForURLOptions = {
  timeout?: number;
};

export type PageURLMatcher = string | RegExp | ((url: URL) => boolean);

export type PageWaitForURLHooks = {
  interrupt?: (
    lastUrl: string,
    matches: (url: string) => boolean,
  ) => Error | undefined;
};

export class PageNavigationTimeoutError extends Error {
  readonly code = "EGO_NAVIGATION_TIMEOUT";
  readonly committed: boolean;
  /**
   * The Page did not answer at the deadline, so the harness sent
   * Page.stopLoading and the Page answered again: with `committed` false it
   * still shows its previous document, with `committed` true the navigation
   * landed at the deadline and only its remaining loading was stopped.
   */
  readonly stopped: boolean;
  readonly url?: string;
  readonly readyState?: string;
  readonly waitUntil: PageGotoWaitUntil;
  readonly timeoutMs: number;

  constructor(
    message: string,
    details: {
      committed: boolean;
      stopped?: boolean;
      url?: string;
      readyState?: string;
      waitUntil: PageGotoWaitUntil;
      timeoutMs: number;
    },
  ) {
    super(message);
    this.name = "PageNavigationTimeoutError";
    this.committed = details.committed;
    this.stopped = details.stopped === true;
    this.url = details.url;
    this.readyState = details.readyState;
    this.waitUntil = details.waitUntil;
    this.timeoutMs = details.timeoutMs;
  }
}

// Page.stopLoading is answered by the browser process, so a pending
// navigation cannot stall it; the frame-tree probe afterwards confirms the
// renderer answers again. Both stay short: they run after the caller's
// deadline has already passed.
const STOP_PENDING_NAVIGATION_TIMEOUT_MS = 1_000;
// A responsive Page answers Page.getFrameTree within milliseconds. The probe
// before Page.navigate only records the current document; the probe at the
// deadline decides whether the navigation is still pending.
const PREVIOUS_DOCUMENT_PROBE_TIMEOUT_MS = 500;
const NAVIGATION_DEADLINE_PROBE_TIMEOUT_MS = 250;

const VISIBILITY_FUNCTION =
  "function(){if(typeof this.checkVisibility==='function')return this.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});const s=getComputedStyle(this);const r=this.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0'&&r.width>0&&r.height>0;}";

/** Wait for a selector inside one explicit Page session. */
export async function waitForSelectorInPage(
  services: PageWaitServices,
  sessionId: string,
  refMap: RefMap,
  selector: string,
  options: PageWaitForSelectorOptions = {},
  getIframeSessions: (timeoutMs: number) => Promise<Map<string, string>>,
): Promise<true> {
  if (typeof selector !== "string" || selector.length === 0) {
    throw new TypeError(
      "page.waitForSelector selector must be a non-empty string",
    );
  }
  const timeoutMs = options.timeout ?? 10_000;
  const state = options.state ?? "visible";

  const deadline = services.now() + timeoutMs;
  let iframeSessions: Map<string, string> | undefined;
  let refreshFrames = false;
  let nextDiscoveryAt = 0;
  while (true) {
    let resolved: { objectId: string; sessionId: string } | undefined;
    try {
      if (
        !iframeSessions ||
        (refreshFrames && services.now() >= nextDiscoveryAt)
      ) {
        iframeSessions = await getIframeSessions(
          Math.max(1, deadline - services.now()),
        );
        nextDiscoveryAt = services.now() + FRAME_DISCOVERY_REFRESH_INTERVAL_MS;
        refreshFrames = false;
      }
      resolved = await resolveElementObjectId(
        cdpAdapter(services),
        sessionId,
        refMap,
        selector,
        iframeSessions,
      );
      if (state === "attached") return true;
      if (state !== "detached") {
        const response = await services.cdp(
          "Runtime.callFunctionOn",
          {
            functionDeclaration: VISIBILITY_FUNCTION,
            objectId: resolved.objectId,
            returnByValue: true,
            awaitPromise: false,
          },
          resolved.sessionId,
        );
        const visible = response?.result?.value === true;
        if (state === "visible" ? visible : !visible) return true;
      }
    } catch (error) {
      // Frame discovery is bounded by the remaining budget; a transport timeout
      // at the deadline is this wait's own timeout, not a distinct failure.
      if (isCdpRequestTimeoutError(error) && deadline - services.now() <= 0) {
        break;
      }
      if (!isRetryableSelectorWaitError(error, sessionId)) {
        throw error;
      }
      if (error instanceof ElementResolutionError) {
        if (state === "detached" || state === "hidden") return true;
        // The element may live in an iframe that appears later; re-enumerate
        // frames at a throttled cadence while polling.
        refreshFrames = true;
      } else {
        // A frame or its session vanished: rediscover before the next attempt.
        refreshFrames = true;
        nextDiscoveryAt = 0;
      }
    } finally {
      if (resolved?.objectId) {
        await services
          .cdp(
            "Runtime.releaseObject",
            { objectId: resolved.objectId },
            resolved.sessionId,
          )
          .catch(() => {});
      }
    }
    const remaining = deadline - services.now();
    if (remaining <= 0) break;
    await services.sleep(Math.min(SELECTOR_POLL_INTERVAL_MS, remaining));
  }
  throw new Error(
    `page.waitForSelector timed out after ${timeoutMs}ms: ${selector}`,
  );
}

function isRetryableSelectorWaitError(
  error: unknown,
  pageSessionId: string,
): boolean {
  if (
    isTransientElementError(error) ||
    isTransientNavigationContextError(error)
  )
    return true;
  // A lost iframe session is recovered by rediscovery. A lost Page session is
  // terminal: never report a closed page as "hidden" or keep polling it.
  return (
    isSessionLostError(error) &&
    typeof error.sessionId === "string" &&
    error.sessionId !== pageSessionId
  );
}

/** Wait until one Page URL matches an exact string, glob, RegExp, or predicate. */
export async function waitForURLInPage(
  services: PageWaitServices,
  sessionId: string,
  expected: PageURLMatcher,
  options: PageWaitForURLOptions = {},
  hooks: PageWaitForURLHooks = {},
): Promise<void> {
  const matcher = compilePageURLMatcher(expected);
  const timeoutMs = options.timeout ?? 10_000;
  const deadline = services.now() + timeoutMs;
  let lastUrl = "";
  while (services.now() <= deadline) {
    const remaining = Math.max(1, deadline - services.now());
    let response;
    try {
      response = await services.cdp(
        "Runtime.evaluate",
        { expression: "location.href", returnByValue: true },
        sessionId,
        Math.min(1_000, remaining),
      );
    } catch (error) {
      if (isRuntimeEvaluateTimeout(error)) {
        if (services.now() >= deadline) break;
      } else if (!isTransientNavigationContextError(error)) {
        throw error;
      }
    }
    if (typeof response?.result?.value === "string") {
      lastUrl = response.result.value;
      if (matcher.matches(lastUrl)) return;
    }
    const interruption = hooks.interrupt?.(lastUrl, matcher.matches);
    if (interruption) throw interruption;
    const waitMs = deadline - services.now();
    if (waitMs <= 0) break;
    await services.sleep(Math.min(100, waitMs));
  }
  throw new Error(
    `page.waitForURL timed out after ${timeoutMs}ms: expected ${matcher.description}; last URL was ${JSON.stringify(lastUrl)}`,
  );
}

function compilePageURLMatcher(expected: PageURLMatcher): {
  matches(url: string): boolean;
  description: string;
} {
  if (typeof expected === "string") {
    if (expected.length === 0) {
      throw invalidPageURLMatcherError();
    }
    const pattern = urlGlobToRegExp(expected);
    return {
      matches: (url) => pattern.test(url),
      description: JSON.stringify(expected),
    };
  }

  if (expected instanceof RegExp) {
    const pattern = new RegExp(expected.source, expected.flags);
    return {
      matches(url) {
        pattern.lastIndex = 0;
        return pattern.test(url);
      },
      description: pattern.toString(),
    };
  }

  if (typeof expected === "function") {
    return {
      matches(url) {
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          return false;
        }
        let result: unknown;
        try {
          result = expected(parsed);
        } catch (error) {
          // Agents often treat the argument as a string (`url.includes(...)`).
          if (!(error instanceof TypeError)) throw error;
          throw new TypeError(
            `page.waitForURL predicate threw: ${error.message}. The predicate receives a URL object; use url.href, url.pathname, or url.searchParams.`,
            { cause: error },
          );
        }
        if (typeof result !== "boolean") {
          throw new TypeError(
            "page.waitForURL predicate must return a boolean synchronously",
          );
        }
        return result;
      },
      description: "a URL predicate",
    };
  }

  throw invalidPageURLMatcherError();
}

function invalidPageURLMatcherError(): TypeError {
  return new TypeError(
    "page.waitForURL expected URL must be a non-empty string, RegExp, or function",
  );
}

const URL_REGEX_SPECIAL_CHARS = new Set([
  "$",
  "^",
  "+",
  ".",
  "*",
  "(",
  ")",
  "|",
  "\\",
  "?",
  "{",
  "}",
  "[",
  "]",
]);

/** Compile the URL-glob subset used by Playwright string matchers. */
function urlGlobToRegExp(glob: string): RegExp {
  const tokens = ["^"];
  let inGroup = false;

  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "\\" && index + 1 < glob.length) {
      const escaped = glob[(index += 1)];
      tokens.push(
        URL_REGEX_SPECIAL_CHARS.has(escaped) ? `\\${escaped}` : escaped,
      );
      continue;
    }

    if (char === "*") {
      const charBefore = glob[index - 1];
      let starCount = 1;
      while (glob[index + 1] === "*") {
        starCount += 1;
        index += 1;
      }
      if (starCount === 1) {
        tokens.push("[^/]*");
        continue;
      }

      const charAfter = glob[index + 1];
      if (charAfter === "/") {
        tokens.push(charBefore === "/" ? "(?:(?:.+)/)?" : "(?:.*/)");
        index += 1;
      } else {
        tokens.push(".*");
      }
      continue;
    }

    if (char === "{") {
      if (inGroup) {
        throw invalidURLGlobError(glob, "nested '{' is not supported");
      }
      inGroup = true;
      tokens.push("(");
      continue;
    }
    if (char === "}") {
      if (!inGroup) throw invalidURLGlobError(glob, "unmatched '}'");
      inGroup = false;
      tokens.push(")");
      continue;
    }
    if (char === "," && inGroup) {
      tokens.push("|");
      continue;
    }

    tokens.push(URL_REGEX_SPECIAL_CHARS.has(char) ? `\\${char}` : char);
  }

  if (inGroup) throw invalidURLGlobError(glob, "unmatched '{'");
  tokens.push("$");
  return new RegExp(tokens.join(""));
}

function invalidURLGlobError(glob: string, reason: string): TypeError {
  return new TypeError(`Invalid URL glob ${JSON.stringify(glob)}: ${reason}`);
}

/** Navigate one Page and wait for the selected state of this navigation. */
export async function navigateInPage(
  services: PageWaitServices,
  sessionId: string,
  url: string,
  options: PageNavigationOptions,
): Promise<void> {
  const { timeoutMs, waitUntil, referer } = options;
  const deadline = options.deadline ?? services.now() + timeoutMs;
  let committed = false;
  let navigateSent = false;
  let previousFrame: MainFrame = {};
  let navigation: {
    frameId?: string;
    loaderId?: string;
    errorText?: string;
    isDownload?: boolean;
  } = {};
  try {
    // Network tracking must start before Page.navigate or the initial document
    // requests can be missed by a network-idle wait.
    if (waitUntil === "networkidle") {
      await services.ensureNetworkTracking(
        [sessionId],
        navigationTimeRemaining(services, deadline, timeoutMs, waitUntil),
      );
    }
    // Chromium answers Page.navigate only once the navigation is ready to
    // commit or has failed, so a held response leaves this call without a
    // loaderId. The document in place before the request is the reference
    // the deadline probe compares against instead.
    previousFrame = await mainFrameIfResponsive(
      services,
      sessionId,
      Math.min(
        PREVIOUS_DOCUMENT_PROBE_TIMEOUT_MS,
        navigationTimeRemaining(services, deadline, timeoutMs, waitUntil),
      ),
    );
    navigateSent = true;
    const response = await services.cdp(
      "Page.navigate",
      {
        url,
        ...(referer === undefined ? {} : { referrer: referer }),
      },
      sessionId,
      navigationTimeRemaining(services, deadline, timeoutMs, waitUntil),
    );
    navigation = response?.result || response || {};
    if (navigation.errorText) {
      throw new Error(`page.goto failed: ${navigation.errorText}`);
    }
    if (navigation.isDownload === true) {
      throw new Error("page.goto failed: navigation started a download");
    }

    await waitForNavigationCommit(
      services,
      sessionId,
      navigation,
      deadline,
      timeoutMs,
      waitUntil,
    );
    committed = true;
    if (waitUntil === "commit") return;

    await waitForLoadStateInPage(services, sessionId, waitUntil, {
      timeout: navigationTimeRemaining(
        services,
        deadline,
        timeoutMs,
        waitUntil,
      ),
    });
  } catch (error) {
    if (services.now() >= deadline || isLoadStateTimeout(error)) {
      let probe: NavigationProbe = committed ? "committed" : "not-committed";
      if (!committed && navigateSent) {
        probe = await probeNavigation(
          services,
          sessionId,
          navigation,
          previousFrame,
        );
      }
      // Chromium suspends every renderer-bound command while a main-frame
      // navigation has started but not committed, so leaving it pending would
      // hand back a Page that stalls each later call for a full transport
      // timeout. The caller asked for a bounded wait: stop the navigation and
      // leave the Page usable on its previous document. A hung renderer looks
      // the same from here and cannot be told apart without an answer from
      // it; stopping is still safe then, because the navigation this call
      // itself started is the only load in flight that the caller asked for,
      // and the frame read after the stop reports what is actually in place.
      let stopped = false;
      if (probe === "unresponsive") {
        const outcome = await stopPendingNavigation(
          services,
          sessionId,
          navigation,
          previousFrame,
        );
        stopped = outcome !== "unresponsive";
        if (outcome === "committed") probe = "committed";
      }
      committed = probe === "committed";
      const state = committed
        ? await currentDocumentState(services, sessionId)
        : {};
      throw navigationTimeout(timeoutMs, waitUntil, {
        committed,
        ...state,
        stopped,
        pending: probe === "unresponsive",
        requestedUrl: url,
      });
    }
    throw error;
  }
}

type NavigationProbe = "committed" | "not-committed" | "unresponsive";

/**
 * Whether the main frame shows the document a navigation was for: the
 * loaderId Page.navigate reported when there is one, otherwise any change
 * from the document that was in place before the request.
 */
function frameShowsNavigation(
  frame: MainFrame,
  navigation: { frameId?: string; loaderId?: string },
  previousFrame: MainFrame,
): boolean {
  if (navigation.loaderId) {
    return (
      frame.loaderId === navigation.loaderId &&
      (!navigation.frameId || frame.id === navigation.frameId)
    );
  }
  return Boolean(
    previousFrame.loaderId &&
    frame.loaderId &&
    frame.loaderId !== previousFrame.loaderId,
  );
}

/**
 * One short frame-tree probe at a navigation deadline. A Page that answers
 * has no main-frame navigation pending: either the requested document is in
 * place or nothing replaced the previous one. A Page that does not answer
 * still has the navigation pending.
 */
async function probeNavigation(
  services: PageWaitServices,
  sessionId: string,
  navigation: { frameId?: string; loaderId?: string },
  previousFrame: MainFrame,
): Promise<NavigationProbe> {
  let frame: MainFrame;
  try {
    frame = await mainFrame(
      services,
      sessionId,
      NAVIGATION_DEADLINE_PROBE_TIMEOUT_MS,
    );
  } catch (error) {
    if (isCdpTimeout(error, "Page.getFrameTree")) return "unresponsive";
    // Any other failure is not evidence of a pending navigation.
    return "not-committed";
  }
  return frameShowsNavigation(frame, navigation, previousFrame)
    ? "committed"
    : "not-committed";
}

/** The main frame, or an empty record when the Page does not answer in time. */
async function mainFrameIfResponsive(
  services: PageWaitServices,
  sessionId: string,
  timeoutMs: number,
): Promise<MainFrame> {
  try {
    return await mainFrame(services, sessionId, timeoutMs);
  } catch {
    return {};
  }
}

/**
 * Stop a navigation that has not committed and read the main frame once the
 * Page answers again. The navigation may commit between the deadline probe
 * and the stop taking effect, so the frame read afterwards decides whether
 * the previous document is still in place ("stopped") or the new one is
 * ("committed", with its loading stopped). A hung renderer answers neither.
 */
async function stopPendingNavigation(
  services: PageWaitServices,
  sessionId: string,
  navigation: { frameId?: string; loaderId?: string },
  previousFrame: MainFrame,
): Promise<"stopped" | "committed" | "unresponsive"> {
  try {
    await services.cdp(
      "Page.stopLoading",
      {},
      sessionId,
      STOP_PENDING_NAVIGATION_TIMEOUT_MS,
    );
    const frame = await mainFrame(
      services,
      sessionId,
      STOP_PENDING_NAVIGATION_TIMEOUT_MS,
    );
    return frameShowsNavigation(frame, navigation, previousFrame)
      ? "committed"
      : "stopped";
  } catch {
    return "unresponsive";
  }
}

/**
 * The sentence a timeout error adds when the navigation it waited for is
 * still pending or was stopped, so the agent knows which document the Page
 * shows and what to do next.
 */
function pendingNavigationNote(
  what: string,
  outcome: "stopped" | "committed" | "unresponsive",
  retry: string,
): string {
  if (outcome === "stopped") {
    return `; ${what} had not committed and was stopped, so the Page still shows its previous document. Retry ${retry} with a longer timeout, or continue on a new Page from task.newPage().`;
  }
  if (outcome === "committed") {
    return `; ${what} committed at the deadline but its loading was stopped. Call page.reload({ timeout }) if the rest of the document is required.`;
  }
  return `; ${what} has not committed and the Page did not answer even after Page.stopLoading, so its renderer is probably hung. Continue on a new Page from task.newPage(), or close this Page and open it again.`;
}

/** Reload one Page and wait for the selected state of the new document. */
export async function reloadInPage(
  services: PageWaitServices,
  sessionId: string,
  options: Omit<PageNavigationOptions, "referer">,
): Promise<void> {
  const { timeoutMs, waitUntil } = options;
  const deadline = options.deadline ?? services.now() + timeoutMs;
  let reloadSent = false;
  let committed = false;
  let previousFrame: MainFrame = {};
  try {
    previousFrame = await mainFrame(
      services,
      sessionId,
      reloadTimeRemaining(services, deadline, timeoutMs, waitUntil),
    );
    if (waitUntil === "networkidle") {
      await services.ensureNetworkTracking(
        [sessionId],
        reloadTimeRemaining(services, deadline, timeoutMs, waitUntil),
      );
    }
    await services.cdp(
      "Page.reload",
      previousFrame.loaderId === undefined
        ? {}
        : { loaderId: previousFrame.loaderId },
      sessionId,
      reloadTimeRemaining(services, deadline, timeoutMs, waitUntil),
    );
    reloadSent = true;
    await waitForReloadCommit(
      services,
      sessionId,
      previousFrame,
      deadline,
      timeoutMs,
      waitUntil,
    );
    committed = true;
    if (waitUntil === "commit") return;
    await waitForLoadStateInPage(services, sessionId, waitUntil, {
      timeout: reloadTimeRemaining(services, deadline, timeoutMs, waitUntil),
    });
  } catch (error) {
    if (services.now() >= deadline || isLoadStateTimeout(error)) {
      // Same as page.goto: a reload that has not committed stalls every later
      // call on this Page, so stop it before reporting the timeout.
      const pending =
        !committed &&
        reloadSent &&
        (await probeNavigation(services, sessionId, {}, previousFrame)) ===
          "unresponsive";
      throw reloadTimeout(
        timeoutMs,
        waitUntil,
        pending
          ? pendingNavigationNote(
              "the reload",
              await stopPendingNavigation(
                services,
                sessionId,
                {},
                previousFrame,
              ),
              "page.reload({ timeout })",
            )
          : "",
      );
    }
    throw error;
  }
}

type MainFrame = { id?: string; loaderId?: string };

async function mainFrame(
  services: PageWaitServices,
  sessionId: string,
  timeoutMs: number,
): Promise<MainFrame> {
  const response = await services.cdp(
    "Page.getFrameTree",
    {},
    sessionId,
    timeoutMs,
  );
  return response?.result?.frameTree?.frame || response?.frameTree?.frame || {};
}

async function waitForReloadCommit(
  services: PageWaitServices,
  sessionId: string,
  previousFrame: MainFrame,
  deadline: number,
  timeoutMs: number,
  waitUntil: PageGotoWaitUntil,
): Promise<void> {
  while (services.now() <= deadline) {
    const remaining = reloadTimeRemaining(
      services,
      deadline,
      timeoutMs,
      waitUntil,
    );
    try {
      const frame = await mainFrame(
        services,
        sessionId,
        Math.min(1_000, remaining),
      );
      if (
        frame.loaderId &&
        (frame.loaderId !== previousFrame.loaderId ||
          (previousFrame.id && frame.id !== previousFrame.id))
      ) {
        return;
      }
    } catch (error) {
      if (!isCdpTimeout(error, "Page.getFrameTree")) throw error;
    }
    const waitMs = deadline - services.now();
    if (waitMs <= 0) break;
    await services.sleep(Math.min(50, waitMs));
  }
  throw reloadTimeout(timeoutMs, waitUntil);
}

function reloadTimeRemaining(
  services: PageWaitServices,
  deadline: number,
  timeoutMs: number,
  waitUntil: PageGotoWaitUntil,
): number {
  const remaining = deadline - services.now();
  if (remaining <= 0) throw reloadTimeout(timeoutMs, waitUntil);
  return remaining;
}

function reloadTimeout(
  timeoutMs: number,
  waitUntil: PageGotoWaitUntil,
  note = "",
): Error {
  return new Error(
    `page.reload timed out after ${timeoutMs}ms waiting for ${waitUntil}${note}`,
  );
}

async function waitForNavigationCommit(
  services: PageWaitServices,
  sessionId: string,
  navigation: { frameId?: string; loaderId?: string },
  deadline: number,
  timeoutMs: number,
  waitUntil: PageGotoWaitUntil,
): Promise<void> {
  // CDP omits loaderId for a same-document navigation. Page.navigate has
  // already committed that URL change, and the existing document has already
  // passed its DOMContentLoaded and load boundaries.
  if (!navigation.loaderId) return;

  while (services.now() <= deadline) {
    const remaining = navigationTimeRemaining(
      services,
      deadline,
      timeoutMs,
      waitUntil,
    );
    try {
      const response = await services.cdp(
        "Page.getFrameTree",
        {},
        sessionId,
        Math.min(1_000, remaining),
      );
      const frame =
        response?.result?.frameTree?.frame || response?.frameTree?.frame;
      if (
        frame?.loaderId === navigation.loaderId &&
        (!navigation.frameId || frame?.id === navigation.frameId)
      ) {
        return;
      }
    } catch (error) {
      if (!isCdpTimeout(error, "Page.getFrameTree")) throw error;
    }
    const waitMs = deadline - services.now();
    if (waitMs <= 0) break;
    await services.sleep(Math.min(50, waitMs));
  }
  throw navigationTimeout(timeoutMs, waitUntil);
}

function navigationTimeRemaining(
  services: PageWaitServices,
  deadline: number,
  timeoutMs: number,
  waitUntil: PageGotoWaitUntil,
): number {
  const remaining = deadline - services.now();
  if (remaining <= 0) throw navigationTimeout(timeoutMs, waitUntil);
  return remaining;
}

function navigationTimeout(
  timeoutMs: number,
  waitUntil: PageGotoWaitUntil,
  details: {
    committed?: boolean;
    /** The harness sent Page.stopLoading and the Page answered afterwards. */
    stopped?: boolean;
    url?: string;
    readyState?: string;
    /** The navigation is still pending; the Page did not answer. */
    pending?: boolean;
    requestedUrl?: string;
  } = {},
): PageNavigationTimeoutError {
  const committed = details.committed === true;
  const stopped = details.stopped === true;
  let state = "";
  if (committed) {
    const where = `${details.url ? ` at ${JSON.stringify(details.url)}` : ""}${details.readyState ? ` with document.readyState=${JSON.stringify(details.readyState)}` : ""}`;
    state = stopped
      ? `; navigation committed${where}, but its loading was stopped at the deadline. Call page.reload({ timeout }) if the rest of the document is required.`
      : `; navigation committed${where}. ${navigationTimeoutNextStep(waitUntil)}`;
  } else if (stopped || details.pending) {
    state = pendingNavigationNote(
      `the navigation${details.requestedUrl ? ` to ${JSON.stringify(details.requestedUrl)}` : ""}`,
      stopped ? "stopped" : "unresponsive",
      "page.goto(url, { timeout })",
    );
  }
  return new PageNavigationTimeoutError(
    `page.goto timed out after ${timeoutMs}ms waiting for ${waitUntil}${state}`,
    {
      committed,
      stopped,
      url: details.url,
      readyState: details.readyState,
      waitUntil,
      timeoutMs,
    },
  );
}

function navigationTimeoutNextStep(waitUntil: PageGotoWaitUntil): string {
  if (waitUntil === "commit") {
    return "Continue on this Page; the requested document has committed.";
  }
  if (waitUntil === "networkidle") {
    return 'Continue when the needed DOM state is observable, or call page.waitForLoadState("networkidle") if network quiescence is required.';
  }
  return `Continue on this Page; call page.waitForLoadState(${JSON.stringify(waitUntil)}) if that lifecycle state is still required.`;
}

async function currentDocumentState(
  services: PageWaitServices,
  sessionId: string,
): Promise<{ url?: string; readyState?: string }> {
  try {
    const response = await services.cdp(
      "Runtime.evaluate",
      {
        expression:
          "({ __egoNavigationState: true, url: location.href, readyState: document.readyState })",
        returnByValue: true,
        timeout: 200,
      },
      sessionId,
      250,
    );
    const value = response?.result?.value;
    if (!value || typeof value !== "object") return {};
    return {
      ...(typeof value.url === "string" ? { url: value.url } : {}),
      ...(typeof value.readyState === "string"
        ? { readyState: value.readyState }
        : {}),
    };
  } catch {
    // Diagnostics must not replace the navigation timeout.
    return {};
  }
}

function isLoadStateTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith("page.waitForLoadState(") &&
    error.message.includes(" timed out")
  );
}

/** Wait for document load or network idle inside one Page session. */
export async function waitForLoadStateInPage(
  services: PageWaitServices,
  sessionId: string,
  state: "domcontentloaded" | "load" | "networkidle",
  options: PageWaitForLoadStateOptions = {},
): Promise<void> {
  if (
    state !== "domcontentloaded" &&
    state !== "load" &&
    state !== "networkidle"
  ) {
    throw new TypeError(
      'page.waitForLoadState supports only "domcontentloaded", "load", and "networkidle"',
    );
  }
  const timeoutMs = options.timeout ?? 10_000;
  if (state !== "networkidle") {
    await waitForDocumentReadyState(services, sessionId, state, timeoutMs);
    return;
  }
  const idleMs = options.idleMs ?? 500;
  await waitForNetworkIdle(services, sessionId, timeoutMs, idleMs);
}

async function waitForDocumentReadyState(
  services: PageWaitServices,
  sessionId: string,
  state: "domcontentloaded" | "load",
  timeoutMs: number,
): Promise<void> {
  const expression =
    state === "domcontentloaded"
      ? `(() => {
          const navigation = performance.getEntriesByType("navigation")[0];
          const modernEnd = Number(navigation?.domContentLoadedEventEnd || 0);
          const legacyEnd = Number(performance.timing?.domContentLoadedEventEnd || 0);
          return {
            readyState: document.readyState,
            domContentLoaded:
              document.readyState === "complete" || modernEnd > 0 || legacyEnd > 0,
          };
        })()`
      : "document.readyState";
  const deadline = services.now() + timeoutMs;
  while (services.now() < deadline) {
    const remaining = Math.max(1, deadline - services.now());
    let response;
    try {
      response = await services.cdp(
        "Runtime.evaluate",
        { expression, returnByValue: true },
        sessionId,
        Math.min(1_000, remaining),
      );
    } catch (error) {
      // A document swap can briefly invalidate the execution context. Retry
      // those transitions and individual probe timeouts within the Page-level
      // wait budget instead of leaking a CDP implementation detail.
      if (
        !isRuntimeEvaluateTimeout(error) &&
        !isTransientNavigationContextError(error)
      ) {
        throw error;
      }
      if (services.now() >= deadline) break;
    }
    const value = response?.result?.value;
    if (state === "load" && value === "complete") return;
    if (state === "domcontentloaded" && value?.domContentLoaded === true)
      return;
    const waitMs = deadline - services.now();
    if (waitMs <= 0) break;
    await services.sleep(Math.min(100, waitMs));
  }
  throw new Error(
    `page.waitForLoadState(${state}) timed out after ${timeoutMs}ms`,
  );
}

function isRuntimeEvaluateTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("CDP request timed out: Runtime.evaluate")
  );
}

function isCdpTimeout(error: unknown, method: string): boolean {
  return (
    error instanceof Error &&
    error.message.includes(`CDP request timed out: ${method}`)
  );
}

function isTransientNavigationContextError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes("Execution context was destroyed") ||
    error.message.includes("Cannot find context with specified id") ||
    error.message.includes("Inspected target navigated")
  );
}

async function waitForNetworkIdle(
  services: PageWaitServices,
  sessionId: string,
  timeoutMs: number,
  idleMs: number,
): Promise<void> {
  const deadline = services.now() + timeoutMs;
  let sessionIds: string[] = [];
  let lastActivity: ReturnType<PageWaitServices["networkActivity"]> | undefined;
  while (services.now() <= deadline) {
    try {
      // OOPIFs can appear while the Page is loading. Refreshing before every
      // observation ensures a new child starts its own continuous tracker before
      // the top-level Page can be declared idle.
      const discoveryBudget = Math.max(1, deadline - services.now());
      sessionIds = await services.pageNetworkSessions(
        sessionId,
        discoveryBudget,
      );
      const trackingBudget = deadline - services.now();
      if (trackingBudget <= 0) break;
      await services.ensureNetworkTracking(sessionIds, trackingBudget);
      const activity = services.networkActivity(sessionIds);
      lastActivity = activity;
      if (
        activity.tracking &&
        activity.inflight === 0 &&
        services.now() - activity.lastActivityAt >= idleMs
      ) {
        return;
      }
    } catch (error) {
      if (!isRetryableNetworkRefreshError(error)) throw error;
      if (services.now() >= deadline) break;
    }
    const waitMs = deadline - services.now();
    if (waitMs <= 0) break;
    await services.sleep(Math.min(50, waitMs));
  }
  throw new Error(
    `page.waitForLoadState(networkidle) timed out after ${timeoutMs}ms` +
      describeNetworkActivity(lastActivity),
  );
}

function describeNetworkActivity(
  activity: ReturnType<PageWaitServices["networkActivity"]> | undefined,
): string {
  if (!activity) return "";
  if (!activity.tracking) return " (network tracking unavailable)";
  const pending = activity.pendingRequests || [];
  if (pending.length === 0) return "";
  const shown = pending.slice(0, 5).join(", ");
  const more = pending.length > 5 ? ` and ${pending.length - 5} more` : "";
  return ` (${pending.length} requests still in flight: ${shown}${more})`;
}

function isRetryableNetworkRefreshError(error: unknown): boolean {
  if (isCdpRequestTimeoutError(error) || isSessionLostError(error)) return true;
  return /CDP request timed out:|detached Page session/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

function cdpAdapter(services: PageWaitServices) {
  return {
    sendRaw(method, params, sessionId) {
      return services.cdp(method, params, sessionId);
    },
  };
}
