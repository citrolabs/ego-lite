export function pageKeyboardInterfaceCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/?workflow=page-keyboard-interface");

    await page.evaluate(() => {
      const input = document.querySelector("#text-area");
      input.value = "";
      input.focus();
      window.__pageKeyboardContractEvents = [];
      for (const type of ["keydown", "keyup", "beforeinput", "input"]) {
        input.addEventListener(type, (event) => {
          window.__pageKeyboardContractEvents.push({
            type,
            key: event.key ?? null,
            code: event.code ?? null,
            location: event.location ?? null,
            repeat: event.repeat ?? false,
            altKey: event.altKey ?? false,
            ctrlKey: event.ctrlKey ?? false,
            metaKey: event.metaKey ?? false,
            shiftKey: event.shiftKey ?? false,
            data: event.data ?? null,
            trusted: event.isTrusted,
          });
        });
      }
    });
    await page.focus("#text-area");
    assertEqual(
      await page.evaluate("document.activeElement?.id"),
      "text-area",
      "page.focus addresses one selector"
    );

    await page.evaluate(() => {
      const wrapper = document.createElement("div");
      wrapper.id = "deep-focus-wrapper";
      wrapper.innerHTML =
        '<div><section><div><input id="deep-focus-input" /></div></section></div>';
      document.body.append(wrapper);

      const editor = document.createElement("div");
      editor.id = "focus-ancestor-editor";
      editor.contentEditable = "true";
      editor.innerHTML = '<span><em id="focus-descendant-text">editable</em></span>';
      document.body.append(editor);

      const slottedEditor = document.createElement("div");
      slottedEditor.id = "slotted-focus-host";
      slottedEditor.attachShadow({ mode: "open" }).innerHTML =
        '<button id="slotted-button"><slot></slot></button>';
      slottedEditor.innerHTML = '<span id="slotted-focus-text">slotted button</span>';
      document.body.append(slottedEditor);
    });
    await page.focus("#deep-focus-wrapper");
    assertEqual(
      await page.evaluate("document.activeElement?.id"),
      "deep-focus-input",
      "page.focus descends through any number of wrappers to one focusable target"
    );
    await page.focus("#focus-descendant-text");
    assertEqual(
      await page.evaluate("document.activeElement?.id"),
      "focus-ancestor-editor",
      "page.focus climbs through any number of wrappers to a focusable ancestor"
    );
    await page.focus("#slotted-focus-text");
    assertEqual(
      await page.evaluate(
        "document.querySelector('#slotted-focus-host').shadowRoot.activeElement?.id",
      ),
      "slotted-button",
      "page.focus follows the composed parent chain through a slot"
    );
    await page.focus("#text-area");

    // U+0020 through U+007E covers every printable ASCII character.
    const printable = Array.from(
      { length: 95 },
      (_, index) => String.fromCharCode(32 + index),
    ).join("");
    await page.keyboard.type(printable);
    assertEqual(
      await page.evaluate("document.querySelector('#text-area').value"),
      printable,
      "page.keyboard.type preserves every printable ASCII character"
    );

    const printableEvents = await page.evaluate("window.__pageKeyboardContractEvents");
    const printableDowns = printableEvents.filter((event) => event.type === "keydown");
    assertEqual(printableDowns.length, 95, "printable ASCII uses one keydown per character");
    assert(
      printableDowns.every((event) => event.trusted === true),
      "printable ASCII reaches the page as trusted keyboard input"
    );
    assertEqual(
      printableDowns
        .filter((event) => /^[0-9]$/.test(event.key))
        .map((event) => event.code)
        .join(","),
      Array.from({ length: 10 }, (_, digit) => "Digit" + digit).join(","),
      "digit characters use the main number row"
    );
    assertEqual(
      printableDowns.find((event) => event.key === ".")?.code,
      "Period",
      "period uses the main keyboard key"
    );
    assert(
      printableDowns.every((event) => !String(event.code).startsWith("Numpad")),
      "ordinary character typing never resolves to the numpad"
    );

    await page.evaluate(() => {
      const input = document.querySelector("#text-area");
      input.value = "";
      input.focus();
      window.__pageKeyboardContractEvents = [];
    });
    await page.keyboard.down("Shift");
    await page.keyboard.down("a");
    await page.keyboard.down("a");
    await page.keyboard.up("a");
    await page.keyboard.up("Shift");
    await page.keyboard.type("a");
    assertEqual(
      await page.evaluate("document.querySelector('#text-area').value"),
      "AAa",
      "down and up preserve then release modifier state"
    );
    const repeatedA = (await page.evaluate("window.__pageKeyboardContractEvents"))
      .filter((event) => event.type === "keydown" && event.code === "KeyA");
    assertEqual(repeatedA[0].repeat, false, "the first keydown is not a repeat");
    assertEqual(repeatedA[1].repeat, true, "a second down without up is a repeat");
    assertEqual(repeatedA[0].shiftKey, true, "held Shift modifies following keys");

    await page.evaluate(() => {
      const input = document.querySelector("#text-area");
      input.value = "abcdef";
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      window.__pageKeyboardContractEvents = [];
    });
    await page.keyboard.press(process.platform === "darwin" ? "META+A" : "CONTROL+A");
    const uppercaseModifierState = await page.evaluate(() => ({
      start: document.querySelector("#text-area").selectionStart,
      end: document.querySelector("#text-area").selectionEnd,
      keyA: window.__pageKeyboardContractEvents.find(
        (event) => event.type === "keydown" && event.code === "KeyA",
      ),
    }));
    assertEqual(uppercaseModifierState.start, 0, "uppercase modifier selects from the start");
    assertEqual(uppercaseModifierState.end, 6, "uppercase modifier selects through the end");
    assertEqual(
      process.platform === "darwin"
        ? uppercaseModifierState.keyA.metaKey
        : uppercaseModifierState.keyA.ctrlKey,
      true,
      "uppercase modifier produces the native platform shortcut",
    );
    assertEqual(
      uppercaseModifierState.keyA.trusted,
      true,
      "uppercase modifier keeps the shortcut trusted",
    );

    await page.evaluate(() => {
      const input = document.querySelector("#text-area");
      input.value = "";
      input.focus();
      window.__pageKeyboardContractEvents = [];
    });
    await page.press("#text-area", "ENTER");
    await page.keyboard.press("escape");
    await page.keyboard.press("ARROWDOWN");
    const caseInsensitiveNamedKeys = (
      await page.evaluate("window.__pageKeyboardContractEvents")
    ).filter((event) => event.type === "keydown");
    assertEqual(
      caseInsensitiveNamedKeys.map((event) => event.code).join(","),
      "Enter,Escape,ArrowDown",
      "named keys accept case-insensitive spellings through both Page APIs"
    );
    assert(
      caseInsensitiveNamedKeys.every((event) => event.trusted === true),
      "case-insensitive named keys remain trusted input"
    );

    await page.press("#text-area", "ControlOrMeta+A");
    await page.keyboard.type("replaced");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Delete");
    assertEqual(
      await page.evaluate("document.querySelector('#text-area').value"),
      "replac",
      "press drives native selection, arrow, Backspace, and Delete behavior"
    );
    await page.keyboard.press("Enter");
    await page.keyboard.type("next");
    assertEqual(
      await page.evaluate("document.querySelector('#text-area').value"),
      "replac\\nnext",
      "named Enter inserts a line break"
    );

    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type("A世界🙂");
    assertEqual(
      await page.evaluate("document.querySelector('#text-area').value"),
      "A世界🙂",
      "type falls back to native text insertion for non-US characters"
    );
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText("direct 世界🙂");
    assertEqual(
      await page.evaluate("document.querySelector('#text-area').value"),
      "direct 世界🙂",
      "insertText inserts one native text payload"
    );

    await page.press("#text-area", "ControlOrMeta+A");
    await page.keyboard.paste("pasted\\t世界\\nnext");
    assertEqual(
      await page.evaluate("document.querySelector('#text-area').value"),
      "pasted\\t世界\\nnext",
      "paste uses native clipboard input and preserves tabs and newlines"
    );

    await page.evaluate(() => {
      const editor = document.createElement("div");
      editor.id = "html-paste-editor";
      editor.contentEditable = "true";
      editor.style.cssText = "width:300px;min-height:80px;background:white";
      document.body.append(editor);
      editor.focus();
    });
    await page.keyboard.paste({
      text: "Name\\tStatus",
      html: "<table><tr><td>Name</td><td>Status</td></tr></table>",
    });
    const richPaste = await page.evaluate(() => ({
      table: Boolean(document.querySelector("#html-paste-editor table")),
      text: document.querySelector("#html-paste-editor").innerText,
    }));
    assertEqual(richPaste.table, true, "paste exposes HTML to rich editors");
    assertIncludes(richPaste.text, "Name", "HTML paste keeps its text visible");
    assertIncludes(richPaste.text, "Status", "HTML paste preserves every table cell");
    await page.focus("#text-area");

    await page.evaluate("window.__pageKeyboardContractEvents = []");
    await page.keyboard.press("Numpad1");
    const numpadEvent = (await page.evaluate("window.__pageKeyboardContractEvents"))
      .find((event) => event.type === "keydown");
    assertEqual(numpadEvent.code, "Numpad1", "explicit numpad keys retain their physical code");
    assertEqual(numpadEvent.location, 3, "explicit numpad keys retain keypad location");
    assertEqual(numpadEvent.trusted, true, "explicit numpad keys remain trusted input");

    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type("state");
    await assertRejects(
      () => page.keyboard.press("Shift+DefinitelyUnknown"),
      "Unknown key",
      "unknown keys reject"
    );
    await page.keyboard.type("a");
    assertEqual(
      await page.evaluate("document.querySelector('#text-area').value"),
      "statea",
      "a failed chord releases modifiers before the next action"
    );

    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("+");
    assertEqual(
      await page.evaluate("document.querySelector('#text-area').value"),
      "+",
      "a literal plus key is not mistaken for a chord separator"
    );

    await page.close();
  `;
}
