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

export function createTabsApi(cdp, { port, getScope }) {
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
      let pages = targetInfos.filter(
        (target) => target.type === "page" && !target.url.startsWith("devtools://"),
      );

      // Scoped to the selected space, the way the native app lists only the
      // selected Space's tabs.
      //
      // This was dropped once, for good reason: membership used to be inferred
      // from which window a tab landed in, and Target.createTarget takes no
      // window id — so every heuristic either hid a tab the harness still held
      // ("switchTab: target not found") or leaked one space's tabs into
      // another's list. Browser-context-backed spaces removed the guesswork:
      // Target.getTargets reports each target's browserContextId, and a tab
      // opened for a space is created in that context, so membership is now a
      // fact rather than an inference.
      //
      // Spaces without a context — the fallback path, and spaces re-adopted
      // after a restart — fall back to the tracked target ids, which are exact
      // for tabs the shim opened.
      const scope = getScope ? await getScope() : null;
      if (scope) {
        const scoped = pages.filter((target) =>
          scope.browserContextId
            ? target.browserContextId === scope.browserContextId
            : scope.targetIds.has(target.targetId),
        );
        // Never hand back an empty list: a space mid-navigation, or one whose
        // only tab the user just closed, must not look like a browser with no
        // tabs at all.
        if (scoped.length > 0) pages = scoped;
      }

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

    // browserContextId places the tab in a task space's own cookie jar; without
    // one the tab lands in the default context, which is the pre-context
    // behaviour and still correct for spaces that have no context.
    async createTab(url = "about:blank", browserContextId = undefined) {
      const { targetId } = await cdp.call("Target.createTarget", {
        url,
        ...(browserContextId ? { browserContextId } : {}),
      });
      if (!targetId) throw new Error("Target.createTarget returned no targetId");
      // Make it the active tab, matching the native behaviour where a freshly
      // created tab is the one the agent goes on to act on.
      await cdp.call("Target.activateTarget", { targetId }).catch(() => {});
      return { targetId };
    },
  };
}
