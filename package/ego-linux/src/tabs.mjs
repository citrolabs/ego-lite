/**
 * Tab surface: ego.listTabs() and ego.createTab(url).
 *
 * Contract (package/ego-browser/src/driver/nav.ts):
 *   listTabs()    -> { tabs: [{ targetId, title, url, active, index }] }
 *   createTab(url)-> { targetId }
 *
 * `active` matters more than it looks: ensureSession() attaches its CDP session
 * to `tabs.find(t => t.active)`, so getting it wrong points every helper at the
 * wrong page. CDP has no "which tab is focused" query, so the DevTools HTTP
 * endpoint is used instead — it lists targets most-recently-used first, which
 * also tracks tabs the user switches to by hand.
 */

export function createTabsApi(cdp, { port }) {
  async function mruOrder() {
    if (!port) return null;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) return null;
      const list = await response.json();
      return list.filter((entry) => entry.type === "page").map((entry) => entry.id);
    } catch {
      return null;
    }
  }

  return {
    async listTabs() {
      const { targetInfos = [] } = await cdp.call("Target.getTargets");
      // NOT scoped to the selected task space. The native app lists only the
      // selected Space's tabs; that cannot be reproduced faithfully here,
      // because Target.createTarget takes no windowId — a tab opened for a
      // space can land in another window, and the space->tab mapping drifts.
      // Every heuristic tried (MRU order, "the tab the harness is attached to",
      // "the tab we just created") either hid a tab the harness still held, so
      // switchTab failed with "target not found", or leaked one space's tabs
      // into another's list. Listing every page tab is the honest, stable
      // behaviour. See README.md.
      const pages = targetInfos.filter(
        (target) => target.type === "page" && !target.url.startsWith("devtools://"),
      );

      const order = await mruOrder();
      if (order) {
        const rank = new Map(order.map((id, index) => [id, index]));
        pages.sort(
          (a, b) =>
            (rank.get(a.targetId) ?? Number.MAX_SAFE_INTEGER) -
            (rank.get(b.targetId) ?? Number.MAX_SAFE_INTEGER),
        );
      }

      // An explicit activation by the harness (switchTab, openOrReuseTab) beats
      // the endpoint's MRU guess, which does not always reflect a programmatic
      // Target.activateTarget — especially headless.
      const hinted = cdp.activeHint?.();
      const activeId =
        hinted && pages.some((target) => target.targetId === hinted)
          ? hinted
          : pages[0]?.targetId;
      return {
        tabs: pages.map((target, index) => ({
          targetId: target.targetId,
          title: target.title || "",
          url: target.url || "",
          active: target.targetId === activeId,
          index,
        })),
      };
    },

    async createTab(url = "about:blank") {
      const { targetId } = await cdp.call("Target.createTarget", { url });
      if (!targetId) throw new Error("Target.createTarget returned no targetId");
      // Make it the active tab, matching the native behaviour where a freshly
      // created tab is the one the agent goes on to act on.
      await cdp.call("Target.activateTarget", { targetId }).catch(() => {});
      return { targetId };
    },
  };
}
