/**
 * Which page the shim's own CDP calls should act on.
 *
 * The harness picks its own target (state.preferredTargetId, then the active
 * tab) and attaches a session to it. That choice is invisible from here, so the
 * transport records the target of the harness's Target.attachToTarget calls.
 * Using it keeps every shim-side read and overlay on the page the harness is
 * driving — computing "the active tab" independently lets the two drift, which
 * reads as an empty snapshot, or as a cursor drawn on the wrong tab.
 *
 * The resolver caches its session per target, so a run of calls on one page
 * costs a single attach.
 */
export function createSessionResolver(cdp, { listTabs, op }) {
  let session = { targetId: null, sessionId: null };

  return async function sessionForActiveTab() {
    let targetId = cdp.attachedHint?.();

    if (!targetId) {
      const { tabs } = await listTabs();
      const active = tabs.find((tab) => tab.active) || tabs[tabs.length - 1];
      if (!active) throw new Error(`${op}: no page tab to attach to`);
      targetId = active.targetId;
    }

    if (session.targetId === targetId && session.sessionId) {
      return session.sessionId;
    }
    const { sessionId } = await cdp.call("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    session = { targetId, sessionId };
    return sessionId;
  };
}
