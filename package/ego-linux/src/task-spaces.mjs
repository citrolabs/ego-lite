import { mkdir, readFile, writeFile } from "node:fs/promises";

import { STATE_DIR, TASK_SPACE_FILE } from "./paths.mjs";

/**
 * Task spaces, emulated as tracked sets of tabs.
 *
 * FIDELITY NOTE — this is the one part of the native surface that cannot be
 * reproduced faithfully. The app's Space is isolated *and* inherits your login
 * state. On stock Chromium those two pull apart:
 *
 *   Target.createBrowserContext -> real isolation, but a blank cookie jar
 *   sharing the default profile -> your real logins, but no isolation
 *
 * Login inheritance wins, because that is what agent tasks actually depend on.
 * A space therefore owns its tabs and its ownership state, but shares one cookie
 * jar with every other space.
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

const EMPTY = { spaces: [], selectedId: null, nextId: 1 };

export function createTaskSpacesApi(cdp) {
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
    }
    const surviving = state.spaces.filter((space) => space.targetIds.length > 0);
    if (surviving.length !== state.spaces.length) {
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
    const wanted = id === undefined || id === null ? state.selectedId : Number(id);
    const space = state.spaces.find((candidate) => candidate.id === wanted);
    if (!space) {
      throw new Error(
        id === undefined || id === null
          ? `${op}: no task space is selected`
          : `${op}: task space not found: ${id}`,
      );
    }
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

  return {
    async listTaskSpaces() {
      const { state, live } = await reconcile(await readState());
      return { taskSpaces: state.spaces.map((space) => decorate(space, live)) };
    },

    async createTaskSpace(name) {
      const state = await readState();
      const { targetId } = await cdp.call("Target.createTarget", {
        url: "about:blank",
      });
      await cdp.call("Target.activateTarget", { targetId }).catch(() => {});

      const space = {
        id: state.nextId,
        taskId: state.nextId,
        name: String(name ?? `task ${state.nextId}`),
        ownership: "agent",
        createdBy: "agent",
        targetIds: [targetId],
      };
      state.spaces.push(space);
      state.nextId += 1;
      state.selectedId = space.id;
      await writeState(state);
      return space;
    },

    async useTaskSpace(id) {
      const state = await readState();
      const space = await requireSpace(state, id, "useTaskSpace");
      state.selectedId = space.id;
      await writeState(state);
      await focusSpace(space);
      return { done: true };
    },

    async claimTaskSpace(id) {
      const state = await readState();
      const space = await requireSpace(state, id, "claimTaskSpace");
      space.ownership = "agent";
      state.selectedId = space.id;
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
      state.spaces = state.spaces.filter((candidate) => candidate.id !== space.id);
      if (state.selectedId === space.id) state.selectedId = null;
      await writeState(state);
      return { done: true };
    },

    async setAgentTaskState(...args) {
      // The native app drives its Space overlay from this; nothing to render here.
      void args;
      return { done: true };
    },

    /**
     * Open a tab and attribute it to the selected space, so completing that
     * space closes the tabs it opened. Tracking the ids we create is exact —
     * unlike inferring membership from which window a tab landed in, which CDP
     * gives no way to control (Target.createTarget takes no window id).
     */
    async createTabInSelectedSpace(tabs, url) {
      const result = await tabs.createTab(url);
      const state = await readState();
      const space = state.spaces.find((candidate) => candidate.id === state.selectedId);
      if (space && result.targetId) {
        space.targetIds.push(result.targetId);
        await writeState(state);
      }
      return result;
    },
  };
}
