import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { agentIdentity } from "./agent-identity.mjs";
import { STATE_DIR, TASK_SPACE_FILE } from "./paths.mjs";

/**
 * Task spaces, emulated as tracked sets of tabs.
 *
 * The app's Space is isolated *and* inherits your login state. On stock Chromium
 * those two properties look like they pull apart:
 *
 *   Target.createBrowserContext -> real isolation, but a blank cookie jar
 *   sharing the default profile -> your real logins, but no isolation
 *
 * They don't: the empty jar can be filled. A space owns a browser context seeded
 * from the default jar at creation, so it gets both — see createSeededContext
 * below and docs/isolation-with-inherited-logins.md. The seed is a point-in-time
 * copy, not live shared state, and a space that fails to get a context falls
 * back to the shared default jar.
 *
 * Spaces deliberately do NOT get their own browser window. That was the first
 * design, and it was measurably worse: a headless Chrome does not render tabs in
 * background windows, so `document.elementFromPoint` returned null for pages
 * living in a non-foreground window. That broke hit-testing, which in turn made
 * the harness's input-fallback path re-synthesise drags that had already landed
 * (see driver/pointer.ts finishDragProbe) — every canvas case in the upstream
 * e2e suite failed or double-counted strokes. One window, tracked tab sets.
 *
 * Each heredoc is a fresh Node process, so state lives in a file, not memory.
 */

const EMPTY = { spaces: [], selectedId: null, nextId: 1, closedSpaces: [] };

/**
 * How many idle-closed spaces to remember.
 *
 * Enough that a session returning from a long break still finds its own, few
 * enough that the state file cannot grow without bound.
 */
const REMEMBERED_CLOSURES = 20;

