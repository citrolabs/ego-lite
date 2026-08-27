export function pageActionabilityCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/?page-actionability=" + Date.now());

    try {
    await page.evaluate(() => {
      document.body.innerHTML = \
        '<style>' +
        '  .action-row { display: flex; gap: 12px; margin: 12px; min-height: 40px; }' +
        '  .drag-box { width: 80px; height: 40px; background: #ddd; }' +
        '</style>' +
        '<div class="action-row">' +
        '  <button id="nested-disabled" disabled><span>Nested disabled action</span></button>' +
        '  <button id="native-disabled" disabled aria-disabled="false">Native disabled</button>' +
        '</div>' +
        '<div id="aria-container" aria-disabled="true" class="action-row">' +
        '  <button id="aria-blocked">ARIA blocked</button>' +
        '  <button id="aria-override" aria-disabled="false">ARIA override</button>' +
        '  <input id="aria-fill-blocked">' +
        '</div>' +
        '<div class="action-row">' +
        '  <button id="aria-owner" aria-disabled="true"><span aria-disabled="false">ARIA owner action</span></button>' +
        '  <div id="unsupported-aria" aria-disabled="true">Unsupported ARIA action</div>' +
        '</div>' +
        '<fieldset id="disabled-fieldset" disabled>' +
        '  <legend><button id="legend-action">Legend action</button></legend>' +
        '  <input id="fieldset-input">' +
        '</fieldset>' +
        '<div class="action-row">' +
        '  <button class="duplicate-action" disabled>Disabled duplicate</button>' +
        '  <button class="duplicate-action" id="enabled-duplicate">Enabled duplicate</button>' +
        '  <input class="duplicate-fill" disabled>' +
        '  <input class="duplicate-fill" id="enabled-fill">' +
        '</div>' +
        '<div class="action-row">' +
        '  <button id="disabled-hover" disabled>Hover disabled</button>' +
        '  <div id="disabled-drag-source" class="drag-box" role="button" aria-disabled="true">Drag source</div>' +
        '  <div id="disabled-drag-target" class="drag-box" role="button" aria-disabled="true">Drag target</div>' +
        '</div>' +
        '<div id="force-wrapper" class="action-row" style="position:relative;width:180px">' +
        '  <button id="force-target" style="width:180px;height:40px">Force target</button>' +
        '  <div id="force-overlay" style="position:absolute;inset:0;background:rgba(0,0,0,.1)"></div>' +
        '</div>' +
        '<div class="action-row">' +
        '  <select id="disabled-select" disabled><option value="value">Value</option></select>' +
        '  <select id="option-states">' +
        '    <option value="normal">Normal</option>' +
        '    <option value="disabled" disabled>Disabled option</option>' +
        '    <option value="aria-disabled" aria-disabled="true">ARIA disabled option</option>' +
        '    <optgroup label="Disabled group" disabled><option value="grouped">Grouped option</option></optgroup>' +
        '  </select>' +
        '</div>';

      window.__actionability = {
        nestedClicks: 0,
        ariaBlockedClicks: 0,
        ariaOverrideClicks: 0,
        ariaOwnerClicks: 0,
        unsupportedAriaClicks: 0,
        duplicateClicks: 0,
        fieldsetInputBeforeEnabled: 0,
        ariaInputBeforeEnabled: 0,
        hoverEvents: 0,
        hoverTrusted: false,
        dragDown: 0,
        dragUp: 0,
        dragTrusted: false,
        forceTargetClicks: 0,
        forceOverlayClicks: 0,
        fieldsetEnabled: false,
        ariaEnabled: false,
      };
      const state = window.__actionability;
      document.querySelector("#nested-disabled").addEventListener("click", () => state.nestedClicks++);
      document.querySelector("#aria-blocked").addEventListener("click", () => state.ariaBlockedClicks++);
      document.querySelector("#aria-override").addEventListener("click", () => state.ariaOverrideClicks++);
      document.querySelector("#aria-owner").addEventListener("click", () => state.ariaOwnerClicks++);
      document.querySelector("#unsupported-aria").addEventListener("click", () => state.unsupportedAriaClicks++);
      document.querySelector("#enabled-duplicate").addEventListener("click", () => state.duplicateClicks++);
      document.querySelector("#fieldset-input").addEventListener("input", () => {
        if (!state.fieldsetEnabled) state.fieldsetInputBeforeEnabled++;
      });
      document.querySelector("#aria-fill-blocked").addEventListener("input", () => {
        if (!state.ariaEnabled) state.ariaInputBeforeEnabled++;
      });
      document.querySelector("#disabled-hover").addEventListener("mouseover", (event) => {
        state.hoverEvents++;
        state.hoverTrusted ||= event.isTrusted;
      });
      document.querySelector("#disabled-drag-source").addEventListener("mousedown", (event) => {
        state.dragDown++;
        state.dragTrusted ||= event.isTrusted;
      });
      document.querySelector("#disabled-drag-target").addEventListener("mouseup", (event) => {
        state.dragUp++;
        state.dragTrusted ||= event.isTrusted;
      });
      document.querySelector("#force-target").addEventListener("click", () => {
        state.forceTargetClicks++;
      });
      document.querySelector("#force-overlay").addEventListener("click", () => {
        state.forceOverlayClicks++;
      });

      const shadowHost = document.createElement("div");
      shadowHost.id = "shadow-action-host";
      shadowHost.setAttribute("aria-disabled", "true");
      shadowHost.attachShadow({ mode: "open" }).innerHTML =
        '<div class="action-row">' +
        '  <button id="shadow-blocked">Shadow blocked</button>' +
        '  <button id="shadow-override" aria-disabled="false">Shadow override</button>' +
        '  <input id="shadow-fill-blocked">' +
        '</div>';
      document.body.append(shadowHost);
      state.shadowBlockedClicks = 0;
      state.shadowOverrideClicks = 0;
      shadowHost.shadowRoot.querySelector("#shadow-blocked").addEventListener("click", () => {
        state.shadowBlockedClicks++;
      });
      shadowHost.shadowRoot.querySelector("#shadow-override").addEventListener("click", () => {
        state.shadowOverrideClicks++;
      });
    });

    await assertRejectsAny(
      () => page.click('text="Nested disabled action"', { timeout: 150 }),
      "click rejects a disabled control reached through its child"
    );
    assertEqual(
      await page.evaluate("window.__actionability.nestedClicks"),
      0,
      "a disabled nested control receives no click"
    );

    const snapshot = await page.snapshot({ scope: "full_page" });
    const nestedLines = snapshot.split("\\n");
    const nestedTextIndex = nestedLines.findIndex((line) =>
      line.includes("Nested disabled action")
    );
    const nestedRef =
      nestedTextIndex >= 0 &&
      nestedLines
        .slice(0, nestedTextIndex + 1)
        .reverse()
        .map((line) => line.match(/\\[ref=([0-9]+)/))
        .find(Boolean);
    assert(nestedRef, "snapshot exposes the disabled button ref");
    await assertRejectsAny(
      () => page.click("@" + nestedRef[1], { timeout: 150 }),
      "the final action check also protects the ref path"
    );

    await page.evaluate(() => {
      setTimeout(() => {
        document.querySelector("#nested-disabled").disabled = false;
      }, 100);
    });
    await page.click('text="Nested disabled action"', { timeout: 1_000 });
    assertEqual(
      await page.evaluate("window.__actionability.nestedClicks"),
      1,
      "click retries until the nested control becomes enabled"
    );

    await assertRejectsAny(
      () => page.click("#native-disabled", { force: true, timeout: 150 }),
      "force does not override native disabled state or aria-disabled=false"
    );
    await assertRejectsAny(
      () => page.click("#aria-blocked", { timeout: 150 }),
      "aria-disabled is inherited from an ordinary ancestor"
    );
    await page.click("#aria-override");
    assertEqual(
      await page.evaluate("window.__actionability.ariaOverrideClicks"),
      1,
      "a nearer aria-disabled=false stops inherited ARIA disabled state"
    );
    await assertRejectsAny(
      () => page.click('text="ARIA owner action"', { timeout: 150 }),
      "aria-disabled=false on button content does not override the button"
    );
    assertEqual(
      await page.evaluate("window.__actionability.ariaOwnerClicks"),
      0,
      "the ARIA-disabled action owner receives no click"
    );
    await page.click("#unsupported-aria");
    assertEqual(
      await page.evaluate("window.__actionability.unsupportedAriaClicks"),
      1,
      "aria-disabled does not disable an element without a supporting role"
    );

    await assertRejectsAny(
      () => page.click("#shadow-blocked", { timeout: 150 }),
      "aria-disabled crosses an open shadow root"
    );
    await page.click("#shadow-override");
    assertEqual(
      await page.evaluate("window.__actionability.shadowOverrideClicks"),
      1,
      "aria-disabled=false overrides a shadow host"
    );
    await assertRejectsAny(
      () => page.fill("#shadow-fill-blocked", "must not appear", { timeout: 150 }),
      "fill uses the same shadow-aware enabled state"
    );
    assertEqual(
      await page.evaluate("document.querySelector('#shadow-action-host').shadowRoot.querySelector('#shadow-fill-blocked').value"),
      "",
      "blocked shadow fill dispatches no input"
    );

    await page.click("#legend-action");
    await assertRejectsAny(
      () => page.fill("#fieldset-input", "early", { timeout: 150 }),
      "a disabled fieldset blocks controls outside its first legend"
    );
    assertEqual(
      await page.evaluate("document.querySelector('#fieldset-input').value"),
      "",
      "fieldset-disabled fill leaves the input unchanged"
    );
    await page.evaluate(() => {
      setTimeout(() => {
        window.__actionability.fieldsetEnabled = true;
        document.querySelector("#disabled-fieldset").disabled = false;
      }, 100);
    });
    await page.fill("#fieldset-input", "ready", { timeout: 1_000 });
    assertEqual(
      await page.evaluate("document.querySelector('#fieldset-input').value"),
      "ready",
      "fill retries until the fieldset becomes enabled"
    );
    assertEqual(
      await page.evaluate("window.__actionability.fieldsetInputBeforeEnabled"),
      0,
      "fill emits no input before the fieldset becomes enabled"
    );

    await assertRejectsAny(
      () => page.fill("#aria-fill-blocked", "early", { timeout: 150 }),
      "fill inherits aria-disabled from an ordinary ancestor"
    );
    assertEqual(
      await page.evaluate("document.querySelector('#aria-fill-blocked').value"),
      "",
      "ARIA-disabled fill leaves the input unchanged"
    );
    await page.evaluate(() => {
      setTimeout(() => {
        window.__actionability.ariaEnabled = true;
        document.querySelector("#aria-fill-blocked").setAttribute("aria-disabled", "false");
      }, 100);
    });
    await page.fill("#aria-fill-blocked", "ready", { timeout: 1_000 });
    assertEqual(
      await page.evaluate("window.__actionability.ariaInputBeforeEnabled"),
      0,
      "fill emits no input before ARIA state becomes enabled"
    );

    await page.click(".duplicate-action");
    assertEqual(
      await page.evaluate("window.__actionability.duplicateClicks"),
      1,
      "click chooses the only enabled duplicate"
    );
    await page.fill(".duplicate-fill", "usable");
    assertEqual(
      await page.evaluate("document.querySelector('#enabled-fill').value"),
      "usable",
      "fill chooses the only enabled duplicate"
    );
    await assertRejects(
      () => page.hover(".duplicate-action", { timeout: 150 }),
      "matched 2",
      "hover treats disabled and enabled duplicates as equally usable"
    );

    await page.hover("#disabled-hover");
    const hoverState = await page.evaluate(() => ({
      count: window.__actionability.hoverEvents,
      trusted: window.__actionability.hoverTrusted,
    }));
    assert(hoverState.count > 0, "hover reaches a disabled element");
    assertEqual(hoverState.trusted, true, "disabled hover still uses trusted input");

    await page.dragAndDrop("#disabled-drag-source", "#disabled-drag-target");
    const dragState = await page.evaluate(() => ({
      down: window.__actionability.dragDown,
      up: window.__actionability.dragUp,
      trusted: window.__actionability.dragTrusted,
    }));
    assert(dragState.down > 0, "drag starts on an aria-disabled source");
    assert(dragState.up > 0, "drag ends on an aria-disabled target");
    assertEqual(dragState.trusted, true, "disabled drag still uses trusted input");

    await page.click("#force-target", { force: true });
    const forceState = await page.evaluate(() => ({
      target: window.__actionability.forceTargetClicks,
      overlay: window.__actionability.forceOverlayClicks,
    }));
    assertEqual(forceState.target, 0, "force does not synthesize a target click");
    assertEqual(forceState.overlay, 1, "force bypasses only pointer interception");

    await assertRejectsAny(
      () => page.selectOption("#disabled-select", "value", { timeout: 150 }),
      "selectOption requires the select itself to be enabled"
    );
    assertEqual(
      JSON.stringify(await page.selectOption("#option-states", "disabled")),
      JSON.stringify(["disabled"]),
      "selectOption follows Playwright and can select a disabled option"
    );
    assertEqual(
      JSON.stringify(await page.selectOption("#option-states", "aria-disabled")),
      JSON.stringify(["aria-disabled"]),
      "option ARIA state does not disable an enabled select"
    );
    assertEqual(
      JSON.stringify(await page.selectOption("#option-states", "grouped")),
      JSON.stringify(["grouped"]),
      "selectOption can programmatically select an option in a disabled optgroup"
    );
    } finally {
      await page.close();
    }
  `;
}
