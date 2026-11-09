export function pageTextLocatorCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/?page=text-locators");
    try {
      await page.evaluate(() => {
        const region = document.createElement("section");
        region.innerHTML =
          '<button id="normalized-text" type="button">Save\\n <span>changes</span></button>' +
          '<button id="exact-text" type="button"><span>Exact action</span></button>';
        document.body.append(region);
        document.querySelector("#normalized-text").addEventListener("click", () => {
          document.querySelector("#normalized-text").dataset.clicked = "true";
        });
        document.querySelector("#exact-text").addEventListener("click", () => {
          document.querySelector("#exact-text").dataset.clicked = "true";
        });
      });

      await page.click("text=save changes");
      assertEqual(
        await page.evaluate(() => document.querySelector("#normalized-text").dataset.clicked),
        "true",
        "text locator normalizes whitespace and matches case-insensitively"
      );

      await page.click('text="Exact action"');
      assertEqual(
        await page.evaluate(() => document.querySelector("#exact-text").dataset.clicked),
        "true",
        "quoted text locator uses exact case-sensitive text"
      );

      await page.waitForSelector("text=Hover zone", {
        state: "visible",
        timeout: 2_000,
      });

      await page.click("text=Shadow action");
      assertEqual(
        await page.evaluate(() =>
          document
            .querySelector("#shadow-fixture")
            .shadowRoot.querySelector("nested-shadow-fixture")
            .shadowRoot.querySelector("#shadow-action")
            .dataset.clicked
        ),
        "true",
        "text locator searches nested open shadow roots"
      );

      await assertRejects(
        () => page.click("text=Duplicate action"),
        "matched 2 elements",
        "ambiguous text locator fails instead of choosing a target"
      );
    } finally {
      await page.close();
    }
  `;
}
