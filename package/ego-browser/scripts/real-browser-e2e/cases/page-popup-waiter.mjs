export function pagePopupWaiterCase() {
  return `
    const task = await taskSpace(taskName);
    const source = await newPageAt(task, baseUrl + "/?page=popup-waiter");
    try {
      await source.evaluate((popupUrl) => {
        const button = document.createElement("button");
        button.id = "popup-waiter-button";
        button.textContent = "Open delayed popup";
        button.addEventListener("click", () => {
          setTimeout(() => window.open(popupUrl, "_blank"), 250);
        });
        document.body.append(button);
      }, baseUrl + "/secondary?popup-waiter=explicit");

      const pendingPopup = source.waitForEvent("popup", { timeout: 3_000 });
      const firstReceipt = await source.click("#popup-waiter-button");
      const firstPopup = await pendingPopup;
      assertEqual(
        firstReceipt.popups?.length ?? 0,
        0,
        "the delayed popup opens after the action receipt window"
      );
      assertIncludes(
        await firstPopup.url(),
        "popup-waiter=explicit",
        "the explicit popup waiter returns a usable Page"
      );
      await firstPopup.close();

      await source.evaluate((urls) => {
        for (const [id, url] of Object.entries(urls)) {
          const link = document.createElement("a");
          link.id = id;
          link.href = url;
          link.target = "_blank";
          link.textContent = id;
          document.body.append(link);
        }
      }, {
        "old-popup-link": baseUrl + "/secondary?popup-waiter=old",
        "next-popup-link": baseUrl + "/secondary?popup-waiter=next",
      });
      const oldReceipt = await source.click("#old-popup-link");
      const nextPopupPromise = source.waitForEvent("popup", { timeout: 3_000 });
      const nextReceipt = await source.click("#next-popup-link");
      const nextPopup = await nextPopupPromise;
      assert(
        nextPopup.label !== oldReceipt.popups[0].label,
        "a new popup waiter ignores an unobserved popup from an earlier action"
      );
      assertEqual(
        nextPopup.label,
        nextReceipt.popups[0].label,
        "the popup waiter resolves the popup created after it was armed"
      );
      assertIncludes(
        await nextPopup.url(),
        "popup-waiter=next",
        "the future popup Page has the expected URL"
      );
      await task.page(oldReceipt.popups[0].label).close();
      await nextPopup.close();

      await source.evaluate((popupUrl) => {
        const link = document.createElement("a");
        link.id = "popup-waiter-link";
        link.href = popupUrl;
        link.target = "_blank";
        link.textContent = "Open immediate popup";
        document.body.append(link);
      }, baseUrl + "/secondary?popup-waiter=wrong-page");
      const secondReceipt = await source.click("#popup-waiter-link");
      const startedAt = Date.now();
      let waitError;
      try {
        await source.waitForURL("**/secondary?popup-waiter=wrong-page", {
          timeout: 15_000,
        });
      } catch (error) {
        waitError = error;
      }
      assertEqual(
        waitError?.code,
        "EGO_URL_OPENED_IN_POPUP",
        "waiting on the opener reports the popup instead of timing out"
      );
      assertIncludes(
        waitError?.message,
        'task.page("' + secondReceipt.popups[0].label + '")',
        "the diagnostic gives the exact Page recovery expression"
      );
      assert(
        Date.now() - startedAt < 2_000,
        "the wrong-Page wait fails before the 15 second timeout"
      );
      await task.page(secondReceipt.popups[0].label).close();
    } finally {
      await source.close();
    }
  `;
}
