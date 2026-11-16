// CITRO-4993: an embedded code editor (like the MDN example editors) keeps
// its own caret at offset 0 and ignores the DOM selection until a real
// pointer activation. page.fill must still replace the old code, on first
// load, after a reset and once the editor has been activated.
export function pageFillCodeEditorCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/?page-fill-code-editor=" + Date.now());
    const original = "const date = new Date(Date.UTC(2020, 11, 20));\\n// old example";
    const next = "console.log('next');";

    try {
      await page.evaluate((initialText) => {
        document.body.innerHTML =
          '<div id="editor" contenteditable="true" spellcheck="false"' +
          ' style="white-space:pre;font-family:monospace;min-height:80px;margin:12px;border:1px solid #888"></div>' +
          '<button id="reset">Reset</button>' +
          '<button id="elsewhere">Elsewhere</button>';
        const editor = document.querySelector("#editor");
        const state = { text: initialText, activated: false, inserts: 0 };
        window.__editor = state;
        const render = () => {
          editor.textContent = state.text;
        };
        const offsetOf = (container, offset) => {
          const range = document.createRange();
          range.setStart(editor, 0);
          range.setEnd(container, offset);
          return range.toString().length;
        };
        // Like CodeMirror, the editor only trusts the DOM selection once a
        // pointer has activated it; before that it inserts at its own caret.
        editor.addEventListener("mousedown", () => {
          state.activated = true;
        });
        editor.addEventListener("beforeinput", (event) => {
          event.preventDefault();
          if (event.inputType !== "insertText" && event.inputType !== "insertReplacementText") return;
          const data = event.data ?? event.dataTransfer?.getData("text/plain") ?? "";
          state.inserts += 1;
          let start = 0;
          let end = 0;
          const selection = getSelection();
          if (state.activated && selection && selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            if (editor.contains(range.startContainer) && editor.contains(range.endContainer)) {
              start = offsetOf(range.startContainer, range.startOffset);
              end = offsetOf(range.endContainer, range.endOffset);
            }
          }
          state.text = state.text.slice(0, start) + data + state.text.slice(end);
          render();
        });
        document.querySelector("#reset").addEventListener("click", () => {
          state.text = initialText;
          state.activated = false;
          state.inserts = 0;
          render();
        });
        render();
      }, original);
      const editorState = () => page.evaluate(() => ({ ...window.__editor }));

      // First load: the editor was never clicked or focused.
      assertEqual((await editorState()).activated, false, "the editor starts inactive");
      await page.fill("#editor", next, { clearFirst: true });
      let state = await editorState();
      assertEqual(state.text, next, "fill replaces the code on first load instead of prepending");
      assertEqual(state.inserts, 2, "the prepended first attempt is retried after a pointer activation");
      assertEqual(
        await page.evaluate(() => document.querySelector("#editor").textContent),
        next,
        "the rendered editor shows only the new code on first load"
      );

      // After Reset: the old example is back and the editor is inactive again.
      await page.click("#reset");
      state = await editorState();
      assertEqual(state.text, original, "reset restores the original example");
      assertEqual(state.activated, false, "reset deactivates the editor");
      await page.fill("#editor", next);
      state = await editorState();
      assertEqual(state.text, next, "fill replaces the code after a reset");

      // Already activated: the editor honours the selection on the first try.
      await page.click("#reset");
      await page.click("#editor");
      await page.click("#elsewhere");
      assertEqual((await editorState()).activated, true, "clicking activates the editor");
      await page.fill("#editor", next);
      state = await editorState();
      assertEqual(state.text, next, "fill replaces the code in an activated editor");
      assertEqual(state.inserts, 1, "an activated editor needs no retry");
    } finally {
      await page.close();
    }
  `;
}
