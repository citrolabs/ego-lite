import { homeCase } from "./shared.mjs";

export const selectOptionAtomicCases = [
  {
    name: "selectOption keeps the current selection when no option matches",
    body: homeCase(`
      await page.locator("#dropdown").selectOption("gamma");
      assertEqual(await page.locator("#dropdown").inputValue(), "gamma", "selectOption selects a later option");
      assertEqual(await page.evaluate("window.__fixtureState.dropdownValue"), "gamma", "the page records the selection");

      const misses = [
        ["delta", "an unknown value"],
        [{ label: "Delta" }, "an unknown label"],
        [{ index: 7 }, "an out-of-range index"],
      ];
      for (const [wanted, label] of misses) {
        await assertRejects(
          () => page.locator("#dropdown").selectOption(wanted),
          "could not find option",
          "selectOption rejects " + label
        );
        assertEqual(
          await page.locator("#dropdown").inputValue(),
          "gamma",
          "selectOption keeps the selected value after " + label
        );
        assertEqual(
          await page.evaluate("window.__fixtureState.dropdownValue"),
          "gamma",
          "the page state still matches the DOM after " + label
        );
      }

      await page.evaluate(\`(() => {
        const select = document.createElement("select");
        select.id = "multi-dropdown";
        select.multiple = true;
        for (const value of ["one", "two", "three"]) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = value;
          select.append(option);
        }
        document.body.append(select);
        return true;
      })()\`);

      const multiValues = () =>
        page.locator("#multi-dropdown").evaluate((el) =>
          Array.from(el.selectedOptions).map((option) => option.value).join(",")
        );

      await page.locator("#multi-dropdown").selectOption(["one", "three"]);
      assertEqual(await multiValues(), "one,three", "selectOption selects several options in a multiple select");
      await assertRejects(
        () => page.locator("#multi-dropdown").selectOption(["two", "four"]),
        "could not find option",
        "selectOption rejects a partly matching multiple selection"
      );
      assertEqual(await multiValues(), "one,three", "selectOption keeps every selected option after a partial miss");

      /* A single select stops after the first requested value, so a trailing
         unknown one is never looked up. */
      assertEqual(
        (await page.locator("#dropdown").selectOption(["beta", "delta"])).join(","),
        "beta",
        "a single select applies the first requested value and ignores the rest"
      );
      assertEqual(await page.locator("#dropdown").inputValue(), "beta", "the first requested value reaches the DOM");
    `),
  },
];
