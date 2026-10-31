// A main-frame navigation that has started but not committed suspends every
// renderer-bound CDP command until the new document commits or the navigation
// stops. These cases pin the harness behavior on such a Page: public calls
// stay inside one bounded wait, then stop the navigation and say which
// document the Page shows, so the next call answers at once.
//
// That bounded wait is the runtime's response timeout. Both processes shorten
// it (the SDK reads it per call) so the cases prove "one wait, not one per
// setup command" in seconds instead of waiting out the 15 s default.
const PENDING_NAVIGATION_RESPONSE_TIMEOUT_MS = 5_000;

export function pagePendingNavigationCase() {
  return `
    const transportMs = ${PENDING_NAVIGATION_RESPONSE_TIMEOUT_MS};
    process.env.EGO_BROWSER_RESPONSE_TIMEOUT_MS = String(transportMs);
    const task = await taskSpace(taskName);
    const page = await newPageAt(
      task,
      baseUrl + "/nav-target?pending-navigation=" + Date.now()
    );
    const heldUrl = baseUrl + "/hold-page?ms=120000";

    // goto bounds its own wait and stops the navigation it could not commit,
    // so the Page keeps answering on its previous document.
    const gotoStartedAt = Date.now();
    let gotoError;
    try {
      await page.goto(heldUrl, { timeout: 1_500 });
    } catch (error) {
      gotoError = error;
    }
    assertEqual(
      gotoError?.code,
      "EGO_NAVIGATION_TIMEOUT",
      "goto to a held response times out: " + gotoError?.message
    );
    assert(
      Date.now() - gotoStartedAt < 4_000,
      "goto returns close to its own timeout: " + (Date.now() - gotoStartedAt)
    );
    assertEqual(gotoError?.committed, false, "the held navigation did not commit");
    assertEqual(gotoError?.stopped, true, "goto stopped the pending navigation");
    assertIncludes(
      gotoError?.message,
      "had not committed and was stopped",
      "the goto error says the navigation was stopped"
    );
    assertIncludes(
      gotoError?.message,
      "page.goto(url, { timeout })",
      "the goto error tells the agent how to retry"
    );

    const afterGotoStartedAt = Date.now();
    const afterGoto = await page.snapshot();
    assert(
      Date.now() - afterGotoStartedAt < 5_000,
      "snapshot answers promptly after goto stopped the navigation: " +
        (Date.now() - afterGotoStartedAt)
    );
    assertIncludes(
      afterGoto,
      "Navigation target",
      "the Page still shows the last committed document after goto gave up"
    );

    // A navigation that goto did not start (a link click, a script, raw CDP)
    // can still be left pending; a public call then stays inside one bounded
    // wait, stops that navigation, and says what the Page shows now. Chromium
    // answers Page.navigate only once the response arrives, so the raw call
    // is given up on while the navigation stays pending.
    const leavePending = (suffix) =>
      page
        .cdp("Page.navigate", { url: heldUrl + suffix }, { timeout: 500 })
        .catch(() => {});
    await leavePending("&raw=1");
    const snapshotStartedAt = Date.now();
    let snapshotError;
    try {
      await page.snapshot();
    } catch (error) {
      snapshotError = error;
    }
    const snapshotElapsed = Date.now() - snapshotStartedAt;
    assertEqual(
      snapshotError?.code,
      "EGO_PAGE_UNRESPONSIVE",
      "snapshot during a pending navigation reports the unresponsive Page: " +
        snapshotError?.message
    );
    assertIncludes(
      snapshotError?.message,
      "Page " + page.label,
      "the error names the Page"
    );
    assertIncludes(
      snapshotError?.message,
      "(" + baseUrl + "/",
      "the error names the Page URL"
    );
    assertEqual(
      snapshotError?.stopped,
      true,
      "the pending navigation is stopped once the wait ran out"
    );
    assertIncludes(
      snapshotError?.message,
      "shows " + baseUrl + "/nav-target",
      "the error says which document the Page shows now"
    );
    assertIncludes(
      snapshotError?.message,
      "page.goto(url, { timeout })",
      "the error tells the agent how to load the pending document"
    );
    assert(
      snapshotElapsed < transportMs + 3_500,
      "snapshot gives up after one bounded wait, not one per setup command: " +
        snapshotElapsed
    );
    const afterStopStartedAt = Date.now();
    assertIncludes(
      await page.snapshot(),
      "Navigation target",
      "the next call answers on the previous document"
    );
    assert(
      Date.now() - afterStopStartedAt < 5_000,
      "the next call does not wait another full period: " +
        (Date.now() - afterStopStartedAt)
    );

    // goto on such a Page replaces the pending navigation with its own, times
    // out within its budget, and leaves the Page usable again.
    await leavePending("&raw=2");
    const secondGotoStartedAt = Date.now();
    let secondGotoError;
    try {
      await page.goto(heldUrl + "&second=1", { timeout: 2_000 });
    } catch (error) {
      secondGotoError = error;
    }
    assertEqual(
      secondGotoError?.code,
      "EGO_NAVIGATION_TIMEOUT",
      "goto on an unresponsive Page still times out: " + secondGotoError?.message
    );
    assert(
      Date.now() - secondGotoStartedAt < 4_500,
      "goto on an unresponsive Page counts session setup against its timeout: " +
        (Date.now() - secondGotoStartedAt)
    );
    assertEqual(
      secondGotoError?.stopped,
      true,
      "goto on an unresponsive Page stops the navigation it started"
    );
    const recoveredStartedAt = Date.now();
    const recovered = await page.snapshot();
    assert(
      Date.now() - recoveredStartedAt < 5_000,
      "snapshot answers promptly once goto stopped the pending navigation: " +
        (Date.now() - recoveredStartedAt)
    );
    assertIncludes(
      recovered,
      "Navigation target",
      "the Page still shows the last committed document"
    );

    // Leave a pending navigation behind for the fresh-process case.
    await page
      .cdp("Page.navigate", { url: heldUrl + "&fresh=1" }, { timeout: 500 })
      .catch(() => {});
    await writeFile(
      join(tempDir, "pending-navigation-state.json"),
      JSON.stringify({ label: page.label })
    );
  `;
}

