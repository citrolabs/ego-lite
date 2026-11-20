export function pageSnapshotViewportOverflowCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/snapshot-viewport-overflow");
    const hintLine = (text) =>
      text.split("\\n").find((line) => line.startsWith("[more content "));

    await page.click('text="Submit"');
    await page.waitForFunction(() => document.body.innerText.includes("RESULT-OK"));
    const metrics = await page.evaluate(() => ({
      innerHeight,
      scrollY,
      resultTop: Math.round(
        document.querySelector("#out [role=status]").getBoundingClientRect().top
      ),
    }));
    assert(
      metrics.resultTop >= metrics.innerHeight,
      "fixture keeps the result below the fold: " + JSON.stringify(metrics)
    );

    const viewport = await page.snapshot();
    assert(!viewport.includes("RESULT-OK"), "the viewport snapshot omits the offscreen result");
    const below = hintLine(viewport);
    assert(below, "the viewport snapshot ends with an overflow hint");
    assertIncludes(below, "more content below the viewport", "the hint points below");
    assertIncludes(below, "scrollY=0", "the hint reports the scroll position");
    assertIncludes(below, 'snapshot({ scope: "full_page" })', "the hint names the full_page scope");
    assertEqual(viewport.split("\\n").at(-1), below, "the hint is the last snapshot line");

    const full = await page.snapshot({ scope: "full_page" });
    assertIncludes(full, "RESULT-OK ticket T-1234", "the full_page snapshot includes the result");
    assert(!hintLine(full), "the full_page snapshot carries no overflow hint");

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const scrolled = await page.snapshot();
    assertIncludes(scrolled, "RESULT-OK ticket T-1234", "scrolling brings the result into the viewport snapshot");
    assertIncludes(hintLine(scrolled) || "", "more content above the viewport", "the hint flips to above after scrolling to the bottom");

    await page.goto(baseUrl + "/download-entry");
    const fits = await page.snapshot();
    assertIncludes(fits, "Preview report", "the short page snapshot has its content");
    assert(!hintLine(fits), "a page that fits the viewport gets no overflow hint");

    await page.close();
  `;
}
