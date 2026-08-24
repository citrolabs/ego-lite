export function pageSelectorCompatibilityCase() {
  const apostropheSelector = JSON.stringify(
    String.raw`button:text-is('can\'t')`,
  );
  const hexEscapeSelector = JSON.stringify(String.raw`button:text-is("\41 B")`);
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(
      task,
      baseUrl + "/same-origin-frame?page=selector-compatibility&run=" + Date.now()
    );

    await page.evaluate(() => {
      const hasTextButton = document.createElement("button");
      hasTextButton.id = "save-changes";
      hasTextButton.innerHTML = "<span>Save</span> changes";
      hasTextButton.addEventListener("click", () => {
        document.documentElement.dataset.hasTextClicked = "true";
      });

      const exactButton = document.createElement("button");
      exactButton.id = "exact-save";
      exactButton.innerHTML = "Save <span>draft</span>";
      exactButton.addEventListener("click", () => {
        document.documentElement.dataset.textIsClicked = "true";
      });

      const nestedOnlyButton = document.createElement("button");
      nestedOnlyButton.id = "nested-only-save";
      nestedOnlyButton.innerHTML = "<span>Save</span>";
      nestedOnlyButton.addEventListener("click", () => {
        document.documentElement.dataset.textIsClicked = "wrong-target";
      });

      const apostropheButton = document.createElement("button");
      apostropheButton.id = "apostrophe-label";
      apostropheButton.textContent = "can't";
      apostropheButton.addEventListener("click", () => {
        document.documentElement.dataset.apostropheClicked = "true";
      });

      const hexEscapeButton = document.createElement("button");
      hexEscapeButton.textContent = "AB";
      hexEscapeButton.addEventListener("click", () => {
        document.documentElement.dataset.hexEscapeClicked = "true";
      });

      const quotedTokenButton = document.createElement("button");
      quotedTokenButton.dataset.value = ":has-text(";
      quotedTokenButton.textContent = "Quoted compatibility token";
      quotedTokenButton.addEventListener("click", () => {
        document.documentElement.dataset.quotedTokenClicked = "true";
      });

      const emptyTextButton = document.createElement("button");
      emptyTextButton.id = "empty-text-button";
      emptyTextButton.setAttribute("aria-label", "Empty text action");
      emptyTextButton.addEventListener("click", () => {
        document.documentElement.dataset.emptyTextClicked = "true";
      });

      const duplicateHref = document.createElement("a");
      duplicateHref.href = "/nav-target";
      duplicateHref.textContent = "Alternate nav target";
      duplicateHref.addEventListener("click", (event) => {
        event.preventDefault();
        document.documentElement.dataset.hrefNthClicked = "true";
      });

      document
        .querySelector("main")
        .prepend(
          emptyTextButton,
          quotedTokenButton,
          hexEscapeButton,
          apostropheButton,
          nestedOnlyButton,
          exactButton,
          hasTextButton
        );
      document.querySelector("main").append(duplicateHref);
      document.querySelectorAll(".duplicate-action").forEach((button, index) => {
        if (index === 0) button.style.display = "none";
        button.addEventListener("click", () => {
          document.documentElement.dataset.duplicateIndex = String(index);
        });
      });
    });

    await page.click("css=#click-button");
    assertEqual(
      await page.evaluate(() => window.__fixtureState.clicks),
      1,
      "css= aliases a CSS selector on a real page"
    );

    await page.click('button:has-text("save changes")');
    assertEqual(
      await page.evaluate("document.documentElement.dataset.hasTextClicked"),
      "true",
      ":has-text normalizes whitespace and ignores case"
    );

    await page.click('button:text-is("Save")');
    assertEqual(
      await page.evaluate("document.documentElement.dataset.textIsClicked"),
      "true",
      ":text-is performs an exact case-sensitive match"
    );

    await page.click(${apostropheSelector});
    assertEqual(
      await page.evaluate("document.documentElement.dataset.apostropheClicked"),
      "true",
      ":text-is decodes a quoted CSS string"
    );

    await page.click(${hexEscapeSelector});
    assertEqual(
      await page.evaluate("document.documentElement.dataset.hexEscapeClicked"),
      "true",
      ":text-is decodes a CSS hex escape and its terminator"
    );

    await page.click('[data-value=":has-text("]');
    assertEqual(
      await page.evaluate("document.documentElement.dataset.quotedTokenClicked"),
      "true",
      "raw CSS keeps compatibility-like text inside a quoted value"
    );

    await page.click('#empty-text-button:text-is("")');
    assertEqual(
      await page.evaluate("document.documentElement.dataset.emptyTextClicked"),
      "true",
      ":text-is matches a candidate with no immediate text"
    );

    await assertRejects(
      () => page.click('button, a:has-text("Docs")'),
      "Invalid locator",
      "unsupported selector-list text filters fail explicitly"
    );

    await page.click(".duplicate-action >> nth=1");
    assertEqual(
      await page.evaluate("document.documentElement.dataset.duplicateIndex"),
      "1",
      "terminal nth selects by DOM order before actionability checks"
    );
    await page.evaluate(() => {
      delete document.documentElement.dataset.duplicateIndex;
    });
    await page.click("text=Duplicate action >> nth=-1");
    assertEqual(
      await page.evaluate("document.documentElement.dataset.duplicateIndex"),
      "1",
      "terminal nth=-1 selects the last text-locator match"
    );
    await page.click("loc=href:/nav-target >> nth=-1");
    assertEqual(
      await page.evaluate("document.documentElement.dataset.hrefNthClicked"),
      "true",
      "terminal nth composes with an href locator"
    );

    await page.click('loc=role:button[name*="increment COUNTER"]');
    assertEqual(
      await page.evaluate(() => window.__fixtureState.clicks),
      2,
      "role name*= matches an accessible-name substring without case sensitivity"
    );

    await page.click('nested-shadow-fixture:has-text("shadow ACTION")');
    assertEqual(
      await page.evaluate(() =>
        document
          .querySelector("#shadow-fixture")
          .shadowRoot.querySelector("nested-shadow-fixture")
          .shadowRoot.querySelector("#shadow-action").dataset.clicked
      ),
      "true",
      ":has-text includes text from the candidate's open shadow root"
    );

    await page.click('button:has-text("Run iframe action")');
    assertEqual(
      await page.evaluate(() =>
        document
          .querySelector("#fixture-frame")
          .contentDocument.querySelector("#iframe-result").textContent
      ),
      "clicked:true",
      ":has-text routes a trusted click into a same-origin iframe"
    );

    await page.close();
  `;
}
