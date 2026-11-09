export function v1V2ActionParityCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/?workflow=parity");

    await page.evaluate(() => {
      window.__parityEvents = [];
      for (const type of [
        "mousedown", "mouseup", "click", "keydown", "keyup",
        "beforeinput", "input", "change"
      ]) {
        document.addEventListener(type, (event) => {
          if (!window.__parityRecording) return;
          window.__parityEvents.push({
            type,
            target: event.target.id || event.target.tagName,
            trusted: event.isTrusted,
            key: event.key || "",
            inputType: event.inputType || "",
            data: event.data ?? null,
          });
        }, true);
      }
    });

    const beginRecording = () => page.evaluate(() => {
      window.__parityEvents = [];
      window.__parityRecording = true;
    });
    const finishRecording = () => page.evaluate(() => {
      window.__parityRecording = false;
      return window.__parityEvents;
    });

    await beginRecording();
    await click("#click-button");
    const legacyClickEvents = await finishRecording();
    await beginRecording();
    await page.click("#click-button");
    const pageClickEvents = await finishRecording();
    for (const events of [legacyClickEvents, pageClickEvents]) {
      const clickSequence = events
        .filter((event) => ["mousedown", "mouseup", "click"].includes(event.type))
        .map((event) => event.type);
      assertEqual(clickSequence.join(","), "mousedown,mouseup,click", "v1 and v2 click use the native pointer sequence");
      assert(
        events.filter((event) => event.type === "click").every((event) => event.trusted),
        "v1 and v2 click reach the site as trusted events"
      );
    }

    await page.evaluate(() => { document.querySelector("#text-input").value = "seed"; });
    await beginRecording();
    await fillInput("#text-input", "parity-value", { timeout: 3 });
    const legacyFillEvents = await finishRecording();
    const legacyValue = await page.evaluate("document.querySelector('#text-input').value");

    await page.evaluate(() => { document.querySelector("#text-input").value = "seed"; });
    await beginRecording();
    await page.fill("#text-input", "parity-value");
    const pageFillEvents = await finishRecording();
    const pageValue = await page.evaluate("document.querySelector('#text-input').value");
    assertEqual(legacyValue, "parity-value", "v1 fill keeps its user-visible result");
    assertEqual(pageValue, legacyValue, "v2 fill matches the v1 user-visible value");
    assert(
      legacyFillEvents.some((event) => event.type === "input"),
      "v1 fill still emits its compatibility input events"
    );
    assert(
      pageFillEvents.some((event) => event.type === "input" && event.trusted),
      "v2 fill emits native input"
    );
    assert(
      pageFillEvents
        .filter((event) => event.type === "input")
        .every((event) => event.trusted),
      "v2 fill does not add synthetic duplicate input events"
    );

    const prepareBackspace = () => page.evaluate(() => {
      const input = document.querySelector("#text-input");
      input.value = "abc";
      input.focus();
      input.setSelectionRange(3, 3);
      window.__parityEvents = [];
      window.__parityRecording = true;
    });
    await prepareBackspace();
    await pressKey("Backspace");
    const legacyKeyEvents = await finishRecording();
    const legacyBackspaceValue = await page.evaluate("document.querySelector('#text-input').value");
    await prepareBackspace();
    await page.keyboard.press("Backspace");
    const pageKeyEvents = await finishRecording();
    const pageBackspaceValue = await page.evaluate("document.querySelector('#text-input').value");
    assertEqual(legacyBackspaceValue, "ab", "v1 Backspace keeps its editing behavior");
    assertEqual(pageBackspaceValue, legacyBackspaceValue, "v2 Backspace matches the v1 result");
    for (const events of [legacyKeyEvents, pageKeyEvents]) {
      assert(
        events.some((event) => event.type === "keydown" && event.key === "Backspace" && event.trusted),
        "v1 and v2 Backspace dispatch a trusted keydown"
      );
    }

    await page.close();
  `;
}

export function portableKeyboardWorkflowCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/?workflow=keyboard");

    await page.fill("#text-input", "portable clipboard");
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("ControlOrMeta+C");
    await page.evaluate(() => {
      const target = document.querySelector("#append-input");
      target.value = "";
      target.focus();
    });
    await page.keyboard.press("ControlOrMeta+V");
    assertEqual(
      await page.evaluate("document.querySelector('#append-input').value"),
      "portable clipboard",
      "ControlOrMeta copy and paste use the current platform shortcut"
    );
    await page.keyboard.press("ControlOrMeta+Z");
    assertEqual(
      await page.evaluate("document.querySelector('#append-input').value"),
      "",
      "ControlOrMeta undo reverts the native paste"
    );

    const textLength = await page.evaluate(() => {
      const area = document.querySelector("#text-area");
      area.value = Array.from({ length: 40 }, (_, index) => "line " + index).join("\\n");
      area.focus();
      area.setSelectionRange(Math.floor(area.value.length / 2), Math.floor(area.value.length / 2));
      return area.value.length;
    });
    const toEnd = process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End";
    const toStart = process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home";
    await page.keyboard.press(toEnd);
    assertEqual(
      await page.evaluate("document.querySelector('#text-area').selectionStart"),
      textLength,
      "the host-platform document-end shortcut reaches the end"
    );
    await page.keyboard.press(toStart);
    assertEqual(
      await page.evaluate("document.querySelector('#text-area').selectionStart"),
      0,
      "the host-platform document-start shortcut reaches the beginning"
    );

    await page.close();
  `;
}

