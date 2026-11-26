/**
 * CITRO-3535: when native input times out, click() falls back to synthetic
 * events. That fallback used to send only mousedown, mouseup, and click, so a
 * Radix-style menu trigger, which opens on pointerdown, stayed closed while
 * click() reported success. The fixture stalls the page on the trusted
 * pointermove past the input dispatch timeout to force the fallback.
 */
export function pointerFallbackCase() {
  return `
    await useOrCreateTaskSpace(taskName);
    const loaded = await gotoAndWait(baseUrl + "/pointer-fallback-popover", { timeout: 10 });
    assert(loaded.loaded, "pointer fallback fixture loaded");

    // Start the pointer away from the trigger so the click moves onto it.
    await hover("#elsewhere");
    await js("window.__pointerFallback.events = []; window.__stallNextTrustedMove = true; return true;");
    await click("#trigger");

    const result = await js("return { state: document.querySelector('#menu').dataset.state, ...window.__pointerFallback }");
    cliLog(JSON.stringify({ pointerFallback: result }));
    assertEqual(
      await js("return window.__stallNextTrustedMove"),
      false,
      "the stall fired on the trusted pointermove"
    );
    assert(
      result.events.length > 0 && result.events.every((event) => !event.trusted),
      "the trigger received only the synthetic fallback sequence"
    );
    assertEqual(
      result.events.map((event) => event.type).join(),
      "pointerdown,pointerup,click",
      "the canceled pointerdown suppresses mousedown and mouseup, and click still fires"
    );
    assertEqual(
      result.events[0].pointerType,
      "mouse",
      "the fallback pointerdown is a mouse pointer event"
    );
    assertEqual(result.state, "open", "the fallback click opens the pointerdown-driven menu");
    assertEqual(result.opened, 1, "the menu opened exactly once");
    assertEqual(
      await js("return document.querySelector('#trigger').getAttribute('aria-expanded')"),
      "true",
      "the trigger reports the menu as expanded"
    );
  `;
}
