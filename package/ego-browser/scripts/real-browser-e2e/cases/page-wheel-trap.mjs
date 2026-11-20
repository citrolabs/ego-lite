export function pageWheelTrapCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/wheel-trap?trap=1");
    const state = () =>
      page.evaluate(() => ({
        scrollY,
        value: document.querySelector("#target").value,
        wheelEvents: window.__wheelEvents,
      }));

    let startedAt = Date.now();
    await page.fill("#target", "hello");
    const trapped = await state();
    const trappedMs = Date.now() - startedAt;
    assertEqual(trapped.value, "hello", "fill reaches an input below a wheel trap");
    assert(trapped.scrollY > 0, "the page scrolled past the wheel trap: " + JSON.stringify(trapped));
    assert(trapped.wheelEvents > 0, "wheel input was tried first: " + JSON.stringify(trapped));
    assert(trappedMs < 3000, "fill past a wheel trap finished within the default timeout: " + trappedMs + "ms");

    await page.goto(baseUrl + "/wheel-trap?trap=0");
    startedAt = Date.now();
    await page.fill("#target", "plain");
    const plain = await state();
    assertEqual(plain.value, "plain", "fill still works on an ordinary page");
    assert(plain.scrollY > 0 && plain.wheelEvents > 1, "an ordinary page scrolls with wheel input: " + JSON.stringify(plain));

    // Each wheel event blocks the page for 400ms: the auto-scroll must respect
    // the action deadline instead of finishing every queued motion, and the
    // error must report the time the action really took.
    await page.goto(baseUrl + "/wheel-trap?trap=1&slow=400");
    startedAt = Date.now();
    let failure;
    try {
      await page.fill("#target", "slow", { timeout: 1000 });
    } catch (error) {
      failure = error;
    }
    const slowMs = Date.now() - startedAt;
    assert(failure, "a wheel trap with a slow handler fails within the deadline instead of hanging");
    const reported = /timed out after (\\d+)ms/.exec(failure.message);
    assert(reported, "the timeout error reports a duration: " + failure.message);
    assert(
      Math.abs(Number(reported[1]) - slowMs) < 500,
      "the reported duration matches the real one: reported " + reported[1] + "ms, measured " + slowMs + "ms"
    );
    assert(slowMs < 3000, "the slow wheel trap does not run far past its 1000ms timeout: " + slowMs + "ms");

    await page.close();
  `;
}
