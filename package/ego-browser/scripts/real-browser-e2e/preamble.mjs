// E2E test preamble — assertion helpers and utility functions.
// This file is read by ego-source.mjs and injected into the generated test
// script that runs inside ego-browser. It is NOT imported as a module; it is
// concatenated into the script body so all declarations are in the same scope
// as the case body and epilogue.

const { stat, readFile, writeFile } = await import("node:fs/promises");
const { join } = await import("node:path");

let __assertionCount = 0;

function formatAssertionValue(value) {
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return String(value).slice(0, 500);
  }
}

function logAssertion(status, message, details = {}) {
  if (!verboseAssertions) return;
  console.log(
    JSON.stringify({
      assertion: {
        status,
        message,
        ...details,
      },
    }),
  );
}

function assert(condition, message) {
  __assertionCount++;
  logAssertion("start", message);
  if (!condition) {
    logAssertion("fail", message);
    throw new Error(message);
  }
  logAssertion("pass", message);
}

function assertEqual(actual, expected, message) {
  __assertionCount++;
  logAssertion("start", message);
  if (actual !== expected) {
    logAssertion("fail", message, {
      expected: formatAssertionValue(expected),
      actual: formatAssertionValue(actual),
    });
    throw new Error(
      message +
        ": expected " +
        JSON.stringify(expected) +
        ", got " +
        JSON.stringify(actual),
    );
  }
  logAssertion("pass", message);
}

function assertIncludes(text, expected, message) {
  __assertionCount++;
  logAssertion("start", message);
  if (!String(text).includes(expected)) {
    logAssertion("fail", message, {
      expected: formatAssertionValue(expected),
      actual: formatAssertionValue(String(text).slice(0, 500)),
    });
    throw new Error(
      message +
        ": expected " +
        JSON.stringify(String(text).slice(0, 500)) +
        " to include " +
        JSON.stringify(expected),
    );
  }
  logAssertion("pass", message);
}

async function assertRejects(fn, expected, message) {
  __assertionCount++;
  logAssertion("start", message);
  try {
    await fn();
  } catch (error) {
    const errorMessage = error?.message || String(error);
    if (!String(errorMessage).includes(expected)) {
      logAssertion("fail", message, {
        expected: formatAssertionValue(expected),
        actual: formatAssertionValue(errorMessage),
      });
      throw new Error(
        message +
          ": expected " +
          JSON.stringify(String(errorMessage).slice(0, 500)) +
          " to include " +
          JSON.stringify(expected),
      );
    }
    logAssertion("pass", message);
    return;
  }
  logAssertion("fail", message, { expected: "rejection" });
  throw new Error(message + ": expected rejection");
}

async function assertRejectsAny(fn, message) {
  __assertionCount++;
  logAssertion("start", message);
  try {
    await fn();
  } catch {
    logAssertion("pass", message);
    return;
  }
  logAssertion("fail", message, { expected: "rejection" });
  throw new Error(message + ": expected rejection");
}

async function waitForJsValue(
  expression,
  expected,
  message,
  debugExpression = null,
) {
  __assertionCount++;
  logAssertion("start", message);
  const deadline = Date.now() + 2000;
  let last;
  while (Date.now() <= deadline) {
    last = await page.evaluate(expression);
    if (last === expected) {
      logAssertion("pass", message);
      return last;
    }
    await page.waitForTimeout(50);
  }
  let detail = "";
  if (debugExpression) {
    detail = "; debug=" + JSON.stringify(await page.evaluate(debugExpression));
  }
  logAssertion("fail", message, {
    expected: formatAssertionValue(expected),
    actual: formatAssertionValue(last),
  });
  throw new Error(
    message +
      detail +
      ": expected " +
      JSON.stringify(expected) +
      ", got " +
      JSON.stringify(last),
  );
}

async function waitForJsCondition(expression, message, debugExpression = null) {
  __assertionCount++;
  logAssertion("start", message);
  const deadline = Date.now() + 2000;
  let last;
  while (Date.now() <= deadline) {
    last = await page.evaluate(expression);
    if (last) {
      logAssertion("pass", message);
      return last;
    }
    await page.waitForTimeout(50);
  }
  let detail = "";
  if (debugExpression) {
    detail = "; debug=" + JSON.stringify(await page.evaluate(debugExpression));
  }
  logAssertion("fail", message, {
    actual: formatAssertionValue(last),
  });
  throw new Error(
    message +
      detail +
      ": condition stayed false, last value " +
      JSON.stringify(last),
  );
}

async function allowWheelDispatch(label, fn) {
  try {
    await fn();
    return true;
  } catch (error) {
    const message = error?.message || String(error);
    if (
      /Input\.dispatchMouseEvent|CDP request timed out: Input\.dispatchMouseEvent/.test(
        message,
      )
    ) {
      console.log(JSON.stringify({ inputDispatchWarning: { label, message } }));
      return false;
    }
    throw error;
  }
}

async function setStableViewport() {
  await cdp("Page.bringToFront").catch(() => {});
  await cdp("Emulation.clearDeviceMetricsOverride").catch(() => {});
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(100);
}

async function hitTestClickButton() {
  return page
    .evaluate(
      "const el = document.querySelector('#click-button');" +
        "if (!el) return '';" +
        "const r = el.getBoundingClientRect();" +
        "const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);" +
        "return hit?.closest?.('#click-button')?.id || hit?.id || '';",
    )
    .catch(() => "");
}

async function closeFixtureTabs() {
  const tabs = await browser.listTabs({ includeChrome: false }).catch(() => []);
  for (const tab of tabs) {
    if (String(tab.url || "").startsWith(baseUrl)) {
      await browser.closeTab(tab.targetId).catch(() => {});
    }
  }
}

async function resetHome() {
  await taskSpaces.takeOver(taskName).catch(() => {});
  await taskSpaces.waitForAgentControl(taskName, {
    interval: 0.1,
    timeout: 5,
  });
  await closeFixtureTabs();
  const tab = await browser.openOrReuseTab(
    baseUrl + "/?e2e-reset=" + Date.now(),
    {
      wait: true,
      timeout: 10000,
    },
  );
  await browser.switchTab(tab.targetId);
  await setStableViewport();
  const nav = await page.goto(baseUrl + "/", { timeout: 10000 });
  assert(nav.loaded, "home page loaded");
  await setStableViewport();
  assert(
    await page
      .locator("#click-button")
      .waitFor({ timeout: 3000, state: "visible" }),
    "home fixture click button is visible",
  );
  for (let i = 0; i < 10; i += 1) {
    const info = await page.info();
    if (
      info.w > 0 &&
      info.h > 0 &&
      (await hitTestClickButton()) === "click-button"
    )
      return tab;
    await setStableViewport();
  }
  const info = await page.info();
  assert(info.w > 0 && info.h > 0, "viewport initialized with non-zero size");
  assertEqual(
    await hitTestClickButton(),
    "click-button",
    "viewport hit-testing reaches the click fixture",
  );
  return tab;
}
