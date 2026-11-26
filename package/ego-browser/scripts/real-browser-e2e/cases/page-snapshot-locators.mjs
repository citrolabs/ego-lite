export function pageSnapshotLocatorCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/?workflow=page-snapshot-locators");

    await page.evaluate(() => {
      const region = document.createElement("section");
      region.innerHTML =
        '<a href="/nav-target?locator=duplicate">First duplicate</a>' +
        '<a href="/nav-target?locator=duplicate">Second duplicate</a>' +
        '<a href="/nav-target?locator=unique">Unique destination</a>';
      document.body.append(region);
    });

    const snapshot = await page.snapshot({ scope: "full_page" });
    const duplicateLines = snapshot
      .split("\\n")
      .filter((line) => line.includes("locator=duplicate"));
    assertEqual(duplicateLines.length, 2, "snapshot contains both duplicate links");
    // A browser that verifies locators may give each link another locator
    // that is unique, such as its role and name; only the shared href is not one.
    assert(
      duplicateLines.every((line) => !line.includes(", loc=href:")),
      "snapshot does not advertise a duplicate href as a stable locator"
    );
    for (const line of duplicateLines) {
      const locator = line.match(/, loc=(role:link\\[name="[^"]*"\\])/)?.[1];
      if (!locator) continue;
      // Resolution fails when a locator matches more than one element.
      await page.waitForSelector("loc=" + locator, {
        state: "attached",
        timeout: 2_000,
      });
    }
    assertIncludes(
      snapshot,
      "loc=href:/nav-target?locator=unique",
      "snapshot keeps a unique href locator"
    );
    await page.waitForSelector("loc=href:/nav-target?locator=unique", {
      state: "attached",
      timeout: 2_000,
    });

    await page.close();
  `;
}
