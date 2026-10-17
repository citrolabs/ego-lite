export function pageShadowDomCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/?page=shadow-dom");
    try {
      const snapshot = await page.snapshot({ scope: "full_page" });
      assertIncludes(snapshot, "Shadow field", "snapshot exposes the shadow input");

      await page.fill('loc=css:input[aria-label="Shadow field"]', "shadow value");
      assertEqual(
        await page.evaluate(() =>
          document
            .querySelector("#shadow-fixture")
            .shadowRoot.querySelector('input[aria-label="Shadow field"]')
            .value
        ),
        "shadow value",
        "snapshot-style CSS locators resolve inside an open shadow root"
      );

      await page.click("#shadow-action");
      assertEqual(
        await page.evaluate(() =>
          document
            .querySelector("#shadow-fixture")
            .shadowRoot.querySelector("nested-shadow-fixture")
            .shadowRoot.querySelector("#shadow-action")
            .dataset.clicked
        ),
        "true",
        "raw CSS selectors resolve controls inside nested open shadow roots"
      );
    } finally {
      await page.close();
    }
  `;
}
