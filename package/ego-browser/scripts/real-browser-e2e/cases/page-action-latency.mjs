export function pageActionPopupReceiptCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/?page=action-latency");
    try {
      const plainReceipt = await page.click("#click-button");
      assertEqual(
        Object.keys(plainReceipt).length,
        0,
        "an action without a popup returns an empty receipt"
      );

      await page.evaluate((popupUrl) => {
        const button = document.createElement("button");
        button.id = "action-latency-window-open";
        button.textContent = "Open now";
        button.style.cssText = "position:fixed;left:20px;top:20px;z-index:1000";
        button.addEventListener("click", () => window.open(popupUrl, "_blank"));
        document.body.append(button);
      }, baseUrl + "/secondary?action-latency=window-open");
      const windowOpenReceipt = await page.click("#action-latency-window-open");
      assertEqual(
        windowOpenReceipt.popups?.length ?? 0,
        1,
        "a popup opened synchronously by the click handler is in the receipt"
      );
      assertIncludes(
        await task.page(windowOpenReceipt.popups[0].label).url(),
        "action-latency=window-open",
        "the window.open popup Page is usable from the receipt"
      );
      await task.page(windowOpenReceipt.popups[0].label).close();

      await page.evaluate((popupUrl) => {
        const link = document.createElement("a");
        link.id = "action-latency-blank-link";
        link.href = popupUrl;
        link.target = "_blank";
        link.textContent = "Open in a new tab";
        link.style.cssText = "position:fixed;left:160px;top:20px;z-index:1000";
        document.body.append(link);
      }, baseUrl + "/secondary?action-latency=link");
      const linkReceipt = await page.click("#action-latency-blank-link");
      assertEqual(
        linkReceipt.popups?.length ?? 0,
        1,
        "a target=_blank link created by the browser after the click is in the receipt"
      );
      assertIncludes(
        await task.page(linkReceipt.popups[0].label).url(),
        "action-latency=link",
        "the link popup Page is usable from the receipt"
      );
      await task.page(linkReceipt.popups[0].label).close();

      await page.evaluate(() => {
        const form = document.createElement("form");
        form.id = "action-latency-form";
        form.style.cssText =
          "position:fixed;left:20px;top:80px;width:360px;background:white;z-index:1000";
        form.innerHTML = [
          '<input id="al-name">',
          '<input id="al-email">',
          '<select id="al-country"><option value="">--</option><option value="us">US</option></select>',
          '<input type="checkbox" id="al-newsletter">',
          '<textarea id="al-message"></textarea>',
          '<input id="al-extra">',
          '<button type="submit" id="al-submit">Send</button>',
          '<div id="al-result"></div>',
        ].join("");
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          document.getElementById("al-result").textContent = "FORM-OK";
        });
        document.body.append(form);
      });
      // Native mouse input can wait up to a second for an occluded window, so
      // only the fill path is timed; each fill used to spend 100ms in fixed
      // settle and verification delays.
      const startedAt = Date.now();
      await page.fill("#al-name", "Ada");
      await page.fill("#al-email", "ada@example.com");
      await page.selectOption("#al-country", "us");
      await page.fill("#al-message", "hello");
      await page.fill("#al-extra", "x");
      const fillElapsedMs = Date.now() - startedAt;
      assert(
        fillElapsedMs < 250,
        "four fills and a select complete without fixed settle delays (" + fillElapsedMs + "ms)"
      );
      await page.click("#al-newsletter");
      await page.click("#al-submit");
      await page.waitForFunction(
        () => document.getElementById("al-result").textContent === "FORM-OK"
      );
      assertEqual(
        await page.evaluate(() =>
          [
            document.getElementById("al-name").value,
            document.getElementById("al-email").value,
            document.getElementById("al-country").value,
            String(document.getElementById("al-newsletter").checked),
            document.getElementById("al-message").value,
            document.getElementById("al-extra").value,
          ].join("|")
        ),
        "Ada|ada@example.com|us|true|hello|x",
        "every field keeps its value after the fast fill path"
      );
    } finally {
      await page.close();
    }
  `;
}

export function pageActionIdleFailFastCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/?page=idle-fail-fast");
    try {
      await page.waitForLoadState("networkidle", { timeout: 5_000 });

      let startedAt = Date.now();
      let missingError;
      try {
        await page.click("#action-latency-missing");
      } catch (error) {
        missingError = error;
      }
      const missingElapsedMs = Date.now() - startedAt;
      assertIncludes(
        missingError?.message || "",
        "Selector #action-latency-missing matched 0 elements",
        "a missing target still names the selector and its match count"
      );
      assertIncludes(
        missingError?.message || "",
        "has been idle",
        "the fast failure explains that the page was idle"
      );
      assertIncludes(
        missingError?.message || "",
        "page.waitForSelector()",
        "the fast failure points at the explicit wait"
      );
      assert(
        missingElapsedMs < 2_000,
        "an idle page rejects a missing target well before the 3s action timeout (" + missingElapsedMs + "ms)"
      );

      await page.evaluate(() => {
        setTimeout(() => {
          const button = document.createElement("button");
          button.id = "action-latency-late";
          button.textContent = "Late";
          button.style.cssText = "position:fixed;left:20px;top:20px;z-index:1000";
          button.addEventListener("click", () => {
            button.textContent = "late-clicked";
          });
          document.body.append(button);
        }, 300);
      });
      await page.click("#action-latency-late");
      assertEqual(
        await page.evaluate(() => document.getElementById("action-latency-late").textContent),
        "late-clicked",
        "a target that appears shortly after the action starts is still clicked"
      );

      await page.evaluate((slowUrl) => {
        window.__actionLatencyFetch = fetch(slowUrl).then(() => {
          const button = document.createElement("button");
          button.id = "action-latency-after-fetch";
          button.textContent = "After fetch";
          button.style.cssText = "position:fixed;left:160px;top:20px;z-index:1000";
          button.addEventListener("click", () => {
            button.textContent = "fetch-clicked";
          });
          document.body.append(button);
        });
      }, baseUrl + "/api/slow?ms=1200");
      startedAt = Date.now();
      await page.click("#action-latency-after-fetch");
      const fetchElapsedMs = Date.now() - startedAt;
      assert(
        fetchElapsedMs >= 1_000,
        "an in-flight request keeps the action waiting for its target (" + fetchElapsedMs + "ms)"
      );
      assertEqual(
        await page.evaluate(() => document.getElementById("action-latency-after-fetch").textContent),
        "fetch-clicked",
        "the target that appears after the response is clicked"
      );

      startedAt = Date.now();
      await assertRejects(
        () => page.waitForSelector("#action-latency-never", { timeout: 700 }),
        "page.waitForSelector timed out after 700ms",
        "an explicit wait keeps its full timeout on an idle page"
      );
      assert(
        Date.now() - startedAt >= 650,
        "waitForSelector does not fail fast on an idle page"
      );
    } finally {
      await page.close();
    }
  `;
}
