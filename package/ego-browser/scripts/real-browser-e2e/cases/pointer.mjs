export function pointerCase() {
  return `
    await useOrCreateTaskSpace(taskName);
    await resetHome();
    cliLog(JSON.stringify({ pointerStep: "ready" }));

    assertEqual(await js("return window.__fixtureState.clicks"), 0, "click fixture starts at zero");
    cliLog(JSON.stringify({ pointerStep: "click css" }));
    await click("#click-button", { label: "click helper e2e" });
    await waitForJsValue(
      "window.__fixtureState.clicks",
      1,
      "click css fires a page click",
      "window.__fixtureState.pointerEvents"
    );
    cliLog(JSON.stringify({ pointerStep: "click selector offset" }));
    await click({ selector: "#click-button", x: 12, y: 12 });
    await waitForJsValue("window.__fixtureState.clicks", 2, "click selector offset fires a page click");
    cliLog(JSON.stringify({ pointerStep: "click locators" }));
    await click("loc=css:#click-button");
    await waitForJsValue("window.__fixtureState.clicks", 3, "click loc css fires a page click");
    await click("loc=role:button[name='Increment counter']");
    await waitForJsValue("window.__fixtureState.clicks", 4, "click role locator fires a page click");
    await click("xpath=//*[@id='click-button']");
    await waitForJsValue("window.__fixtureState.clicks", 5, "click xpath fires a page click");
    const buttonCenter = await elementCenter("#click-button");
    await click([buttonCenter.x, buttonCenter.y]);
    await waitForJsValue("window.__fixtureState.clicks", 6, "click tuple coordinates fires a page click");
    await click({ x: buttonCenter.x, y: buttonCenter.y });
    await waitForJsValue("window.__fixtureState.clicks", 7, "click object coordinates fires a page click");
    await click("#click-button", { clicks: 2 });
    await waitForJsValue("window.__fixtureState.clicks", 8, "click count option fires a page click");
    await waitForJsValue("window.__fixtureState.lastClickDetail", 2, "click count option sets DOM click detail");
    const doubleClicksBefore = await js("return window.__fixtureState.doubleClicks");
    await doubleClick("#click-button");
    await waitForJsValue("window.__fixtureState.clicks", 9, "doubleClick fires a page click");
    await waitForJsValue("window.__fixtureState.lastClickDetail", 2, "doubleClick sets DOM click detail");
    await waitForJsCondition(
      "window.__fixtureState.doubleClicks > " + JSON.stringify(doubleClicksBefore),
      "doubleClick fires a DOM dblclick"
    );
    cliLog(JSON.stringify({ pointerStep: "hover" }));
    await wait(0.1);
    const hitElement = await js(
      "return document.elementFromPoint(" +
        JSON.stringify(buttonCenter.x) +
        "," +
        JSON.stringify(buttonCenter.y) +
        ")?.id || document.elementFromPoint(" +
        JSON.stringify(buttonCenter.x) +
        "," +
        JSON.stringify(buttonCenter.y) +
        ")?.className || ''"
    );
    assertEqual(hitElement, "click-button", "pointer coordinates resolve to the intended button");

    await js("window.__fixtureState.hovered = false; return true;");
    await hover("#hover-zone");
    await waitForJsValue("window.__fixtureState.hovered", true, "hover css fires mouseover");
    await js("window.__fixtureState.hovered = false; return true;");
    await hover({ selector: "#hover-zone" });
    await waitForJsValue("window.__fixtureState.hovered", true, "hover selector object fires mouseover");

    cliLog(JSON.stringify({ pointerStep: "drag" }));
    await js("window.__fixtureState.dragged = false; return true;");
    await dragMouse(["#drag-source", "#drag-target"], { delayMs: 10 });
    await waitForJsValue("window.__fixtureState.dragged", true, "dragMouse fires drag source and target events");

    cliLog(JSON.stringify({ pointerStep: "nested scroll" }));
    await js(
      "const inner = document.querySelector('#inner-scroll');" +
        "inner.scrollTop = 0;" +
        "inner.scrollIntoView({ block: 'center', inline: 'nearest' });" +
        "return true;"
    );
    await wait(0.1);
    const innerCenter = await elementCenter("#inner-scroll");
    const innerHit = await js(
      "const el = document.elementFromPoint(" +
        JSON.stringify(innerCenter.x) +
        "," +
        JSON.stringify(innerCenter.y) +
        ");" +
        "return el?.closest?.('#inner-scroll')?.id || el?.id || '';"
    );
    assertEqual(innerHit, "inner-scroll", "nested scroll container is under the wheel target");
    await scroll(innerCenter.x, innerCenter.y, { dy: 350 });
    await waitForJsCondition(
      "document.querySelector('#inner-scroll').scrollTop > 0",
      "scroll targets nested scroll containers"
    );

    cliLog(JSON.stringify({ pointerStep: "page wheel" }));
    await resetHome();
    const wheelPoint = await js(
      "const rect = document.querySelector('#scroll-area').getBoundingClientRect();" +
        "return { x: Math.min(Math.max(rect.left + 20, 10), innerWidth - 10), y: Math.min(Math.max(rect.top + 20, 10), innerHeight - 10) };"
    );
    const beforeWheel = await pageInfo();
    await scroll(wheelPoint.x, wheelPoint.y, { dy: 300 });
    await waitForJsCondition(
      "scrollY > " + JSON.stringify(beforeWheel.sy),
      "scroll wheel moves the page down"
    );
    const afterWheel = await pageInfo();
    assert(afterWheel.sy > beforeWheel.sy, "scroll wheel moves the page down");

    await resetHome();
    const objectWheelPoint = await js(
      "const rect = document.querySelector('#scroll-area').getBoundingClientRect();" +
        "return { x: Math.min(Math.max(rect.left + 30, 10), innerWidth - 10), y: Math.min(Math.max(rect.top + 30, 10), innerHeight - 10) };"
    );
    const beforeObjectWheel = await pageInfo();
    await scroll({ x: objectWheelPoint.x, y: objectWheelPoint.y, dy: 120 });
    await waitForJsCondition(
      "scrollY > " + JSON.stringify(beforeObjectWheel.sy),
      "scroll object options move the page down"
    );
    const afterObjectWheel = await pageInfo();
    assert(afterObjectWheel.sy > beforeObjectWheel.sy, "scroll object options move the page down");

    cliLog(JSON.stringify({ pointerStep: "dom scroll helpers" }));
    await resetHome();
    const beforeBy = await pageInfo();
    const by = await scrollBy({ dy: 450 });
    assert(by.y > beforeBy.sy, "scrollBy moves the page down and returns scroll position");
    const byNumber = await scrollBy(120);
    assert(byNumber.y > by.y, "scrollBy accepts numeric amount");
    const byTop = await scrollBy({ top: -60 });
    assert(byTop.y < byNumber.y && byTop.y >= 0, "scrollBy accepts top option");

    const bottom = await scrollToBottomUntil(
      "document.querySelector('#bottom-marker').getBoundingClientRect().top < innerHeight",
      { step: 700, maxSteps: 8, wait: 0.05 }
    );
    assert(bottom.done || bottom.reason === "bottom", "scrollToBottomUntil terminates");

    await resetHome();
    const maxStep = await scrollToBottomUntil("false", {
      step: 100,
      maxSteps: 0,
      wait: 0,
    });
    assertEqual(maxStep.reason, "maxSteps", "scrollToBottomUntil reports maxSteps");

    const nullCondition = await scrollToBottomUntil(null, {
      step: 100,
      maxSteps: 0,
      wait: 0,
    });
    assertEqual(nullCondition.reason, "maxSteps", "scrollToBottomUntil accepts null condition");

    const functionCondition = await scrollToBottomUntil(
      (state) => state.y > 100,
      { step: 200, maxSteps: 5, wait: 0 }
    );
    assertEqual(functionCondition.reason, "condition", "scrollToBottomUntil accepts function condition");

    const immediateCondition = await scrollToBottomUntil("true", {
      step: 100,
      maxSteps: 3,
      wait: 0,
    });
    assertEqual(immediateCondition.reason, "condition", "scrollToBottomUntil accepts immediate string condition");

    await assertRejects(
      () => dragMouse(["#drag-source"]),
      "at least two points",
      "dragMouse validates minimum path length"
    );
    await assertRejects(
      () => click({ x: "bad", y: 1 }),
      "invalid mouse target",
      "click validates coordinate targets"
    );
    await assertRejects(
      () => click("#click-button", { button: "sideways" }),
      "unsupported mouse button",
      "click validates mouse buttons"
    );
    await assertRejects(
      () => dragMouse(["#drag-source", "#drag-target"], { button: "sideways" }),
      "unsupported mouse button",
      "dragMouse validates mouse buttons"
    );
    await assertRejects(
      () => scrollBy({ dy: "bad" }),
      "invalid mouse offset",
      "scrollBy validates numeric offsets"
    );
    await assertRejects(
      () => scrollToBottomUntil(42, { maxSteps: 0 }),
      "function or string",
      "scrollToBottomUntil validates condition type"
    );

    /* right-click — CDP dispatches mousedown with button=right; contextmenu synthesis is browser-dependent */
    cliLog(JSON.stringify({ pointerStep: "right click" }));
    const rightClickBefore = await js("return window.__fixtureState.pointerEvents.length");
    await click("#context-menu-zone", { button: "right" });
    const rightClickAfter = await js("return window.__fixtureState.pointerEvents.length");
    assert(rightClickAfter > rightClickBefore, "click with button:right dispatches mouse events on the target");
    const rightMouseDown = await js(
      "return window.__fixtureState.pointerEvents.some(function(e) { return e.type === 'mousedown' && e.target === 'context-menu-zone'; })"
    );
    assert(rightMouseDown, "right-click produces a mousedown event on the context-menu-zone");

    /* rapid clicks — probe cleanup between actions */
    cliLog(JSON.stringify({ pointerStep: "rapid clicks" }));
    await resetHome();
    const clicksBefore = await js("return window.__fixtureState.clicks");
    await click("#click-button");
    await click("#click-button");
    await click("#click-button");
    await click("#click-button");
    await click("#click-button");
    await waitForJsValue(
      "window.__fixtureState.clicks",
      clicksBefore + 5,
      "five rapid clicks increment counter correctly (probe cleanup between actions)",
      "window.__fixtureState.pointerEvents"
    );

    /* checkbox toggle */
    cliLog(JSON.stringify({ pointerStep: "checkbox" }));
    await js("document.querySelector('#checkbox').checked = false; window.__fixtureState.checkboxChecked = false; return true;");
    await click("#checkbox");
    await waitForJsValue("window.__fixtureState.checkboxChecked", true, "first click checks the checkbox");
    await click("#checkbox");
    await waitForJsValue("window.__fixtureState.checkboxChecked", false, "second click unchecks the checkbox");
  `;
}