// evaluate() and screenshot() reach the renderer through Runtime.evaluate
// rather than frame discovery; they end in the same bounded wait and stop.
export function pagePendingNavigationEvaluateScreenshotCase() {
  return `
    const transportMs = ${PENDING_NAVIGATION_RESPONSE_TIMEOUT_MS};
    process.env.EGO_BROWSER_RESPONSE_TIMEOUT_MS = String(transportMs);
    const task = await taskSpace(taskName);
    const page = await newPageAt(
      task,
      baseUrl + "/nav-target?pending-navigation-eval=" + Date.now()
    );
    const heldUrl = baseUrl + "/hold-page?ms=120000";
    const leavePending = (suffix) =>
      page
        .cdp("Page.navigate", { url: heldUrl + suffix }, { timeout: 500 })
        .catch(() => {});

    await leavePending("&eval=1");
    const evaluateStartedAt = Date.now();
    let evaluateError;
    try {
      await page.evaluate(() => document.title);
    } catch (error) {
      evaluateError = error;
    }
    const evaluateElapsed = Date.now() - evaluateStartedAt;
    assertEqual(
      evaluateError?.code,
      "EGO_PAGE_EVALUATION_TIMED_OUT",
      "evaluate during a pending navigation times out: " + evaluateError?.message
    );
    assertEqual(
      evaluateError?.stopped,
      true,
      "evaluate stops the pending navigation once its wait ran out"
    );
    assertEqual(evaluateError?.pageResponsive, true, "the Page answers again");
    assertIncludes(
      evaluateError?.message,
      "on Page " + page.label,
      "the evaluate error names the Page"
    );
    assertIncludes(
      evaluateError?.message,
      "shows " + baseUrl + "/nav-target",
      "the evaluate error says which document the Page shows now"
    );
    assert(
      evaluateElapsed < transportMs * 2 + 4_000,
      "evaluate gives up after one bounded wait: " + evaluateElapsed
    );
    const evaluateAgainStartedAt = Date.now();
    assertEqual(
      await page.evaluate(() => document.title),
      "ego-lite nav target",
      "the next evaluate answers on the previous document"
    );
    assert(
      Date.now() - evaluateAgainStartedAt < 5_000,
      "the next evaluate does not wait another full period: " +
        (Date.now() - evaluateAgainStartedAt)
    );

    await leavePending("&shot=1");
    const screenshotStartedAt = Date.now();
    let screenshotError;
    try {
      await page.screenshot();
    } catch (error) {
      screenshotError = error;
    }
    const screenshotElapsed = Date.now() - screenshotStartedAt;
    assertEqual(
      screenshotError?.code,
      "EGO_PAGE_UNRESPONSIVE",
      "screenshot during a pending navigation reports the unresponsive Page: " +
        screenshotError?.message
    );
    assertEqual(
      screenshotError?.stopped,
      true,
      "screenshot stops the pending navigation once its wait ran out"
    );
    assertIncludes(
      screenshotError?.message,
      "Page " + page.label,
      "the screenshot error names the Page"
    );
    assertIncludes(
      screenshotError?.message,
      "shows " + baseUrl + "/nav-target",
      "the screenshot error says which document the Page shows now"
    );
    assert(
      screenshotElapsed < transportMs * 2 + 4_000,
      "screenshot gives up after one bounded wait: " + screenshotElapsed
    );
    const screenshotAgainStartedAt = Date.now();
    await page.screenshot();
    assert(
      Date.now() - screenshotAgainStartedAt < 5_000,
      "the next screenshot does not wait another full period: " +
        (Date.now() - screenshotAgainStartedAt)
    );
    await page.close();
  `;
}

export function pagePendingNavigationFreshProcessCase() {
  return `
    const transportMs = ${PENDING_NAVIGATION_RESPONSE_TIMEOUT_MS};
    process.env.EGO_BROWSER_RESPONSE_TIMEOUT_MS = String(transportMs);
    const task = await taskSpace(taskName);
    const saved = JSON.parse(
      await readFile(join(tempDir, "pending-navigation-state.json"), "utf8")
    );
    const page = task.page(saved.label);

    const startedAt = Date.now();
    let error;
    try {
      await page.snapshot();
    } catch (caught) {
      error = caught;
    }
    const elapsed = Date.now() - startedAt;
    assertEqual(
      error?.code,
      "EGO_PAGE_UNRESPONSIVE",
      "the first call of a new process reports the unresponsive Page: " +
        error?.message
    );
    assert(
      elapsed < transportMs + 3_500,
      "a new process does not wait a full transport timeout per setup command: " +
        elapsed
    );

    assertEqual(
      error?.stopped,
      true,
      "the new process stops the pending navigation after its wait"
    );
    const recoveredStartedAt = Date.now();
    assertIncludes(
      await page.snapshot(),
      "Navigation target",
      "the Page recovers in the new process as well"
    );
    assert(
      Date.now() - recoveredStartedAt < 5_000,
      "the next call in the new process answers at once: " +
        (Date.now() - recoveredStartedAt)
    );
    await page.close();
  `;
}
