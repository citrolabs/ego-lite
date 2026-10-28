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
    assert(
      duplicateLines.every((line) => !line.includes(", loc=")),
      "snapshot does not advertise a duplicate href as a stable locator"
    );
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
