export function keyboardRegressionCase() {
  return `
    await useOrCreateTaskSpace(taskName);
    await resetHome();

    /* Issue 1: fillInput on type=email replaces the prior value without crashing.
       Before the fix, clearFirst's setSelectionRange threw InvalidStateError on
       type=email/number inputs and the whole fillInput rejected, writing nothing. */
    await js("document.querySelector('#email-input').value = 'old@example.com'; window.__fixtureState.valueEvents['email-input'] = []; return true;");
    await fillInput("#email-input", "marcus.hale@example.com", { timeout: 3 });
    const emailValue = await js("return document.querySelector('#email-input').value");
    assertEqual(emailValue, "marcus.hale@example.com", "fillInput replaces type=email value (Issue 1)");
    const emailEvents = await js("return (window.__fixtureState.valueEvents['email-input'] || []).join(',')");
    assertIncludes(emailEvents, "input", "fillInput fires input on type=email (Issue 1)");
    assertIncludes(emailEvents, "change", "fillInput fires change on type=email (Issue 1)");

    /* Issue 1: same setSelectionRange crash on type=number. */
    await js("document.querySelector('#number-input').value = '123'; return true;");
    await fillInput("#number-input", "456", { timeout: 3 });
    const numberValue = await js("return document.querySelector('#number-input').value");
    assertEqual(numberValue, "456", "fillInput replaces type=number value (Issue 1)");

    /* Issue 2: non-bare selectors resolve through the unified element-resolver.
       Before the fix, the CSS path fed 'xpath=...' straight into querySelector
       and threw SyntaxError. */
    await fillInput('xpath=//input[@id="text-input"]', "via-xpath", { timeout: 3 });
    const xpathValue = await js("return document.querySelector('#text-input').value");
    assertEqual(xpathValue, "via-xpath", "fillInput resolves xpath= selector (Issue 2)");

    /* Issue 2: dispatchKey shares the same resolver path. */
    await js("window.__fixtureState.keys = []; return true;");
    await dispatchKey('xpath=//input[@id="text-input"]', "Enter", "keydown");
    const keys = await js("return window.__fixtureState.keys.join(',')");
    assertIncludes(keys, "Enter", "dispatchKey resolves xpath= selector (Issue 2)");

    /* Issue 2: uploadFile shares the same resolver path (the pilot covered
       fillInput/dispatchKey but left uploadFile out). */
    await uploadFile('xpath=//input[@id="file-input"]', uploadPath);
    const xpathFile = await js("return Array.from(document.querySelector('#file-input').files).map((file) => file.name).join(',')");
    assertEqual(xpathFile, "fixture-upload.txt", "uploadFile resolves xpath= selector (Issue 2)");

    /* fillInput must persist on a react-style controlled input, whose native
       value-setter writeback fights synthetic value changes. */
    await fillInput("#controlled-input", "hello-react", { timeout: 3 });
    const controlledValue = await js("return document.querySelector('#controlled-input').value");
    assertEqual(controlledValue, "hello-react", "fillInput persists value on a react-style controlled input");
    const controlledState = await js("return document.querySelector('#controlled-state').textContent");
    assert(controlledState.startsWith("hello-react"), "controlled state mirror reflects the filled value");
  `;
}
