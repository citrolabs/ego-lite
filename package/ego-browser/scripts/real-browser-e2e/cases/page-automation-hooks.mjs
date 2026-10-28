export function pageAutomationHooksCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/?page-api=automation-hooks");
    assertEqual(
      (await page.cdp("egoAutomated.ping")).result,
      "pong",
      "the browser exposes the Ego automation domain on Page sessions"
    );
    await page.cdp("Runtime.enable");
    await page.events();
    const logMarker = (marker) =>
      page.evaluate((marker) => console.log(marker), marker);
    const hasConsoleMarker = (events, marker) =>
      events.some(
        (event) =>
          event.method === "Runtime.consoleAPICalled" &&
          event.params?.args?.some((argument) => argument.value === marker)
      );

    // Pages detect CDP through side effects of console serialization, so
    // Agent sessions do not receive console messages by default.
    const hiddenMarker = "ego-automation-hooks-hidden";
    await logMarker(hiddenMarker);
    await page.waitForTimeout(100);
    assert(
      !hasConsoleMarker(await page.events(), hiddenMarker),
      "console messages do not reach an Agent session with Runtime enabled"
    );

    await page.cdp("egoAutomated.disable");
    const visibleMarker = "ego-automation-hooks-visible";
    await logMarker(visibleMarker);
    await page.waitForTimeout(100);
    assert(
      hasConsoleMarker(await page.events(), visibleMarker),
      "egoAutomated.disable restores console messages for debugging"
    );
    await page.close();
  `;
}
