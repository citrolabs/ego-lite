import { ensureBrowser } from "./chrome.mjs";
import { connectCdp } from "./transport.mjs";
import { createTabsApi } from "./tabs.mjs";
import { createSnapshotApi } from "./snapshot.mjs";
import { createTaskSpacesApi } from "./task-spaces.mjs";

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
  const tabs = createTabsApi(cdp, { port });
  const snapshot = createSnapshotApi(cdp, { listTabs: tabs.listTabs });

  const ego = {
    // --- CDP transport: exact passthrough -----------------------------------
    sendCDPMessage: (payload) => cdp.sendRaw(payload),
    onCDPMessage: null,
    onSendCDPMessageError: null,

    // --- Tabs ---------------------------------------------------------------
    listTabs: tabs.listTabs,
    createTab: (url) => taskSpaces.createTabInSelectedSpace(tabs, url),

    // --- Observation --------------------------------------------------------
    snapshot: snapshot.snapshot,

    // --- Task spaces --------------------------------------------------------
    listTaskSpaces: taskSpaces.listTaskSpaces,
    createTaskSpace: taskSpaces.createTaskSpace,
    useTaskSpace: taskSpaces.useTaskSpace,
    claimTaskSpace: taskSpaces.claimTaskSpace,
    handOffTaskSpace: taskSpaces.handOffTaskSpace,
    takeOverTaskSpace: taskSpaces.takeOverTaskSpace,
    completeTaskSpace: taskSpaces.completeTaskSpace,
    closeTaskSpace: taskSpaces.closeTaskSpace,
    setAgentTaskState: taskSpaces.setAgentTaskState,

    // --- Cosmetic / app-lifecycle: no-ops on Linux --------------------------
    async getBrowserVersion() {
      const version = await cdp.call("Browser.getVersion");
      return { version: version.product, revision: version.revision, linuxPort: true };
    },
    async upgradeBrowser() {
      // The Linux port has no bundled app to upgrade; the user's Chrome updates
      // itself. Reporting "done" keeps the harness's upgrade path a no-op.
      return { done: false, reason: "not applicable on the Linux port" };
    },
    async animationHighlightMouseToPosition() {
      // Purely a visual flourish in the native app.
      return { done: true };
    },
  };

  cdp.bind(ego);
  return { ego, close: () => cdp.close(), port, wsUrl };
}