export function pureCdpWorkflowCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, "about:blank");
    const destination = baseUrl + "/?workflow=cdp";

    await page.cdp("Page.navigate", { url: destination }, { timeout: 5_000 });
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await page.cdp(
        "Runtime.evaluate",
        { expression: "document.readyState", returnByValue: true },
        { timeout: 2_000 }
      );
      if (response.result.value === "complete") {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert(ready, "pure CDP navigation reaches a complete document");

    const rectResponse = await page.cdp(
      "Runtime.evaluate",
      {
        expression:
          "(() => {" +
          "const rect = document.querySelector('#click-button').getBoundingClientRect();" +
          "return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };" +
          "})()",
        returnByValue: true,
      },
      { timeout: 2_000 }
    );
    const point = rectResponse.result.value;
    await page.cdp("Input.dispatchMouseEvent", {
      type: "mouseMoved", x: point.x, y: point.y, button: "none", buttons: 0,
    });
    await page.cdp("Input.dispatchMouseEvent", {
      type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1,
    });
    await page.cdp("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1,
    });
    const stateResponse = await page.cdp(
      "Runtime.evaluate",
      {
        expression:
          "({ clicks: window.__fixtureState.clicks," +
          "trusted: window.__fixtureState.pointerEvents.findLast(" +
          "event => event.type === 'click')?.trusted })",
        returnByValue: true,
      },
      { timeout: 2_000 }
    );
    assertEqual(stateResponse.result.value.clicks, 1, "pure CDP input activates the fixture action");
    assertEqual(stateResponse.result.value.trusted, true, "pure CDP input remains trusted");

    const concurrent = await Promise.all([
      page.cdp("Runtime.evaluate", { expression: "21 * 2", returnByValue: true }),
      page.cdp("Runtime.evaluate", { expression: "6 * 7", returnByValue: true }),
    ]);
    assertEqual(concurrent[0].result.value, 42, "the first concurrent CDP Promise keeps its response");
    assertEqual(concurrent[1].result.value, 42, "the second concurrent CDP Promise keeps its response");

    const screenshot = await page.cdp("Page.captureScreenshot", { format: "png" }, { timeout: 5_000 });
    assert(screenshot.data.length > 100, "pure CDP capture returns PNG data");
    await assertRejects(
      () => page.cdp(
        "Runtime.evaluate",
        {
          expression: "new Promise(resolve => setTimeout(() => resolve('late'), 1000))",
          awaitPromise: true,
        },
        { timeout: 50 }
      ),
      "CDP request timed out: Runtime.evaluate",
      "pure CDP Promise enforces its timeout"
    );

    await page.close();
  `;
}

export function snapshotWorkflowCase() {
  return `
    const task = await taskSpace(taskName);
    const first = await newPageAt(task, baseUrl + "/?workflow=snapshot-a");
    const second = await newPageAt(task, baseUrl + "/?workflow=snapshot-b");

    const firstSnapshot = await first.snapshot();
    const secondSnapshot = await second.snapshot();
    const refFor = (snapshot) => {
      const line = snapshot.split("\\n").find((entry) => entry.includes("Increment counter"));
      const match = line && line.match(/\\[ref=([0-9]+)/);
      if (!match) throw new Error("snapshot workflow did not expose the click ref");
      return "@" + match[1];
    };
    const firstRef = refFor(firstSnapshot);
    const secondRef = refFor(secondSnapshot);
    await first.click(firstRef);
    assertEqual(await first.evaluate("window.__fixtureState.clicks"), 1, "the first snapshot ref acts on Page A");
    assertEqual(await second.evaluate("window.__fixtureState.clicks"), 0, "the Page A ref does not affect Page B");
    const refreshedSecondRef = refFor(await second.snapshot());
    assertEqual(refreshedSecondRef, secondRef, "a fresh Page B snapshot can reuse the native ref id");
    await second.click(refreshedSecondRef);
    assertEqual(await second.evaluate("window.__fixtureState.clicks"), 1, "the second snapshot ref acts on Page B");

    const navigationRef = refFor(await first.snapshot());
    await first.goto(baseUrl + "/nav-target?workflow=snapshot-navigation");
    await assertRejects(
      () => first.click(navigationRef),
      "Stale ref",
      "navigation invalidates refs from the previous document"
    );

    await first.close();
    await second.close();
  `;
}

export function visualWorkflowCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/visual");
    const snapshot = await page.snapshot();
    assert(
      !snapshot.includes("CLICK") && !snapshot.includes("DONE"),
      "the canvas-only control is intentionally absent from the semantic snapshot"
    );

    const beforePath = join(artifactDir, "visual-before.png");
    const afterPath = join(artifactDir, "visual-after.png");
    await page.screenshot({ path: beforePath, fullPage: false });
    await page.mouse.move(160, 150);
    await page.mouse.click(160, 150);
    await page.screenshot({ path: afterPath, fullPage: false });

    const before = await readFile(beforePath);
    const after = await readFile(afterPath);
    assert(before.length > 100 && after.length > 100, "visual workflow captures both screenshots");
    assert(!before.equals(after), "the coordinate action changes the rendered screenshot");
    const visualState = await page.evaluate(() => ({
      clicks: window.__visualClicks,
      trusted: window.__visualTrusted,
    }));
    assertEqual(visualState.clicks, 1, "the screenshot-derived coordinate activates the canvas target");
    assertEqual(visualState.trusted, true, "the visual coordinate action uses trusted mouse input");

    await page.close();
  `;
}
