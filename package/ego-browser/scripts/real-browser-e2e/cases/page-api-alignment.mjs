export function pageApiAlignmentCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/?page-api-alignment=" + Date.now());
    const originalTargetId = page.targetId;
    const originalLabel = page.label;

    await page.waitForLoadState();
    assertEqual(
      await page.evaluate("document.readyState"),
      "complete",
      "waitForLoadState defaults to the load state"
    );

    assertEqual(
      JSON.stringify(await page.selectOption("#dropdown", "Beta")),
      JSON.stringify(["beta"]),
      "a selectOption string matches an option label"
    );
    assertEqual(
      JSON.stringify(await page.selectOption("#dropdown", { value: "gamma" })),
      JSON.stringify(["gamma"]),
      "selectOption matches an option value descriptor"
    );
    assertEqual(
      JSON.stringify(await page.selectOption("#dropdown", { label: "Alpha" })),
      JSON.stringify(["alpha"]),
      "selectOption matches an option label descriptor"
    );
    assertEqual(
      JSON.stringify(await page.selectOption("#dropdown", { index: 1 })),
      JSON.stringify(["beta"]),
      "selectOption matches an option index descriptor"
    );

    await page.evaluate(() => {
      const single = document.createElement("select");
      single.id = "single-candidates";
      single.innerHTML =
        '<option value="first">Earlier</option><option value="second">Later</option>';
      document.body.append(single);

      const multiple = document.createElement("select");
      multiple.id = "multiple-options";
      multiple.multiple = true;
      multiple.innerHTML =
        '<option value="one">One</option>' +
        '<option value="two">Two</option>' +
        '<option value="undefined">Undefined</option>' +
        '<option value="">None</option>';
      document.body.append(multiple);

      const disabled = document.createElement("option");
      disabled.value = "blocked";
      disabled.label = "Blocked";
      disabled.textContent = "Blocked";
      disabled.disabled = true;
      document.querySelector("#dropdown").append(disabled);

      const ariaDisabled = document.createElement("option");
      ariaDisabled.value = "aria-blocked";
      ariaDisabled.label = "ARIA blocked";
      ariaDisabled.textContent = "ARIA blocked";
      ariaDisabled.setAttribute("aria-disabled", "true");
      document.querySelector("#dropdown").append(ariaDisabled);

      const disabledGroup = document.createElement("optgroup");
      disabledGroup.label = "Disabled group";
      disabledGroup.disabled = true;
      disabledGroup.innerHTML = '<option value="grouped">Grouped</option>';
      document.querySelector("#dropdown").append(disabledGroup);

      const fieldset = document.createElement("fieldset");
      fieldset.disabled = true;
      fieldset.innerHTML =
        '<select id="fieldset-select"><option value="inside">Inside</option></select>';
      document.body.append(fieldset);

      const ariaSelect = document.createElement("select");
      ariaSelect.id = "aria-disabled-select";
      ariaSelect.innerHTML = '<option value="inside">Inside</option>';
      const ariaDisabledContainer = document.createElement("div");
      ariaDisabledContainer.id = "aria-disabled-container";
      ariaDisabledContainer.setAttribute("aria-disabled", "true");
      ariaDisabledContainer.append(ariaSelect);
      document.body.append(ariaDisabledContainer);
    });

    assertEqual(
      JSON.stringify(
        await page.selectOption("#single-candidates", [
          { label: "Later" },
          { label: "Earlier" },
        ])
      ),
      JSON.stringify(["first"]),
      "a single select chooses the first DOM option matching any candidate"
    );
    assertEqual(
      JSON.stringify(
        await page.selectOption("#multiple-options", [
          { value: "one" },
          { label: "Two", index: 1 },
        ])
      ),
      JSON.stringify(["one", "two"]),
      "a multiple select matches all properties in each descriptor"
    );
    assertEqual(
      JSON.stringify(await page.selectOption("#multiple-options", "")),
      JSON.stringify([""]),
      "selectOption accepts an empty string option value"
    );
    await page.evaluate(() => {
      setTimeout(() => {
        const delayed = document.createElement("option");
        delayed.value = "delta";
        delayed.label = "Delta";
        delayed.textContent = "Delta";
        document.querySelector("#dropdown").append(delayed);
      }, 100);
    });
    assertEqual(
      JSON.stringify(
        await page.selectOption("#dropdown", { label: "Delta" }, { timeout: 2_000 })
      ),
      JSON.stringify(["delta"]),
      "selectOption waits for an option that appears during its timeout"
    );
    await assertRejects(
      () => page.selectOption("#dropdown", { label: "Missing" }, { timeout: 150 }),
      "available options:",
      "a missing option error lists the real available labels and values"
    );
    assertEqual(
      JSON.stringify(await page.selectOption("#dropdown", { label: "Blocked" })),
      JSON.stringify(["blocked"]),
      "a disabled option remains programmatically selectable"
    );
    assertEqual(
      JSON.stringify(await page.selectOption("#dropdown", { label: "ARIA blocked" })),
      JSON.stringify(["aria-blocked"]),
      "option ARIA state does not disable an enabled select"
    );
    assertEqual(
      JSON.stringify(await page.selectOption("#dropdown", { label: "Grouped" })),
      JSON.stringify(["grouped"]),
      "an option in a disabled optgroup remains programmatically selectable"
    );
    await assertRejects(
      () => page.selectOption("#fieldset-select", "inside", { timeout: 150 }),
      "none can receive input",
      "a select inside a disabled fieldset is not changed"
    );
    await assertRejects(
      () => page.selectOption("#aria-disabled-select", "inside", { timeout: 150 }),
      "element is disabled",
      "an aria-disabled select is not changed"
    );
    await page.evaluate(() => {
      setTimeout(() => {
        document.querySelector("#fieldset-select").closest("fieldset").disabled = false;
      }, 100);
    });
    assertEqual(
      JSON.stringify(
        await page.selectOption("#fieldset-select", "inside", { timeout: 2_000 })
      ),
      JSON.stringify(["inside"]),
      "selectOption waits for a disabled fieldset to become enabled"
    );
    await page.evaluate(() => {
      setTimeout(() => {
        document
          .querySelector("#aria-disabled-container")
          .setAttribute("aria-disabled", "false");
      }, 100);
    });
    assertEqual(
      JSON.stringify(
        await page.selectOption("#aria-disabled-select", "inside", {
          timeout: 2_000,
        })
      ),
      JSON.stringify(["inside"]),
      "selectOption waits for an aria-disabled select to become enabled"
    );
    assertEqual(
      JSON.stringify(await page.selectOption("#multiple-options", null)),
      JSON.stringify([]),
      "selectOption null clears a multiple selection even when a value is undefined"
    );
    assertEqual(
      await page.evaluate(
        "document.querySelector('#multiple-options').selectedOptions.length"
      ),
      0,
      "clearing a selection updates the real DOM"
    );
    await page.selectOption("#multiple-options", ["one", "two"]);
    assertEqual(
      JSON.stringify(await page.selectOption("#multiple-options", [])),
      JSON.stringify([]),
      "selectOption [] clears a multiple selection"
    );

    await page.evaluate(() => {
      window.__reloadSentinel = "must disappear";
    });
    await page.reload({ timeout: 3_000, waitUntil: "domcontentloaded" });
    await page.waitForLoadState();
    assertEqual(page.targetId, originalTargetId, "reload keeps the same browser target");
    assertEqual(page.label, originalLabel, "reload keeps the same durable Page label");
    assertEqual(
      await page.evaluate("window.__reloadSentinel"),
      null,
      "reload creates a fresh document instead of navigating by URL reuse"
    );

    await page.goto(baseUrl + "/domcontentloaded-page?ms=400", {
      waitUntil: "domcontentloaded",
      timeout: 2_000,
    });
    assertEqual(
      await page.evaluate("document.readyState"),
      "interactive",
      "the reload fixture is still loading after DOMContentLoaded"
    );
    await page.reload({ timeout: 2_000 });
    assertEqual(
      await page.evaluate("document.readyState"),
      "complete",
      "reload defaults to waiting for load"
    );

    await page.goto(baseUrl + "/streamed-page?ms=750", {
      waitUntil: "load",
      timeout: 2_000,
    });
    await page.reload({ waitUntil: "commit", timeout: 1_000 });
    assertEqual(
      await page.evaluate("document.readyState"),
      "loading",
      "reload can return at the new-document commit boundary"
    );
    const defaultLoadStartedAt = Date.now();
    await page.waitForLoadState(undefined, { timeout: 2_000 });
    assertEqual(
      await page.evaluate("document.readyState"),
      "complete",
      "waitForLoadState without a state waits for the load boundary"
    );
    assert(
      Date.now() - defaultLoadStartedAt >= 500,
      "the default load wait does not return while the streamed response is open"
    );

    await page.evaluate(() => {
      setTimeout(() => {
        document.documentElement.dataset.waitForFunctionReady = "true";
      }, 400);
    });
    const waitForFunctionStartedAt = Date.now();
    assertEqual(
      await page.waitForFunction(
        () => document.documentElement.dataset.waitForFunctionReady === "true",
        undefined,
        { timeout: 2_000 }
      ),
      true,
      "waitForFunction uses the Playwright-compatible argument and options positions"
    );
    assert(
      Date.now() - waitForFunctionStartedAt >= 250,
      "waitForFunction waits for a predicate that becomes true later"
    );
    assertEqual(
      await page.evaluate(
        "document.documentElement.dataset.waitForFunctionReady"
      ),
      "true",
      "waitForFunction returns only after the predicate is true in the Page"
    );
    await assertRejects(
      () => page.keyboard.press("Left"),
      'Use "ArrowLeft"',
      "keyboard errors suggest the Playwright arrow-key name"
    );

    await page.close();
  `;
}
