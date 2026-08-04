import { homeCase } from "./shared.mjs";

export const fillEditabilityCases = [
  {
    name: "fill rejects non-editable targets",
    body: homeCase(`
      /* Make the fixture form controls non-editable and record every input and
         change event they receive. */
      await page.evaluate(\`(() => {
        window.__fillProbe = {};
        const prepare = {
          "text-input": (el) => { el.readOnly = true; },
          "append-input": (el) => { el.disabled = true; },
          "text-area": (el) => { el.readOnly = true; },
          "dropdown": () => {},
        };
        for (const [id, mark] of Object.entries(prepare)) {
          const el = document.querySelector("#" + id);
          mark(el);
          window.__fillProbe[id] = [];
          for (const type of ["input", "change"]) {
            el.addEventListener(type, (event) => window.__fillProbe[id].push(type + "=" + event.target.value));
          }
        }
        return true;
      })()\`);

      const targets = [
        ["text-input", "readonly input", "2026-12-25"],
        ["append-input", "disabled input", "2026-12-25"],
        ["text-area", "readonly textarea", "replacement"],
        ["dropdown", "select", "beta"],
      ];
      for (const [id, label, value] of targets) {
        const before = await page.evaluate("document.querySelector('#" + id + "').value");
        assertEqual(await page.locator("#" + id).isEditable(), false, label + " reports isEditable false");
        await assertRejects(
          () => page.locator("#" + id).fill(value, { timeout: 3000 }),
          "fill target is not editable",
          "fill rejects a " + label
        );
        assertEqual(
          await page.evaluate("document.querySelector('#" + id + "').value"),
          before,
          "fill preserves the " + label + " value"
        );
        assertEqual(
          await page.evaluate("window.__fillProbe['" + id + "'].join(',')"),
          "",
          "fill fires no input or change events on a " + label
        );
      }

      /* clearFirst:false takes the other focus branch. */
      await assertRejects(
        () => page.locator("#text-input").fill("-suffix", { clearFirst: false, timeout: 3000 }),
        "fill target is not editable",
        "fill clearFirst:false rejects a readonly input"
      );
      assertEqual(
        await page.evaluate("document.querySelector('#text-input').value"),
        "initial",
        "fill clearFirst:false preserves the readonly input value"
      );

      await page.evaluate("document.querySelector('#text-input').readOnly = false; return true;");
      await page.locator("#text-input").fill("now editable", { timeout: 3000 });
      assertEqual(
        await page.locator("#text-input").inputValue(),
        "now editable",
        "fill writes the input again once readOnly is cleared"
      );
    `),
  },
  {
    name: "fill rejects enabled non-text inputs",
    body: homeCase(`
      /* Add the non-text input types the fixture does not carry, and record
         every input and change event the whole set receives. */
      await page.evaluate(\`(() => {
        const host = document.createElement("div");
        host.innerHTML = [
          '<input id="range-field" type="range" min="0" max="100" value="30">',
          '<input id="color-field" type="color" value="#ff0000">',
          '<input id="submit-field" type="submit" value="Send">',
          '<input id="radio-field" type="radio" name="pick" value="one">',
          '<input id="date-field" type="date" value="2020-01-02">',
          '<input id="month-field" type="month" value="2020-01">',
          '<input id="week-field" type="week" value="2020-W02">',
          '<input id="time-field" type="time" value="10:30">',
          '<input id="datetime-field" type="datetime-local" value="2020-01-02T10:30">',
        ].join("");
        document.body.append(host);
        window.__nonTextProbe = {};
        const ids = [
          "checkbox", "file-input", "range-field", "color-field", "submit-field",
          "radio-field", "date-field", "month-field", "week-field", "time-field",
          "datetime-field",
        ];
        for (const id of ids) {
          const el = document.querySelector("#" + id);
          window.__nonTextProbe[id] = [];
          for (const type of ["input", "change"]) {
            el.addEventListener(type, (event) => window.__nonTextProbe[id].push(type + "=" + event.target.value));
          }
        }
        return true;
      })()\`);

      const targets = [
        ["checkbox", "checkbox"],
        ["file-input", "file"],
        ["range-field", "range"],
        ["color-field", "color"],
        ["submit-field", "submit"],
        ["radio-field", "radio"],
        ["date-field", "date"],
        ["month-field", "month"],
        ["week-field", "week"],
        ["time-field", "time"],
        ["datetime-field", "datetime-local"],
      ];
      for (const [id, type] of targets) {
        const before = await page.evaluate("document.querySelector('#" + id + "').value");
        assertEqual(
          await page.locator("#" + id).isEditable(),
          true,
          "an enabled " + type + " input reports isEditable true"
        );
        await assertRejects(
          () => page.locator("#" + id).fill("2026-12-25", { timeout: 3000 }),
          'Input of type "' + type + '" cannot be filled',
          "fill rejects an enabled " + type + " input"
        );
        assertEqual(
          await page.evaluate("document.querySelector('#" + id + "').value"),
          before,
          "fill preserves the " + type + " input value"
        );
        assertEqual(
          await page.evaluate("window.__nonTextProbe['" + id + "'].join(',')"),
          "",
          "fill fires no input or change events on an enabled " + type + " input"
        );
      }
    `),
  },
  {
    name: "fill writes a field its focus handler makes editable",
    body: homeCase(`
      await page.evaluate(\`(() => {
        const el = document.querySelector("#text-input");
        el.value = "locked";
        el.readOnly = true;
        el.addEventListener("focus", () => { el.readOnly = false; }, { once: true });
        return true;
      })()\`);

      assertEqual(
        await page.locator("#text-input").isEditable(),
        false,
        "the field is not editable before it is focused"
      );
      await page.locator("#text-input").fill("unlocked", { timeout: 3000 });
      assertEqual(
        await page.locator("#text-input").inputValue(),
        "unlocked",
        "fill writes a field unlocked by its own focus handler"
      );
    `),
  },
];
