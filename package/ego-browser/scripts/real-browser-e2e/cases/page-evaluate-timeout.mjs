export function pageEvaluateTimeoutCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/?page-evaluate-timeout=" + Date.now());

    const syncStartedAt = Date.now();
    let syncError;
    try {
      await page.evaluate(() => {
        setTimeout(() => {
          window.__scheduledBeforeEvaluateTimeout = "finished";
        }, 15_500);
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {}
      });
    } catch (error) {
      syncError = error;
    }
    assertEqual(
      syncError?.code,
      "EGO_PAGE_EVALUATION_TIMED_OUT",
      "a long synchronous callback returns the Page timeout error"
    );
    assertEqual(syncError?.executionStopped, true, "synchronous execution is actually stopped");
    assertEqual(
      syncError?.mayHaveLateEffects,
      true,
      "termination does not claim to cancel work scheduled before it"
    );
    assertEqual(syncError?.pageResponsive, true, "the Page recovers from synchronous execution");
    assert(
      Date.now() - syncStartedAt < 18_000,
      "the execution safety deadline fires before the callback's own 20 second loop"
    );
    const quickStartedAt = Date.now();
    assertEqual(await page.evaluate("1 + 1"), 2, "the next evaluation succeeds");
    assert(
      Date.now() - quickStartedAt < 1_000,
      "the next evaluation does not inherit the timed-out callback's delay"
    );
    await page.waitForFunction(
      () => window.__scheduledBeforeEvaluateTimeout === "finished",
      undefined,
      { timeout: 3_000, polling: 50 }
    );
    assertEqual(
      await page.evaluate("window.__scheduledBeforeEvaluateTimeout"),
      "finished",
      "real Chromium confirms that previously scheduled work can still run"
    );

    let userError;
    try {
      await page.evaluate(() => {
        throw new Error("Execution was terminated");
      });
    } catch (error) {
      userError = error;
    }
    assertEqual(
      userError?.code,
      undefined,
      "user exception text is not mistaken for a protocol timeout"
    );
    assertIncludes(
      userError?.message,
      "Execution was terminated",
      "the original user exception remains visible"
    );

    assertEqual(
      await page.waitForFunction(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 1_200));
          return true;
        },
        undefined,
        { timeout: 2_500 }
      ),
      true,
      "waitForFunction gives an async predicate the requested overall timeout"
    );

    await page.evaluate(() => {
      delete window.__fallbackBlockStarted;
      delete window.__fallbackBlockCompleted;
    });
    const fallbackStartedAt = Date.now();
    let fallbackError;
    try {
      await page.evaluate(async () => {
        setTimeout(() => {
          window.__fallbackBlockStarted = true;
          const deadline = Date.now() + 5_000;
          while (Date.now() < deadline) {}
          window.__fallbackBlockCompleted = true;
        }, 13_500);
        // Keep the evaluated Promise live past the transport timeout. An
        // unreferenced never-settling Promise may be collected by Chromium
        // before the scheduled blocking task starts.
        await new Promise((resolve) => setTimeout(resolve, 20_000));
      });
    } catch (error) {
      fallbackError = error;
    }
    assertEqual(
      fallbackError?.code,
      "EGO_PAGE_EVALUATION_TIMED_OUT",
      "an unresponsive health probe uses the Page timeout error"
    );
    assertEqual(
      fallbackError?.executionStopped,
      true,
      "the fallback confirms that Runtime.terminateExecution stopped the blocking execution"
    );
    assertEqual(
      fallbackError?.pageResponsive,
      true,
      "the fallback health probe confirms that the Page recovered"
    );
    assert(
      Date.now() - fallbackStartedAt < 18_000,
      "the fallback interrupts the finite five-second block instead of waiting for it to finish"
    );
    assertEqual(
      await page.evaluate("window.__fallbackBlockStarted"),
      true,
      "the finite blocking task started before transport recovery"
    );
    assertEqual(
      await page.evaluate("window.__fallbackBlockCompleted"),
      null,
      "Runtime.terminateExecution interrupted the blocking task"
    );
    assertEqual(
      await page.evaluate("6 * 7"),
      42,
      "the Page remains usable after fallback termination"
    );

    await page.evaluate("delete window.__lateEvaluateSideEffect");
    let asyncError;
    try {
      await page.evaluate(async () => {
        await new Promise((resolve) => setTimeout(resolve, 16_000));
        window.__lateEvaluateSideEffect = "finished";
      });
    } catch (error) {
      asyncError = error;
    }
    assertEqual(
      asyncError?.code,
      "EGO_PAGE_EVALUATION_TIMED_OUT",
      "a long pending promise returns the Page timeout error"
    );
    assertEqual(
      asyncError?.executionStopped,
      false,
      "a responsive pending promise is not reported as stopped"
    );
    assertEqual(
      asyncError?.mayHaveLateEffects,
      true,
      "the error honestly reports possible late asynchronous effects"
    );
    assertEqual(
      asyncError?.pageResponsive,
      true,
      "the health probe distinguishes a responsive Page from a blocked renderer"
    );
    await page.waitForFunction(
      () => window.__lateEvaluateSideEffect === "finished",
      undefined,
      { timeout: 3_000, polling: 50 }
    );
    assertEqual(
      await page.evaluate("window.__lateEvaluateSideEffect"),
      "finished",
      "the real browser demonstrates the documented late asynchronous side effect"
    );

    await page.close();
  `;
}
