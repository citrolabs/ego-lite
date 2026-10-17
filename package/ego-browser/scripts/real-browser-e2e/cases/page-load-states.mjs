export function pageLoadStatesCase() {
  return `
    const task = await taskSpace(taskName);
    const uncommittedPage = await task.newPage();
    let uncommittedError;
    try {
      await uncommittedPage.goto(baseUrl + "/slow-page?ms=1000", {
        timeout: 100,
      });
    } catch (error) {
      uncommittedError = error;
    }
    assert(uncommittedError, "goto reports a timeout before response headers");
    assertEqual(
      uncommittedError.code,
      "EGO_NAVIGATION_TIMEOUT",
      "an uncommitted timeout uses the navigation-timeout code"
    );
    assertEqual(
      uncommittedError.committed,
      false,
      "goto does not claim that a document committed before response headers"
    );
    assert(
      !uncommittedError.message.includes("Continue on this Page"),
      "an uncommitted timeout does not recommend continuing on the old document"
    );
    await uncommittedPage.close();

    const page = await newPageAt(task, "about:blank");
    let navigationError;
    try {
      await page.goto(baseUrl + "/streamed-page?ms=1500", { timeout: 300 });
    } catch (error) {
      navigationError = error;
    }
    assert(navigationError, "goto reports its load timeout");
    assertEqual(
      navigationError.code,
      "EGO_NAVIGATION_TIMEOUT",
      "goto exposes a stable navigation-timeout code"
    );
    assertEqual(
      navigationError.committed,
      true,
      "goto distinguishes a committed document from a failed navigation"
    );
    assertIncludes(
      navigationError.url,
      "/streamed-page?ms=1500",
      "the timeout reports the committed URL"
    );
    assertEqual(
      navigationError.readyState,
      "loading",
      "the timeout reports the document load state"
    );
    assertIncludes(
      navigationError.message,
      'page.waitForLoadState("load")',
      "the timeout suggests continuing from the committed Page"
    );
    assertIncludes(
      await page.url(),
      "/streamed-page?ms=1500",
      "a Page remains addressable after goto times out"
    );
    await page.waitForLoadState("load", { timeout: 3_000 });
    const referer = baseUrl + "/navigation-source";
    await page.goto(baseUrl + "/streamed-page?ms=1000", {
      referer,
      waitUntil: "commit",
      timeout: 1_000,
    });
    const afterCommit = await page.evaluate(() => ({
      marker: document.documentElement.dataset.committed,
      readyState: document.readyState,
      referer: document.referrer,
    }));
    assertEqual(afterCommit.marker, "true", "commit waits for the new document");
    assertEqual(
      afterCommit.readyState,
      "loading",
      "commit returns before the streamed document finishes loading"
    );
    assertEqual(afterCommit.referer, referer, "goto forwards the referer header");
    await page.waitForLoadState("load", { timeout: 2_000 });

    await page.goto(baseUrl + "/domcontentloaded-page?ms=1500", {
      waitUntil: "domcontentloaded",
      timeout: 1_000,
    });
    const afterDomContentLoaded = await page.evaluate(() => ({
      marker: document.documentElement.dataset.domContentLoaded,
      readyState: document.readyState,
    }));
    assertEqual(
      afterDomContentLoaded.marker,
      "true",
      "domcontentloaded waits for the actual document lifecycle event"
    );
    assertEqual(
      afterDomContentLoaded.readyState,
      "interactive",
      "domcontentloaded returns while the slow resource still blocks load"
    );

    const loadTimeoutStartedAt = Date.now();
    await assertRejects(
      () => page.waitForLoadState("load", { timeout: 100 }),
      "waitForLoadState(load) timed out",
      "load does not resolve at the earlier DOMContentLoaded boundary"
    );
    assert(
      Date.now() - loadTimeoutStartedAt < 500,
      "a document-state wait stays inside its public timeout budget"
    );
    await page.waitForLoadState("load", { timeout: 3_000 });
    assertEqual(
      await page.evaluate("document.readyState"),
      "complete",
      "load resolves after the slow resource finishes"
    );

    const directNetworkIdlePage = await task.newPage();
    const directNetworkIdleStartedAt = Date.now();
    await directNetworkIdlePage.goto(
      baseUrl + "/domcontentloaded-page?ms=700&direct-networkidle=" + Date.now(),
      { waitUntil: "networkidle", timeout: 3_000 }
    );
    assert(
      Date.now() - directNetworkIdleStartedAt >= 1_000,
      "goto(networkidle) tracks requests before navigation starts"
    );
    assertEqual(
      await directNetworkIdlePage.evaluate("document.readyState"),
      "complete",
      "goto(networkidle) waits for the slow resource and the idle window"
    );
    const reloadNetworkIdleStartedAt = Date.now();
    await directNetworkIdlePage.reload({ waitUntil: "networkidle", timeout: 3_000 });
    assert(
      Date.now() - reloadNetworkIdleStartedAt >= 1_000,
      "reload(networkidle) tracks requests before reload starts"
    );
    assertEqual(
      await directNetworkIdlePage.evaluate("document.readyState"),
      "complete",
      "reload(networkidle) waits for the slow resource and the idle window"
    );
    const faviconPage = directNetworkIdlePage;
    await faviconPage.goto(baseUrl + "/favicon-redirect-page", {
      waitUntil: "commit",
      timeout: 1_000,
    });
    const faviconEvents = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      faviconEvents.push(...(await faviconPage.events()));
      const requestUrls = faviconEvents
        .filter((event) => event.method === "Network.requestWillBeSent")
        .map((event) => event.params?.request?.url || "");
      if (
        requestUrls.some((url) => url.endsWith("/redirect/favicon.ico")) &&
        requestUrls.some((url) => url.includes("case=favicon-redirect"))
      ) break;
      await faviconPage.waitForTimeout(25);
    }
    const faviconRequestUrls = faviconEvents
      .filter((event) => event.method === "Network.requestWillBeSent")
      .map((event) => event.params?.request?.url || "");
    assert(
      faviconRequestUrls.some((url) => url.endsWith("/redirect/favicon.ico")),
      "the real browser requests the declared favicon"
    );
    assert(
      faviconRequestUrls.some((url) => url.includes("case=favicon-redirect")),
      "the real favicon request follows its redirect"
    );
    const faviconIdleStartedAt = Date.now();
    await faviconPage.waitForLoadState("networkidle", {
      timeout: 1_200,
      idleMs: 200,
    });
    assert(
      Date.now() - faviconIdleStartedAt < 1_000,
      "a redirected favicon does not hold the Page network-idle boundary"
    );
    await faviconPage.close();

    await page.cdp("Runtime.enable");
    const networkEventMarker = "ego-networkidle-event-preserved";
    await page.evaluate(({ url, marker }) => {
      window.__egoSlowFetchFinished = false;
      console.log(marker);
      void fetch(url)
        .then((response) => response.text())
        .then(() => {
          window.__egoSlowFetchFinished = true;
        });
    }, {
      url: baseUrl + "/api/slow?ms=800&case=networkidle",
      marker: networkEventMarker,
    });
    await page.waitForTimeout(100);
    const networkIdleStartedAt = Date.now();
    await page.waitForLoadState("networkidle", {
      timeout: 3_000,
      idleMs: 100,
    });
    const networkIdleElapsed = Date.now() - networkIdleStartedAt;
    assert(
      networkIdleElapsed >= 600,
      "networkidle includes a slow request that began before the wait"
    );
    assertEqual(
      await page.evaluate("window.__egoSlowFetchFinished"),
      true,
      "networkidle waits for the earlier request to finish"
    );
    const preservedEvents = await page.events();
    assert(
      preservedEvents.some(
        (event) =>
          event.method === "Runtime.consoleAPICalled" &&
          event.params?.args?.some((argument) => argument.value === networkEventMarker)
      ),
      "networkidle does not consume the Page event stream"
    );

    const busyPage = await newPageAt(
      task,
      baseUrl + "/?page-network-isolation=busy"
    );
    const quietPage = page;
    await quietPage.goto(baseUrl + "/secondary?page-network-isolation=quiet", {
      waitUntil: "domcontentloaded",
      timeout: 2_000,
    });
    await busyPage.cdp("Runtime.enable");
    await quietPage.cdp("Runtime.enable");
    await busyPage.events();
    await quietPage.events();
    const busyMarker = "ego-v2-busy-page-event";
    const quietMarker = "ego-v2-quiet-page-event";
    await busyPage.evaluate(({ url, marker }) => {
      console.log(marker);
      const request = () => void fetch(url).catch(() => {});
      request();
      window.__egoNetworkIsolationPulse = setInterval(request, 50);
    }, {
      url: baseUrl + "/api/slow?ms=2000&case=v2-page-isolation",
      marker: busyMarker,
    });
    await quietPage.evaluate((marker) => console.log(marker), quietMarker);
    await quietPage.waitForTimeout(100);
    const quietIdleStartedAt = Date.now();
    await quietPage.waitForLoadState("networkidle", {
      timeout: 1_200,
      idleMs: 200,
    });
    assert(
      Date.now() - quietIdleStartedAt < 1_000,
      "traffic on one Page does not keep another Page busy"
    );
    const busyEvents = await busyPage.events();
    const quietEvents = await quietPage.events();
    const hasConsoleMarker = (events, marker) =>
      events.some(
        (event) =>
          event.method === "Runtime.consoleAPICalled" &&
          event.params?.args?.some((argument) => argument.value === marker)
      );
    assert(hasConsoleMarker(busyEvents, busyMarker), "the busy Page keeps its event");
    assert(
      !hasConsoleMarker(busyEvents, quietMarker),
      "the busy Page does not receive the quiet Page event"
    );
    assert(hasConsoleMarker(quietEvents, quietMarker), "the quiet Page keeps its event");
    assert(
      !hasConsoleMarker(quietEvents, busyMarker),
      "the quiet Page does not receive the busy Page event"
    );
    await busyPage.evaluate(() => clearInterval(window.__egoNetworkIsolationPulse));
    await busyPage.close();

    const oopifPage = await task.newPage();
    await oopifPage.goto(baseUrl + "/oopif-network?ms=800", {
      waitUntil: "commit",
      timeout: 1_000,
    });
    const oopifStartedAt = Date.now();
    await oopifPage.waitForLoadState("networkidle", {
      timeout: 3_000,
      idleMs: 100,
    });
    assert(
      Date.now() - oopifStartedAt >= 650,
      "networkidle includes requests from a cross-process iframe"
    );
    const slowFrameTarget = (await task.cdp("Target.getTargets")).targetInfos.find(
      (target) =>
        target.type === "iframe" && target.url.includes("/slow-frame?ms=800")
    )?.targetId;
    assert(slowFrameTarget, "the slow cross-process iframe has a live target");
    assertEqual(
      await js("return document.readyState", slowFrameTarget),
      "complete",
      "networkidle returns only after the cross-process frame finishes loading"
    );

    await oopifPage.goto(baseUrl + "/oopif-network?ms=3000", {
      waitUntil: "commit",
      timeout: 1_000,
    });
    await oopifPage.waitForTimeout(100);
    const oopifTimeoutStartedAt = Date.now();
    await assertRejects(
      () => oopifPage.waitForLoadState("networkidle", {
        timeout: 250,
        idleMs: 100,
      }),
      "networkidle) timed out",
      "networkidle does not ignore a still-loading cross-process frame"
    );
    assert(
      Date.now() - oopifTimeoutStartedAt < 1_000,
      "an OOPIF network-idle wait stays inside its public timeout budget"
    );
    await oopifPage.evaluate(() => {
      document.querySelector("iframe")?.remove();
    });
    await oopifPage.waitForLoadState("networkidle", {
      timeout: 2_000,
      idleMs: 100,
    });
    await oopifPage.close();

    await page.evaluate((popupUrl) => {
      const button = document.createElement("button");
      button.id = "delayed-popup";
      button.textContent = "Open delayed popup";
      button.style.cssText = "position:fixed;left:20px;top:20px;z-index:2147483647";
      button.addEventListener("click", () => {
        setTimeout(() => {
          window.open(popupUrl, "_blank");
        }, 650);
      });
      document.body.append(button);
    }, baseUrl + "/secondary?page-load-states=delayed-popup");
    const ledgerPath = join(
      process.env.EGO_BROWSER_STATE_DIR,
      "space-" + task.spaceId + ".json"
    );
    const beforeLedger = JSON.parse(await readFile(ledgerPath, "utf8"));
    const beforeTargets = new Set(
      Object.values(beforeLedger.pages).map((entry) => entry.targetId)
    );
    const receipt = await page.click("#delayed-popup");
    assertEqual(
      receipt.popups?.length ?? 0,
      0,
      "the popup is created after the action receipt window"
    );
    await page.waitForTimeout(1_000);
    const afterLedger = JSON.parse(await readFile(ledgerPath, "utf8"));
    const delayedPopup = Object.entries(afterLedger.pages).find(
      ([, entry]) => !beforeTargets.has(entry.targetId)
    );
    assert(Boolean(delayedPopup), "background discovery adopts the delayed popup");
    const popup = task.page(delayedPopup[0]);
    await popup.waitForURL("**/secondary?page-load-states=*", { timeout: 3_000 });
    await popup.waitForURL(
      (url) => url.searchParams.get("page-load-states") === "delayed-popup",
      { timeout: 3_000 }
    );
    assertIncludes(
      await popup.url(),
      "page-load-states=delayed-popup",
      "waitForURL follows the popup's first navigation"
    );

    await popup.close();
    await page.close();
  `;
}
