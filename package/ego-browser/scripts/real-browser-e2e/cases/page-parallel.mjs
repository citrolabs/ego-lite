// Pages of one task space load in parallel: navigation holds the space only
// as shared work, while input still runs alone. The fixture server reports
// how many /slow-page requests of a group were in flight at once.
export function pageParallelLoadCase() {
  return `
    const task = await taskSpace(taskName + " parallel load");
    const group = "parallel-" + Date.now();
    const delayMs = 1500;
    const pages = [task.page("p1")];
    // The E2E page budget is 3.
    for (let i = 0; i < 2; i += 1) pages.push(await task.newPage());

    const started = Date.now();
    await Promise.all(
      pages.map((page, i) =>
        page.goto(baseUrl + "/slow-page?ms=" + delayMs + "&group=" + group + "&i=" + i)
      )
    );
    const elapsed = Date.now() - started;
    const { peak } = await (
      await fetch(baseUrl + "/api/slow-page-peak?group=" + group)
    ).json();
    assertEqual(peak, pages.length, "every Page of the space loads at once");
    assert(
      elapsed < delayMs * pages.length * 0.6,
      "parallel loads take " + elapsed + "ms, not one load after another"
    );
    for (const page of pages) {
      assertEqual(await page.title(), "slow page", page.label + " finished loading");
    }

    // Input waits for the shared work and still lands on its own Page.
    const target = pages[1];
    await target.goto(baseUrl + "/?parallel-click=1");
    await Promise.all([
      pages[2].goto(baseUrl + "/slow-page?ms=800&group=" + group + "-mixed"),
      target.click("loc=role:button[name='Increment counter']", {
        label: "click counter during loads",
      }),
      pages[0].goto(baseUrl + "/slow-page?ms=800&group=" + group + "-mixed"),
    ]);
    assertEqual(
      await target.evaluate(() => window.__fixtureState.clicks),
      1,
      "the click lands once on its Page while other Pages load"
    );
    assertEqual(await pages[2].title(), "slow page", "a load next to the click completes");

    const finished = await task.finish({ keep: [] });
    assertEqual(finished.closedSpace, true, "the parallel-load space is closed");
  `;
}
