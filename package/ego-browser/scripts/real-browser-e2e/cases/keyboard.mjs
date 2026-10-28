export function keyboardCase() {
  return `
    await useOrCreateTaskSpace(taskName);
    await resetHome();

    await fillInput("#text-input", "filled", { timeout: 3 });
    let value = await js("return document.querySelector('#text-input').value");
    assertEqual(value, "filled", "fillInput writes text");

    await fillInput("loc=css:#text-area", "area text", { timeout: 3 });
    const areaValue = await js("return document.querySelector('#text-area').value");
    assertEqual(areaValue, "area text", "fillInput supports textarea through loc=css");

    await js("const el = document.querySelector('#append-input'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); return el.value");
    await fillInput("#append-input", "-suffix", { clearFirst: false, timeout: 3 });
    const appended = await js("return document.querySelector('#append-input').value");
    assertEqual(appended, "base-suffix", "fillInput clearFirst:false preserves existing input value");

    await js("return document.querySelector('#text-input').focus()");
    await typeText(" text");
    value = await js("return document.querySelector('#text-input').value");
    assertEqual(value, "filled text", "typeText appends focused text");

    await fillInput("#text-input", "abc", { timeout: 3 });
    await js("const el = document.querySelector('#text-input'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); return el.value");
    await pressKey("Backspace");
    await waitForJsValue(
      "document.querySelector('#text-input').value",
      "ab",
      "pressKey Backspace edits the focused input",
      "window.__fixtureState.keyEvents"
    );
    const activeAfterPress = await js("return document.activeElement?.id || ''");
    assertEqual(activeAfterPress, "text-input", "pressKey keeps the focused input active");

    await dispatchKey("#text-input", "Escape", "keydown");
    let keys = await js("return window.__fixtureState.keys.join(',')");
    assertIncludes(keys, "Escape", "dispatchKey dispatches synthetic keyboard input");

    await fillInput("#text-input", "select me", { timeout: 3 });
    const selectAllModifier = process.platform === "darwin" ? 4 : 2;
    await pressKey("a", selectAllModifier);
    await typeText("selected");
    await waitForJsValue(
      "document.querySelector('#text-input').value",
      "selected",
      "pressKey supports platform select-all modifiers"
    );

    await uploadFile("#file-input", uploadPath);
    let fileName = await js("return Array.from(document.querySelector('#file-input').files).map((file) => file.name).join(',')");
    assertEqual(fileName, "fixture-upload.txt", "uploadFile attaches a single file");

    await uploadFile("#file-input", [uploadPath, uploadPathTwo]);
    fileName = await js("return Array.from(document.querySelector('#file-input').files).map((file) => file.name).join(',')");
    assertEqual(fileName, "fixture-upload.txt,fixture-upload-two.txt", "uploadFile attaches multiple files");

    await assertRejects(
      () => fillInput("#missing-input", "nope", { timeout: 0.2 }),
      "element not found",
      "fillInput reports missing elements"
    );
    await assertRejects(
      () => uploadFile("#missing-file-input", uploadPath),
      "Element not found",
      "uploadFile reports missing file inputs"
    );
    await assertRejects(
      () => dispatchKey("#missing-input", "Enter"),
      "Element not found",
      "dispatchKey reports missing targets"
    );

    /* contentEditable typing */
    cliLog(JSON.stringify({ keyboardStep: "contentEditable" }));
    await click("#rich-editor");
    await js("document.querySelector('#rich-editor').focus(); document.querySelector('#rich-editor').textContent = ''; return true;");
    await typeText("hello world");
    const editorText = await js("return document.querySelector('#rich-editor').textContent");
    assertIncludes(editorText, "hello world", "typeText inserts text into contentEditable element");

    /* rapid Backspace sequence */
    cliLog(JSON.stringify({ keyboardStep: "rapid backspace" }));
    await fillInput("#text-input", "test", { timeout: 3 });
    await js("const el = document.querySelector('#text-input'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); return el.value");
    await pressKey("Backspace");
    await pressKey("Backspace");
    await pressKey("Backspace");
    await waitForJsValue(
      "document.querySelector('#text-input').value",
      "t",
      "three rapid Backspaces delete three characters",
      "window.__fixtureState.keyEvents"
    );
  `;
}
