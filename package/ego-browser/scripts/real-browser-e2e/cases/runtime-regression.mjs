export function runtimeRegressionCase() {
  return `
    await useOrCreateTaskSpace(taskName);
    await resetHome();

    /* Issue 2: waitForSelector shares the unified resolver — xpath= must resolve a
       static element (official runtime.mjs only exercises CSS selectors here). */
    assertEqual(
      await waitForSelector('xpath=//button[@id="click-button"]', { timeout: 4000 }),
      true,
      "waitForSelector resolves xpath= selector (Issue 2)"
    );

    /* Resolver failure classes on waitForSelector: a permanent (ambiguous) selector
       fails fast; a transient (missing) one polls until the timeout, then returns
       false. Official only covers the happy path. */
    const permStart = Date.now();
    await assertRejects(
      () => waitForSelector("loc=css:.duplicate-action", { timeout: 5000 }),
      "matched 2",
      "waitForSelector throws on a permanent ambiguity error"
    );
    assert(
      Date.now() - permStart < 2500,
      "permanent ambiguity error fails fast, not consuming the full timeout"
    );

    const missStart = Date.now();
    assertEqual(
      await waitForSelector("#no-such-element-xyz", { timeout: 1000 }),
      false,
      "waitForSelector returns false for a transient missing element"
    );
    assert(
      Date.now() - missStart >= 700,
      "transient miss polls until the timeout elapses"
    );

    /* js runs in the page, not the Node-side script: caller closure variables are NOT
       captured. 'outer' is referenced only inside the serialized function. */
    const outer = 100;
    const closureType = await evaluate(function () {
      return typeof outer;
    });
    assertEqual(closureType, "undefined", "js does not capture caller closure variables");

    /* js rejects invalid input types (neither string nor function). */
    await assertRejectsAny(() => evaluate(123), "js rejects non-string/function input");

    /* serverFetch returns the body and respects exact content length, including
       lower boundary values (n=0, n=1) that were previously only tested in the
       now-removed theory-expanded suite. */
    assertEqual(
      (await serverFetch(baseUrl + "/api/bytes?n=0", { timeout: 5 })).length,
      0,
      "serverFetch returns empty body for zero-byte request"
    );
    assertEqual(
      (await serverFetch(baseUrl + "/api/bytes?n=1", { timeout: 5 })).length,
      1,
      "serverFetch returns one byte for single-byte request"
    );
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

    /* waitForLoadState blocks until a slow-arriving document loads. Navigates away, so
       keep this last. */
    const slowStart = Date.now();
    await goto(baseUrl + "/slow-page?ms=1200", { waitUntil: "commit" });
    assert(
      await waitForLoadState("load", { timeout: 8000 }),
      "waitForLoadState resolves true once the slow document arrives"
    );
    assert(
      Date.now() - slowStart >= 1000,
      "waitForLoadState blocks until the slow document loads"
    );
  `;
}
