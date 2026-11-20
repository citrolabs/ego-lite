export function eventIsolationCase() {
  return `
    await useOrCreateTaskSpace(taskName);
    const pulseTab = await resetHome();
    let staticTab = null;

    try {
      await cdp("Network.enable");
      await js(
        "window.__eventIsolationPulse = setInterval(() => " +
          "fetch('/api/slow?ms=2000&pulse=' + Date.now()).catch(() => {}), 50); true"
      );
      await wait(0.4);

      staticTab = await openOrReuseTab(
        baseUrl + "/secondary?event-isolation=" + Date.now(),
        { wait: true, timeout: 10 }
      );
      const startedAt = Date.now();
      const idle = await waitForNetworkIdle({ timeout: 1.2, idleMs: 300 });

      assertEqual(
        idle,
        true,
        "background target traffic must not keep the static target busy"
      );
      assert(
        Date.now() - startedAt < 1000,
        "static target should reach network idle without waiting for the timeout"
      );
    } finally {
      await switchTab(pulseTab.targetId).catch(() => {});
      await js("clearInterval(window.__eventIsolationPulse); true").catch(() => {});
      if (staticTab?.targetId) await closeTab(staticTab.targetId).catch(() => {});
      await closeTab(pulseTab.targetId).catch(() => {});
    }
  `;
}
