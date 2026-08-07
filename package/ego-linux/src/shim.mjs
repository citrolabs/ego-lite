import { ensureBrowser } from "./chrome.mjs";
import { connectCdp } from "./transport.mjs";
import { createTabsApi } from "./tabs.mjs";
import { createSnapshotApi } from "./snapshot.mjs";
import { createTaskSpacesApi } from "./task-spaces.mjs";
import { createCursorApi } from "./cursor.mjs";
import { createWindowFit } from "./window-fit.mjs";

/**
 * Build the `globalThis.ego` object the ego-browser harness expects, backed by a
 * plain Chromium over CDP instead of the macOS-only ego lite app.
 *
 * The full native surface the harness uses is 15 methods plus 2 callbacks; every
 * one of them is implemented or explicitly degraded here. See README.md for the
 * per-method fidelity table.
 */
export async function createEgoShim({ headless = false } = {}) {
  const { wsUrl, port } = await ensureBrowser({ headless });
  const cdp = await connectCdp(wsUrl);

  const taskSpaces = createTaskSpacesApi(cdp);
  // Downloads are armed per browser context, and a space owns one — so the
  // harness's context-less setDownloadBehavior has to be aimed at the space the
  // agent is actually in. See aimDownloadsAtCurrentSpace in transport.mjs.
  cdp.setDownloadContext(() => taskSpaces.selectedContextId());
  const tabs = createTabsApi(cdp, {
    port,
    getScope: () => taskSpaces.selectedScope(),
  });
  const snapshot = createSnapshotApi(cdp, { listTabs: tabs.listTabs });
  const cursor = createCursorApi(cdp, { listTabs: tabs.listTabs });

  // Every pointer event the harness sends moves the overlay, and a press ripples
  // where it landed — so a user watching the window sees the agent work.
  cdp.watchMouse((params) => {
    // A wheel does not move the pointer, and page.wheel() defaults its
    // coordinates to (0, 0) — following those would snap the cursor into the
    // corner on every scroll.
    if (params.type === "mouseWheel") return;
    if (params.type === "mousePressed") cursor.press(params.x, params.y);
    else if (params.type === "mouseReleased") cursor.release(params.x, params.y);
    else cursor.moveTo(params.x, params.y);
  });

  // Typing is the one action with nothing to watch: fill() dispatches no pointer
  // event at all, so without this a whole form fills itself with no explanation.
  cdp.watchKeys(() => cursor.typed());

  // A space that has ever loaded a real page is never "opened and never used",
  // however blank its tab looks between navigations.
  // A phone-width emulation in a desktop-width window shows a strip of site
  // beside a band of empty chrome; the window follows the viewport instead.
  const windowFit = createWindowFit(cdp);
  cdp.watchViewport((metrics) => {
    void windowFit.follow(metrics, cdp.attachedHint()).catch(() => {});
  });

  cdp.watchNavigation(() => {
    void taskSpaces.noteContent().catch(() => {});
    // A navigation destroys the overlay with the document it lives in. This is
    // the earliest point the shim hears about one, and arming here is what lets
    // the cursor come back on the load that follows.
    void cursor.watchPage().catch(() => {});
  });

  const ego = {
    // --- CDP transport: exact passthrough -----------------------------------
    sendCDPMessage: (payload) => cdp.sendRaw(payload),
    onCDPMessage: null,
    onSendCDPMessageError: null,

    // --- Tabs ---------------------------------------------------------------
    listTabs: tabs.listTabs,
    createTab: (url) => taskSpaces.createTabInSelectedSpace(tabs, url),

    // --- Observation --------------------------------------------------------
    // Reading is most of what an agent does, and none of it dispatches pointer
    // events — so a session that only opened pages and snapshotted them drew no
    // cursor at all, and looked idle. Showing the read is what makes the window
    // legible while the agent is thinking rather than clicking.
    // The label is deliberately left up afterwards: a snapshot returns in
    // milliseconds, so clearing it on completion made "reading" flash for less
    // than a frame. moveTo and pulseAt take it down when real input arrives.
    async snapshot(options) {
      cursor.reading();
      return snapshot.snapshot(options);
    },

    // --- Task spaces --------------------------------------------------------
    listTaskSpaces: taskSpaces.listTaskSpaces,
    // Arming on Page.navigate is too late for that same navigation — the claim
    // and Page.enable race the load and usually lose. Selecting a space is the
    // first moment a tab is guaranteed to exist, and it always precedes the
    // goto, so this is where a process's very first load gets covered.
    async createTaskSpace(name) {
      const result = await taskSpaces.createTaskSpace(name);
      void cursor.watchPage().catch(() => {});
      return result;
    },
    async useTaskSpace(id) {
      const result = await taskSpaces.useTaskSpace(id);
      void cursor.watchPage().catch(() => {});
      return result;
    },
    claimTaskSpace: taskSpaces.claimTaskSpace,
    // Handing a space back to the user drops the agent overlay, and taking it
    // over brings it back — the same signal the native app's Space overlay gives.
    async handOffTaskSpace(id) {
      const result = await taskSpaces.handOffTaskSpace(id);
      cursor.hide();
      return result;
    },
    async takeOverTaskSpace(id) {
      const result = await taskSpaces.takeOverTaskSpace(id);
      cursor.show();
      return result;
    },
    completeTaskSpace: taskSpaces.completeTaskSpace,
    closeTaskSpace: taskSpaces.closeTaskSpace,

    // --- The agent's cursor -------------------------------------------------
    animationHighlightMouseToPosition: (x, y) => cursor.moveTo(x, y),
    setAgentTaskState: (taskState) => cursor.setTaskState(taskState),

    // Not upstream surface: a Linux-port extension an agent calls directly to
    // show a human what it is talking about. `ego` is a global in the heredoc,
    // so this reads as `await ego.highlight("free shipping")`.
    highlight: (target, options) => cursor.highlight(target, options),
    clearHighlight: () => cursor.clearHighlight(),

    // --- App-lifecycle: no-ops on Linux -------------------------------------
    async getBrowserVersion() {
      const version = await cdp.call("Browser.getVersion");
      return { version: version.product, revision: version.revision, linuxPort: true };
    },
    async upgradeBrowser() {
      // The Linux port has no bundled app to upgrade; the user's Chrome updates
      // itself. Reporting "done" keeps the harness's upgrade path a no-op.
      return { done: false, reason: "not applicable on the Linux port" };
    },
  };

  cdp.bind(ego);
  return { ego, cdp, close: () => cdp.close(), port, wsUrl };
}
