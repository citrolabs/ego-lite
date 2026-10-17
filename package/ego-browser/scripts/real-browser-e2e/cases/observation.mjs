export function observationCase() {
  return `
    await switchTaskSpace(taskName);
    await resetHome();

    const raw = await snapshotRaw({ includeStableLocator: true });
    assertIncludes(raw.content || "", "Helper e2e fixture", "snapshotRaw contains fixture content");

    const compactRaw = await snapshotRaw({
      scope: "only_within_viewport",
      includeActionMarks: false,
      includeStableLocator: false,
    });
    assertIncludes(compactRaw.content || "", "Helper e2e fixture", "snapshotRaw accepts compact options");

    const snap = await snapshot({
      scope: "full_page",
      includeActionMarks: true,
      includeStableLocator: true,
    });
    assertIncludes(snap.content || "", "Click counter", "snapshot contains button text");
    assert(Array.isArray(snap.refs), "snapshot returns refs array");

    const button = (snap.refs || []).find(
      (ref) =>
        String(ref?.role || "") === "button" &&
        (String(ref?.name || "").includes("Increment counter") ||
          String(ref?.name || "").includes("Click counter"))
    );
    const buttonRef = button?.refId ?? button?.backendNodeId;
    assert(buttonRef, "snapshot exposes a reusable printed ref for the button");
    const atRefCenter = await elementCenter("@" + buttonRef);
    assert(Number.isFinite(atRefCenter.x) && Number.isFinite(atRefCenter.y), "@ref resolves to coordinates");
    const namedRefCenter = await elementCenter("ref=" + buttonRef);
    assert(Number.isFinite(namedRefCenter.x) && Number.isFinite(namedRefCenter.y), "ref= resolves to coordinates");

    const text = await snapshotText({ scope: "full_page" });
    assertIncludes(text, "Text input", "snapshotText returns text content");

    const viewportText = await snapshotText({ scope: "only_within_viewport" });
    assertIncludes(viewportText, "Helper e2e fixture", "snapshotText supports viewport scope");

    const center = await elementCenter("#click-button");
    assert(Number.isFinite(center.x) && Number.isFinite(center.y), "elementCenter returns coordinates");

    const locatorCenter = await elementCenter("loc=css:#click-button");
    assert(Number.isFinite(locatorCenter.x) && Number.isFinite(locatorCenter.y), "elementCenter resolves loc=css");

    const hrefCenter = await elementCenter("loc=href:/nav-target");
    assert(Number.isFinite(hrefCenter.x) && Number.isFinite(hrefCenter.y), "elementCenter resolves loc=href");

    const xpathCenter = await elementCenter("xpath=//*[@id='click-button']");
    assert(Number.isFinite(xpathCenter.x) && Number.isFinite(xpathCenter.y), "elementCenter resolves xpath");

    await assertRejects(
      () => elementCenter("loc=css:.duplicate-action"),
      "matched 2",
      "elementCenter reports duplicate css locators"
    );
    await assertRejects(
      () => elementCenter("loc=role:button[name='Duplicate action']"),
      "matched 2",
      "elementCenter reports duplicate role locators"
    );
    await assertRejects(
      () => elementCenter("loc=href:/missing-link"),
      "matched 0",
      "elementCenter reports missing href locators"
    );
    await assertRejects(
      () => elementCenter("@999999"),
      "Unknown ref",
      "elementCenter reports unknown refs"
    );
    await assertRejects(
      () => elementCenter("["),
      "Invalid selector",
      "elementCenter reports invalid selectors"
    );
    await assertRejects(
      () => elementCenter("#does-not-exist"),
      "Element not found",
      "elementCenter reports missing elements"
    );

    const screenshotPath = await captureScreenshot(undefined, { full: false });
    const screenshotStat = await stat(screenshotPath);
    assert(screenshotStat.size > 0, "captureScreenshot writes a non-empty png");

    const explicitPath = await captureScreenshot(explicitScreenshotPath, { full: false });
    assertEqual(explicitPath, explicitScreenshotPath, "captureScreenshot returns explicit path");
    const explicitStat = await stat(explicitPath);
    assert(explicitStat.size > 0, "captureScreenshot writes explicit path");

    const fullScreenshotPath = await captureScreenshot(undefined, { full: true });
    const fullScreenshotStat = await stat(fullScreenshotPath);
    assert(fullScreenshotStat.size > 0, "captureScreenshot supports full page");

    const rawScreenshotPath = await captureScreenshot(undefined, {
      raw: true,
      clip: { x: 0, y: 0, width: 120, height: 120, scale: 1 },
    });
    const rawScreenshotStat = await stat(rawScreenshotPath);
    assert(rawScreenshotStat.size > 0, "captureScreenshot supports raw clips");

    await cdp("Network.enable");
    await browserFetch("/api/text", { timeout: 5 });
    const events = await drainEvents();
    assert(Array.isArray(events), "drainEvents returns an array");
    const eventsAfterDrain = await drainEvents();
    assertEqual(eventsAfterDrain.length, 0, "drainEvents clears the event buffer");

    /* dynamic DOM — add element, verify snapshot picks it up */
    cliLog(JSON.stringify({ observationStep: "dynamic DOM" }));
    await click("#remove-element");
    await wait(0.1);
    const textBefore = await snapshotText({ scope: "full_page" });
    assert(!String(textBefore).includes("Dynamic!"), "snapshot text does not contain dynamic element before creation");

    await click("#add-element");
    await waitForElement("#dynamic-element", { timeout: 3, visible: true });
    await wait(0.2);
    const textAfter = await snapshotText({ scope: "full_page" });
    assertIncludes(String(textAfter), "Dynamic!", "snapshot text includes dynamically created element");

    /* iframe interaction — evaluate JS inside the iframe */
    cliLog(JSON.stringify({ observationStep: "iframe" }));
    let frameTarget = null;
    const iframeDeadline = Date.now() + 3_000;
    while (!frameTarget && Date.now() <= iframeDeadline) {
      frameTarget = await iframeTarget("/frame.html");
      if (!frameTarget) await wait(0.05);
    }
    assert(frameTarget, "iframeTarget discovers the cross-site iframe target");

    const iframeMarkerText = await js(
      "return document.querySelector('#iframe-marker')?.textContent",
      frameTarget
    );
    assertEqual(iframeMarkerText, "iframe target", "js evaluates inside iframe using targetId");

    const iframeTitle = await js("return document.title", frameTarget);
    assertEqual(iframeTitle, "ego-lite iframe", "js reads iframe page title via targetId");
  `;
}