export function createTaskSpacesApi(cdp) {
  /**
   * Which space *this process* is working in.
   *
   * selectedId lives in a file every concurrent session shares, and each heredoc
   * writes it on the way in. So a second agent starting up silently reassigns
   * the first one: from that moment the first agent scoped its tab list, its
   * navigations and its cursor to the *other* session's space. The observed
   * symptom is a tab navigating away to an unrelated site while the agent that
   * opened it is still working in it, and the other agent finding a stranger's
   * page where its own should be.
   *
   * Once this process has chosen a space it pins it here and stops consulting
   * the shared value. The file still records the global selection — the Spaces
   * overview reads it, and it is the right answer for a fresh process that has
   * not chosen yet — it simply no longer decides what an already-committed
   * process acts on.
   */
  let pinnedSpaceId = null;

  /** The pinned space if it still exists, else whatever the file last recorded. */
  function effectiveSelectedId(state) {
    if (
      pinnedSpaceId !== null &&
      state.spaces.some((space) => space.id === pinnedSpaceId)
    ) {
      return pinnedSpaceId;
    }
    return state.selectedId;
  }

  async function readState() {
    try {
      const parsed = JSON.parse(await readFile(TASK_SPACE_FILE, "utf8"));
      return { ...EMPTY, ...parsed };
    } catch {
      return { ...EMPTY };
    }
  }

  async function writeState(state) {
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(TASK_SPACE_FILE, JSON.stringify(state, null, 2));
  }

  async function livePageTargets() {
    const { targetInfos = [] } = await cdp.call("Target.getTargets");
    const live = new Map();
    for (const target of targetInfos) {
      if (target.type === "page" && !target.url.startsWith("devtools://")) {
        live.set(target.targetId, target);
      }
    }
    return live;
  }

  /**
   * Re-adopt a space's pages after the browser restarted.
   *
   * A space is identified by target ids, and those die with the browser. A
   * restart therefore wiped every space even though Chrome had restored the
   * very pages they described — the overview read "No spaces yet" next to a
   * window full of tabs. Remembered urls are what survive a restart, so they
   * are what the pages get matched back by.
   *
   * Only attempted when EVERY space lost EVERY tab at once, which is the
   * signature of a restart. Closing one space's tabs by hand leaves the others
   * alive, and must stay a deletion — otherwise a space would resurrect itself
   * from any other tab that happened to share its url.
   */
  function readoptRestoredPages(state, live) {
    if (state.spaces.length === 0) return false;
    if (
      state.spaces.some((space) => (space.targetIds || []).some((id) => live.has(id)))
    ) {
      return false;
    }

    const claimed = new Set();
    let changed = false;
    for (const space of state.spaces) {
      const wanted = new Set(space.urls || []);
      if (wanted.size === 0) continue;
      const matches = [...live.values()].filter(
        (target) => !claimed.has(target.targetId) && wanted.has(target.url),
      );
      if (matches.length === 0) continue;
      for (const target of matches) claimed.add(target.targetId);
      space.targetIds = matches.map((target) => target.targetId);
      // Browser contexts do not outlive the browser. The restored pages are in
      // the default jar, so the space is no longer isolated and must not keep
      // claiming a context id that now refers to nothing.
      if (space.browserContextId) space.browserContextId = null;
      space.restored = true;
      changed = true;
    }
    return changed;
  }

  /**
   * Close spaces that were opened and never used.
   *
   * A context-backed space cannot share a window with the default context, so
   * every space is its own window, and every space starts life as a single
   * about:blank tab. Anything that creates spaces in bulk — the e2e suite, a
   * crashed run, an agent that gave up — therefore leaves a drift of empty
   * windows across the desktop, which is what users actually notice.
   *
   * Only a space that is not selected, has *never* held a real page, holds
   * nothing but about:blank, and has had a grace period to receive its first
   * one is swept. "Never held a page" is the load-bearing condition: a tab is
   * momentarily about:blank on every navigation, so judging by the current url
   * alone would delete a working space mid-goto.
   */
  const ABANDONED_AFTER_MS = 120000;

  async function pruneAbandoned(state, live) {
    const doomed = state.spaces.filter((space) => {
      if (space.id === effectiveSelectedId(state)) return false;
      // Ever held a real page => not abandoned, only between pages.
      if (space.lastContentAt) return false;
      if (!space.createdAt || Date.now() - space.createdAt < ABANDONED_AFTER_MS) return false;
      const tabs = (space.targetIds || []).map((id) => live.get(id)).filter(Boolean);
      if (tabs.length === 0) return false;
      return tabs.every((target) => target.url === "about:blank");
    });
    if (doomed.length === 0) return false;

    for (const space of doomed) {
      for (const targetId of space.targetIds) {
        await cdp.call("Target.closeTarget", { targetId }).catch(() => {});
      }
      if (space.browserContextId) await disposeContext(space.browserContextId);
    }
    const gone = new Set(doomed.map((space) => space.id));
    state.spaces = state.spaces.filter((space) => !gone.has(space.id));
    return true;
  }

  /**
   * Close spaces nobody has come back to.
   *
   * A space outlives the process that opened it — every heredoc is a fresh Node
   * run — so nothing reaps one whose agent simply stopped returning. A session
   * that ends mid-task leaves its tabs open for good, and the count only climbs;
   * spaces from long-finished work were still holding pages days later.
   *
   * Idleness is measured from the last time something addressed the space, not
   * from when its page last changed: an agent reading one page for ten minutes
   * is working, and a space parked on a live dashboard is not. Live work keeps
   * itself alive by continuing, since every round touches the space it uses.
   *
   * The selected space is never swept — it is the one someone is on right now —
   * and EGO_LINUX_SPACE_IDLE_MIN=0 turns the sweep off for anyone who would
   * rather clean up by hand.
   */
  const IDLE_MINUTES = Number(process.env.EGO_LINUX_SPACE_IDLE_MIN ?? 30);
  const IDLE_AFTER_MS =
    Number.isFinite(IDLE_MINUTES) && IDLE_MINUTES > 0 ? IDLE_MINUTES * 60000 : 0;

  async function pruneIdle(state) {
    if (!IDLE_AFTER_MS) return false;
    const now = Date.now();
    // Stamping is itself a state change worth persisting: drop it and every run
    // would re-stamp from scratch, so nothing would ever reach the threshold.
    let stamped = false;
    const doomed = state.spaces.filter((space) => {
      if (space.id === effectiveSelectedId(state)) return false;
      // touchedAt only moves when an API call names the space, and nothing a
      // person does at the keyboard produces one. A space handed over for a
      // login or a captcha, or completed with keep: true — which exists purely
      // to say "leave this page open" — would therefore go idle while it is
      // being used, and get closed out from under them.
      if (
        space.ownership === "user" ||
        space.ownership === "agentDelegatedToUser"
      ) {
        return false;
      }
      // Spaces that predate this field have no idle history, and judging them
      // by createdAt would sweep every one of them the first time the feature
      // runs — including whatever a colleague session is halfway through. Stamp
      // them instead and let them earn a full idle window from here.
      if (!space.touchedAt) {
        space.touchedAt = now;
        stamped = true;
        return false;
      }
      return now - space.touchedAt >= IDLE_AFTER_MS;
    });
    if (doomed.length === 0) return stamped;

    for (const space of doomed) {
      for (const targetId of space.targetIds || []) {
        await cdp.call("Target.closeTarget", { targetId }).catch(() => {});
      }
      if (space.browserContextId) await disposeContext(space.browserContextId);
    }

    // Leave a trail. Without one, an agent coming back after a long break calls
    // useOrCreate with the same name, silently gets a brand-new empty space, and
    // carries on believing it resumed — the tabs it had open are simply gone and
    // nothing says so. A closed space that names itself and lists what it held
    // turns that into something the agent can put back.
    const closures = state.closedSpaces || [];
    for (const space of doomed) {
      closures.unshift({
        name: space.name,
        urls: (space.urls || []).filter((url) => url && url !== "about:blank"),
        closedAt: now,
        idleMinutes: Math.round((now - space.touchedAt) / 60000),
      });
    }
    state.closedSpaces = closures.slice(0, REMEMBERED_CLOSURES);

    const gone = new Set(doomed.map((space) => space.id));
    state.spaces = state.spaces.filter((space) => !gone.has(space.id));
    return true;
  }

  /** Drop tabs the user closed, and spaces left with none. */
  async function reconcile(state) {
    const live = await livePageTargets();
    let changed = false;

    for (const space of state.spaces) {
      const kept = (space.targetIds || []).filter((id) => live.has(id));
      if (kept.length !== (space.targetIds || []).length) {
        space.targetIds = kept;
        changed = true;
      }
      // Remembered while the pages are alive, so a restart has something to
      // match them back by.
      if (kept.length > 0) {
        const urls = kept.map((id) => live.get(id).url).filter(Boolean);
        // A space that has ever held a real page is never "opened and never
        // used", however blank it looks right now — a tab is momentarily
        // about:blank on every navigation.
        if (!space.lastContentAt && urls.some((url) => url !== "about:blank")) {
          space.lastContentAt = Date.now();
          changed = true;
        }
        if (urls.join("\n") !== (space.urls || []).join("\n")) {
          space.urls = urls;
          changed = true;
        }
      }
    }

    if (readoptRestoredPages(state, live)) changed = true;
    if (await pruneAbandoned(state, live)) changed = true;
    if (await pruneIdle(state)) changed = true;

    const surviving = state.spaces.filter((space) => space.targetIds.length > 0);
    if (surviving.length !== state.spaces.length) {
      // Losing its last tab is how a space ends when the user closes tabs by
      // hand, so its context has to go the same way closeTaskSpace disposes
      // one. Dropping the record alone would strand a live context holding a
      // full copy of the seeded cookie jar until the browser restarts.
      for (const space of state.spaces) {
        if (space.targetIds.length === 0 && space.browserContextId) {
          await disposeContext(space.browserContextId);
        }
      }
      state.spaces = surviving;
      changed = true;
    }
    if (!state.spaces.some((space) => space.id === state.selectedId)) {
      state.selectedId = null;
      changed = true;
    }
    if (changed) await writeState(state);
    return { state, live };
  }

  function decorate(space, live) {
    return {
      ...space,
      taskId: space.taskId ?? space.id,
      recentTabTitles: space.targetIds
        .map((id) => live.get(id)?.title || "")
        .filter(Boolean),
    };
  }

  /**
   * The harness selects a space with useTaskSpace() and then calls handOff /
   * takeOver / complete / close with NO arguments — they act on whatever is
   * currently selected (see helpers.ts:326-354). Only useTaskSpace, claim and
   * create are passed an id.
   */
  async function requireSpace(state, id, op) {
    const wanted =
      id === undefined || id === null ? effectiveSelectedId(state) : Number(id);
    const space = state.spaces.find((candidate) => candidate.id === wanted);
    if (!space) {
      throw new Error(
        id === undefined || id === null
          ? `${op}: no task space is selected`
          : `${op}: task space not found: ${id}`,
      );
    }
    // Every API call that names a space is a session saying it is still here.
    // That is what the idle sweep measures, and touching it in the one place
    // they all pass through is what keeps live work from being swept out from
    // under an agent that simply had a long think between rounds.
    space.touchedAt = Date.now();
    return space;
  }

  /** Bring the space's own tab to the front, so the agent lands back on it. */
  async function focusSpace(space) {
    const live = await livePageTargets();
    const targetId = space.targetIds.find((id) => live.has(id));
    if (targetId) {
      await cdp.call("Target.activateTarget", { targetId }).catch(() => {});
    }
  }

  /**
   * Give a space its own cookie jar, pre-filled with the user's.
   *
   * Target.createBrowserContext isolates for real, but starts empty — which on
   * its own would log the agent out of everything, so this port used to take a
   * bare window instead and accept a shared jar. Seeding the new context from
   * the default jar gets both properties at once: measurements and the two
   * reproducible experiments are in docs/isolation-with-inherited-logins.md.
   *
   * These calls carry no sessionId, so the transport sends them at the browser
   * level, which is where browserContextId is accepted.
   *
   * Returns null if the browser refuses a context, so a space degrades to the
   * previous window-only behaviour rather than failing to open at all.
   */
  /**
   * The selected space's context id, read synchronously.
   *
   * Sync because its only caller is the transport rewriting an outgoing payload
   * on its way to the socket, which has nowhere to await. The state file is a
   * few hundred bytes and the rewrite only fires on Browser.setDownloadBehavior,
   * so this is not on any hot path.
   */
  function selectedContextId() {
    try {
      const state = JSON.parse(readFileSync(TASK_SPACE_FILE, "utf8"));
      const wanted = effectiveSelectedId({ ...state, spaces: state.spaces ?? [] });
      const space = state.spaces?.find((candidate) => candidate.id === wanted);
      return space?.browserContextId ?? null;
    } catch {
      return null;
    }
  }

  /** The space's own still-blank tab, if it has exactly that and nothing else. */
  async function blankAnchor(space) {
    const ids = space.targetIds || [];
    if (ids.length !== 1) return null;
    const live = await livePageTargets().catch(() => new Map());
    const target = live.get(ids[0]);
    return target && target.url === "about:blank" ? target.targetId : null;
  }

  async function disposeContext(browserContextId) {
    await cdp
      .call("Target.disposeBrowserContext", { browserContextId })
      .catch(() => {});
  }

  async function createSeededContext() {
    let browserContextId;
    try {
      ({ browserContextId } = await cdp.call("Target.createBrowserContext", {}));
    } catch {
      return null;
    }
    if (!browserContextId) return null;
    try {
      const { cookies } = await cdp.call("Storage.getCookies", {});
      if (cookies?.length) {
        await cdp.call("Storage.setCookies", { browserContextId, cookies });
      }
    } catch {
      // An unseeded context is still a usable space, just a logged-out one.
    }
    return browserContextId;
  }

  return {
    selectedContextId,

    /**
     * Remember that the selected space received a real page.
     *
     * This is what keeps a working space out of the abandoned sweep: its tab is
     * about:blank again on every navigation, so the current url can never tell
     * "never used" apart from "between pages". Recorded once, never cleared.
     */
    async noteContent() {
      const state = await readState();
      const space = state.spaces.find(
        (candidate) => candidate.id === effectiveSelectedId(state),
      );
      if (!space || space.lastContentAt) return;
      space.lastContentAt = Date.now();
      await writeState(state);
    },

    async listTaskSpaces() {
      const { state, live } = await reconcile(await readState());
      return { taskSpaces: state.spaces.map((space) => decorate(space, live)) };
    },

    async createTaskSpace(name) {
      const state = await readState();
      const browserContextId = await createSeededContext();
      let targetId;
      try {
        ({ targetId } = await cdp.call("Target.createTarget", {
          url: "about:blank",
          ...(browserContextId ? { browserContextId } : {}),
        }));
      } catch (err) {
        // Nothing will ever reference this context if the space fails to open.
        if (browserContextId) await disposeContext(browserContextId);
        throw err;
      }
      await cdp.call("Target.activateTarget", { targetId }).catch(() => {});

      const space = {
        id: state.nextId,
        taskId: state.nextId,
        name: String(name ?? `task ${state.nextId}`),
        createdAt: Date.now(),
        touchedAt: Date.now(),
        ownership: "agent",
        createdBy: "agent",
        // Which agent profile opened it — the overview's right-hand label.
        ...agentIdentity(),
        browserContextId,
        targetIds: [targetId],
      };
      state.spaces.push(space);
      state.nextId += 1;
      state.selectedId = space.id;
      pinnedSpaceId = space.id;

      // useOrCreate lands here whenever it cannot find the name it was given —
      // including when the idle sweep closed that very space while its agent was
      // away. Handing back what the old one held is the difference between
      // "resumed" and "started over without noticing". Consumed on use, so it is
      // reported once rather than on every later run of the same name.
      const closures = state.closedSpaces || [];
      const index = closures.findIndex((entry) => entry.name === space.name);
      if (index !== -1) {
        const [previous] = closures.splice(index, 1);
        state.closedSpaces = closures;
        space.previously = {
          closedAt: previous.closedAt,
          idleMinutes: previous.idleMinutes,
          urls: previous.urls,
          note:
            `a task space named ${JSON.stringify(space.name)} was closed after ` +
            `${previous.idleMinutes} minutes idle; this is a new, empty one. ` +
            (previous.urls.length
              ? `It had these pages open: ${previous.urls.join(", ")}`
              : "It had no pages open."),
        };
      }

      await writeState(state);
      return space;
    },

    async useTaskSpace(id) {
      const state = await readState();
      const space = await requireSpace(state, id, "useTaskSpace");
      state.selectedId = space.id;
      pinnedSpaceId = space.id;
      await writeState(state);
      await focusSpace(space);
      return { done: true };
    },

    async claimTaskSpace(id) {
      const state = await readState();
      const space = await requireSpace(state, id, "claimTaskSpace");
      space.ownership = "agent";
      state.selectedId = space.id;
      pinnedSpaceId = space.id;
      await writeState(state);
      await focusSpace(space);
      return space;
    },

    async handOffTaskSpace(id) {
      const state = await readState();
      const space = await requireSpace(state, id, "handOffTaskSpace");
      space.ownership = "agentDelegatedToUser";
      await writeState(state);
      return { done: true };
    },

    async takeOverTaskSpace(id) {
      const state = await readState();
      const space = await requireSpace(state, id, "takeOverTaskSpace");
      space.ownership = "agent";
      state.selectedId = space.id;
      pinnedSpaceId = space.id;
      await writeState(state);
      await focusSpace(space);
      return { done: true };
    },

    // Only the `keep: true` path reaches here; the harness routes `keep: false`
    // to closeTaskSpace instead (helpers.ts:299-315).
    async completeTaskSpace(id) {
      const state = await readState();
      const space = await requireSpace(state, id, "completeTaskSpace");
      space.ownership = "user";
      await writeState(state);
      return { done: true };
    },

    async closeTaskSpace(id) {
      const state = await readState();
      const space = await requireSpace(state, id, "closeTaskSpace");
      for (const targetId of space.targetIds) {
        await cdp.call("Target.closeTarget", { targetId }).catch(() => {});
      }
      if (space.browserContextId) {
        // Also drops the space's cookie jar, which is the point of having one.
        await disposeContext(space.browserContextId);
      }
      state.spaces = state.spaces.filter((candidate) => candidate.id !== space.id);
      if (state.selectedId === space.id) state.selectedId = null;
      if (pinnedSpaceId === space.id) pinnedSpaceId = null;
      await writeState(state);
      return { done: true };
    },

    /**
     * Open a tab and attribute it to the selected space, so completing that
     * space closes the tabs it opened. Membership is tracked by the ids we
     * create rather than inferred from which window a tab landed in, which CDP
     * gives no way to control (Target.createTarget takes no window id). For a
     * space with a context the browser also enforces membership, but the id
     * list stays authoritative so context-less spaces behave identically.
     */
    /**
     * What listTabs() should show: the selected space's tabs.
     *
     * A browser context identifies membership exactly, so it is preferred. The
     * tracked target ids cover spaces that have no context — the fallback path,
     * and spaces re-adopted after a restart, whose context died with the
     * browser.
     */
    async selectedScope() {
      const state = await readState();
      if (!effectiveSelectedId(state)) return null;
      const space = state.spaces.find(
        (candidate) => candidate.id === effectiveSelectedId(state),
      );
      if (!space) return null;
      return {
        browserContextId: space.browserContextId || null,
        targetIds: new Set(space.targetIds || []),
      };
    },

    async createTabInSelectedSpace(tabs, url) {
      const state = await readState();
      const space = state.spaces.find(
        (candidate) => candidate.id === effectiveSelectedId(state),
      );
      // A space is anchored by a tab — one with none is reaped as soon as it is
      // reconciled — so it opens on about:blank before it has anywhere to go.
      // Creating a second tab for the first navigation strands that anchor, and
      // the window then shows a blank tab beside the real page for the rest of
      // the session. Navigating the anchor is what it was opened for.
      //
      // Guarded on lastContentAt rather than on the tab's current url: a tab is
      // about:blank for a moment during every navigation, so matching on the url
      // alone would hijack a tab that is already carrying work. "Never held a
      // page" is only true of a space that has not started yet.
      const anchor = space && !space.lastContentAt ? await blankAnchor(space) : null;
      if (anchor && url && url !== "about:blank") {
        const { sessionId } = await cdp.call("Target.attachToTarget", {
          targetId: anchor,
          flatten: true,
        });
        await cdp.call("Page.navigate", { url }, sessionId);
        await cdp.call("Target.activateTarget", { targetId: anchor }).catch(() => {});
        return { targetId: anchor };
      }

      // Open it inside the space's context, so every tab of a space shares that
      // space's jar rather than the first tab being isolated and the rest not.
      let result;
      try {
        result = await tabs.createTab(url, space?.browserContextId);
      } catch (error) {
        // Browser contexts die with the browser, but the selected space's id
        // outlives it in the state file. Chrome then rejects the create with
        // "Failed to find browser context", which used to leave the port unable
        // to open any tab at all after a restart. Fall back to the default jar
        // and forget the dead id — the space stops being isolated, which is
        // already true, rather than stopping working.
        if (!space?.browserContextId || !/browser context/i.test(String(error?.message))) {
          throw error;
        }
        space.browserContextId = null;
        space.restored = true;
        result = await tabs.createTab(url);
      }
      if (space && result.targetId) {
        space.targetIds.push(result.targetId);
        await writeState(state);
      }
      return result;
    },
  };
}
