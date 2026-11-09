export function runtimeRegressionCase() {
  return `
    await useOrCreateTaskSpace(taskName);
    await resetHome();

    /* Issue 2: waitForElement shares the unified resolver — xpath= must resolve a
       static element (official runtime.mjs only exercises CSS selectors here). */
    assertEqual(
      await waitForElement('xpath=//button[@id="click-button"]', { timeout: 4 }),
      true,
      "waitForElement resolves xpath= selector (Issue 2)"
    );

    /* Resolver failure classes on waitForElement: a permanent (ambiguous) selector
       fails fast; a transient (missing) one polls until the timeout, then returns
       false. Official only covers the happy path. */
    const permStart = Date.now();
    await assertRejects(
      () => waitForElement("loc=css:.duplicate-action", { timeout: 5 }),
      "matched 2",
      "waitForElement throws on a permanent ambiguity error"
    );
    assert(
      Date.now() - permStart < 2500,
      "permanent ambiguity error fails fast, not consuming the full timeout"
    );

    const missStart = Date.now();
    assertEqual(
      await waitForElement("#no-such-element-xyz", { timeout: 1 }),
      false,
      "waitForElement returns false for a transient missing element"
    );
    assert(
      Date.now() - missStart >= 700,
      "transient miss polls until the timeout elapses"
    );

    /* js runs in the page, not the heredoc: caller closure variables are NOT
       captured. 'outer' is referenced only inside the serialized function. */
    const outer = 100;
    const closureType = await js(function () {
      return typeof outer;
    });
    assertEqual(closureType, "undefined", "js does not capture caller closure variables");

    /* js rejects invalid input types (neither string nor function). */
    await assertRejectsAny(() => js(123), "js rejects non-string/function input");

    /* serverFetch returns the body and respects exact content length. */
    const bytes = await serverFetch(baseUrl + "/api/bytes?n=4096", { timeout: 5 });
    assertEqual(bytes.length, 4096, "serverFetch returns a body of the exact requested length");

    /* serverFetch / browserFetch surface 4xx HTTP errors (official only covers 500). */
    await assertRejects(
      () => serverFetch(baseUrl + "/api/status?code=404", { timeout: 5 }),
      "HTTP 404",
      "serverFetch reports 4xx HTTP errors"
    );
    await assertRejects(
      () => browserFetch("/api/status?code=404", { timeout: 5 }),
      "HTTP 404",
      "browserFetch reports 4xx HTTP errors"
    );

    /* waitForLoad blocks until a slow-arriving document loads. Navigates away, so
       keep this last. */
    const slowStart = Date.now();
    await gotoUrl(baseUrl + "/slow-page?ms=1200");
    assert(
      await waitForLoad({ timeout: 8 }),
      "waitForLoad resolves true once the slow document arrives"
    );
    assert(
      Date.now() - slowStart >= 1000,
      "waitForLoad blocks until the slow document loads"
    );
  `;
}
