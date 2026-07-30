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
];
