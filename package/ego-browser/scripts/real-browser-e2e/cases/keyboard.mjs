export function keyboardCase() {
  return `
    await taskSpaces.useOrCreate(taskName);
    await resetHome();

    await page.locator("#text-input").fill("filled", { timeout: 3000 });
    let value = await page.locator("#text-input").inputValue();
    assertEqual(value, "filled", "fill writes text");

    await page.locator("loc=css:#text-area").fill("area text", { timeout: 3000 });
    const areaValue = await page.locator("#text-area").inputValue();
    assertEqual(areaValue, "area text", "fill supports textarea through loc=css");

    await page.locator("#rich-editor").fill("rich text", { timeout: 3000 });
    const richValue = await page.locator("#rich-editor").textContent();
    assertIncludes(richValue, "rich text", "fill writes contentEditable text");
    assertIncludes(await page.locator("#rich-editor").textContent(), "rich text", "textContent reads element text");
    assertIncludes(await page.locator("#rich-editor").innerText(), "rich text", "innerText reads rendered text");
    assertEqual(await page.locator("#text-input").inputValue(), "filled", "inputValue reads form values");
    assertEqual(await page.locator("#text-input").getAttribute("id"), "text-input", "getAttribute reads attributes");
    assertEqual(await page.locator("#text-input").count(), 1, "count reads matching element count");
    assertIncludes((await page.locator("#rich-editor").allTextContents()).join(" "), "rich text", "allTextContents reads matching nodes");
    assertIncludes((await page.locator("#rich-editor").allInnerTexts()).join(" "), "rich text", "allInnerTexts reads matching nodes");
    const evaluatedTexts = await page.locator("#rich-editor").evaluateAll((elements, suffix) => elements.map((element) => element.textContent.trim() + suffix), "!");
    assertIncludes(evaluatedTexts.join(" "), "rich text!", "evaluateAll maps matching elements in page context");

    await page.locator("#append-input").evaluate((el) => {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      return el.value;
    });
    await page.locator("#append-input").fill("-suffix", { clearFirst: false, timeout: 3000 });
    const appended = await page.locator("#append-input").inputValue();
    assertEqual(appended, "base-suffix", "fill clearFirst:false preserves existing input value");

    await page.locator("#text-input").focus();
    await page.keyboard.insertText(" text");
    value = await page.locator("#text-input").inputValue();
    assertEqual(value, "filled text", "insertText appends focused text");

    await page.locator("#text-input").fill("", { timeout: 3000 });
    await page.locator("#text-input").pressSequentially("abc", { delay: 1 });
    value = await page.locator("#text-input").inputValue();
    assertEqual(value, "abc", "pressSequentially focuses a target and types characters");

    await page.locator("#text-input").fill("abc", { timeout: 3000 });
    await page.locator("#text-input").evaluate((el) => {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      return el.value;
    });
    await page.keyboard.press("Backspace");
    await waitForJsValue(
      "document.querySelector('#text-input').value",
      "ab",
      "press Backspace edits the focused input",
      "window.__fixtureState.keyEvents"
    );
    const activeAfterPress = await page.evaluate(() => document.activeElement?.id || '');
    assertEqual(activeAfterPress, "text-input", "press keeps the focused input active");

    await page.locator("#text-input").dispatchEvent("keydown", { key: "Escape" });
    let keys = await page.evaluate(() => window.__fixtureState.keys.join(','));
    assertIncludes(keys, "Escape", "dispatchEvent dispatches synthetic keyboard input");

    await page.locator("#dropdown").selectOption("beta");
    const dropdownValue = await page.locator("#dropdown").inputValue();
    assertEqual(dropdownValue, "beta", "selectOption selects by value");

    await page.locator("#checkbox").check();
    await waitForJsValue("window.__fixtureState.checkboxChecked", true, "check sets a checkbox");
    assertEqual(await page.locator("#checkbox").isChecked(), true, "isChecked reads checked state");
    await page.locator("#checkbox").uncheck();
    await waitForJsValue("window.__fixtureState.checkboxChecked", false, "uncheck clears a checkbox");
    assertEqual(await page.locator("#checkbox").isChecked(), false, "isChecked reads unchecked state");
    await page.locator("#checkbox").setChecked(true);
    await waitForJsValue("window.__fixtureState.checkboxChecked", true, "setChecked sets explicit state");
    await page.locator("#checkbox").setChecked(true);
    await waitForJsValue("window.__fixtureState.checkboxChecked", true, "setChecked is a no-op when the state already matches");

    /* A controlled input only advances on a real click; a property write is dropped. */
    await page.locator("#controlled-checkbox").check();
    await waitForJsValue("window.__fixtureState.controlledChecked", true, "check drives a controlled checkbox");
    await waitForJsValue("window.__fixtureState.controlledChanges", 1, "check fires exactly one controlled change");
    await page.locator("#controlled-checkbox").uncheck();
    await waitForJsValue("window.__fixtureState.controlledChecked", false, "uncheck clears a controlled checkbox");

    await page.locator("#controlled-radio-pro").setChecked(true);
    await waitForJsValue("window.__fixtureState.controlledPlan", "pro", "setChecked drives a controlled radio");
    assertEqual(await page.locator("#controlled-radio-basic").isChecked(), false, "controlled radio group keeps a single selection");
    await assertRejects(
      () => page.locator("#controlled-radio-pro").uncheck(),
      "cannot uncheck a radio",
      "uncheck rejects radio inputs"
    );

    await page.locator("#text-input").fill("select me", { timeout: 3000 });
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.insertText("selected");
    await waitForJsValue(
      "document.querySelector('#text-input').value",
      "selected",
      "press supports platform select-all modifiers"
    );

    await page.locator("#file-input").setInputFiles(uploadPath);
    let fileName = await page.locator("#file-input").evaluate((el) => Array.from(el.files).map((file) => file.name).join(","));
    assertEqual(fileName, "fixture-upload.txt", "setInputFiles attaches a single file");

    await page.locator("#file-input").setInputFiles([uploadPath, uploadPathTwo]);
    fileName = await page.locator("#file-input").evaluate((el) => Array.from(el.files).map((file) => file.name).join(","));
    assertEqual(fileName, "fixture-upload.txt,fixture-upload-two.txt", "setInputFiles attaches multiple files");

    await assertRejects(
      () => page.locator("#missing-input").fill("nope", { timeout: 200 }),
      "element not found",
      "fill reports missing elements"
    );
    await assertRejects(
      () => page.locator("#missing-file-input").setInputFiles(uploadPath),
      "Element not found",
      "setInputFiles reports missing file inputs"
    );
    await assertRejects(
      () => page.locator("#missing-input").dispatchEvent("keypress", { key: "Enter" }),
      "Element not found",
      "dispatchEvent reports missing targets"
    );

    /* contentEditable typing */
    console.log(JSON.stringify({ keyboardStep: "contentEditable" }));
    await page.locator("#rich-editor").click();
    await page.locator("#rich-editor").evaluate((el) => {
      el.focus();
      el.textContent = "";
      return true;
    });
    await page.keyboard.insertText("hello world");
    const editorText = await page.locator("#rich-editor").textContent();
    assertIncludes(editorText, "hello world", "insertText inserts text into contentEditable element");

    /* rapid Backspace sequence */
    console.log(JSON.stringify({ keyboardStep: "rapid backspace" }));
    await page.locator("#text-input").fill("test", { timeout: 3000 });
    await page.locator("#text-input").evaluate((el) => {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      return el.value;
    });
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await waitForJsValue(
      "document.querySelector('#text-input').value",
      "t",
      "three rapid Backspaces delete three characters",
      "window.__fixtureState.keyEvents"
    );
  `;
}
