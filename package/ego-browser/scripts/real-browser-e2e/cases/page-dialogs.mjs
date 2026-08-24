export function pageJavaScriptDialogHandlingCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/?page-dialogs=" + Date.now());

    await page.evaluate(() => {
      const result = document.createElement("output");
      result.id = "dialog-result";
      result.textContent = "idle";

      const noDialogButton = document.createElement("button");
      noDialogButton.id = "no-dialog-action";
      noDialogButton.textContent = "Run without dialog";
      noDialogButton.addEventListener("click", () => {
        result.dataset.noDialogClicks = String(
          Number(result.dataset.noDialogClicks || "0") + 1
        );
      });

      const promptButton = document.createElement("button");
      promptButton.id = "dialog-prompt";
      promptButton.textContent = "Prompt";
      promptButton.addEventListener("click", () => {
        const value = prompt("Name from real E2E", "guest");
        result.textContent = "prompt:" + String(value);
        result.dataset.prompt = String(value);
      });

      const confirmButton = document.createElement("button");
      confirmButton.id = "dialog-confirm";
      confirmButton.textContent = "Confirm";
      confirmButton.addEventListener("click", () => {
        result.dataset.confirm = String(confirm("Continue real E2E?"));
      });

      const alertButton = document.createElement("button");
      alertButton.id = "dialog-alert";
      alertButton.textContent = "Alert";
      alertButton.addEventListener("click", () => {
        alert("Alert from real E2E");
        result.dataset.alert = "closed";
      });

      document.body.prepend(
        noDialogButton,
        promptButton,
        confirmButton,
        alertButton,
        result
      );
    });

    const snapshot = await page.snapshot();
    const snapshotLines = snapshot.split("\\n");
    const noDialogTextIndex = snapshotLines.findIndex((line) =>
      line.includes("Run without dialog")
    );
    const noDialogMatch =
      noDialogTextIndex >= 0 &&
      snapshotLines
        .slice(0, noDialogTextIndex)
        .reverse()
        .map((line) => line.match(/\\[ref=([0-9]+)/))
        .find(Boolean);
    assert(noDialogMatch, "snapshot exposes a ref before the no-dialog checks");
    assertEqual(await page.acceptDialog(), false, "acceptDialog reports no open dialog");
    assertEqual(await page.dismissDialog(), false, "dismissDialog reports no open dialog");
    await page.click("@" + noDialogMatch[1]);
    assertEqual(
      await page.evaluate("document.querySelector('#dialog-result').dataset.noDialogClicks"),
      "1",
      "a no-dialog check preserves existing snapshot refs"
    );

    const dialogPageUrl = await page.url();
    const waitForDialogEvent = async (method, predicate = () => true) => {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const match = (await page.events()).find(
          (event) => event.method === method && predicate(event.params || {})
        );
        if (match) return match;
        await page.waitForTimeout(25);
      }
      throw new Error("timed out waiting for " + method);
    };

    await writeFile(
      join(tempDir, "dialog-hard-stop.json"),
      JSON.stringify({ label: page.label, targetId: page.targetId })
    );

    // Current Ego Lite releases hand control to the user here. A native build
    // with Agent-owned JavaScript dialogs continues through the same case and
    // exercises the complete high-level dialog API instead.
    await page.events();
    const receipt = await page.click("#dialog-prompt");
    assertEqual(receipt.dialog?.type, "prompt", "the action reports the dialog type");
    assertEqual(receipt.dialog?.message, "Name from real E2E", "the action reports its message");
    assertEqual(receipt.dialog?.defaultPrompt, "guest", "the action reports prompt defaults");
    assertEqual(
      receipt.dialog?.url,
      dialogPageUrl,
      "the action preserves the dialog Page URL"
    );
    const promptOpening = await waitForDialogEvent(
      "Page.javascriptDialogOpening",
      (params) => params.type === "prompt"
    );
    assertEqual(promptOpening.params.defaultPrompt, "guest", "the prompt opening event is preserved");
    assertEqual(await page.acceptDialog("agent"), true, "acceptDialog supplies prompt text");
    const promptClosed = await waitForDialogEvent(
      "Page.javascriptDialogClosed",
      (params) => params.result === true
    );
    assertEqual(promptClosed.params.userInput, "agent", "the prompt closing event preserves user input");
    await page.waitForFunction(
      () => document.querySelector("#dialog-result")?.dataset.prompt === "agent",
      undefined,
      { timeout: 2_000 }
    );
    assertEqual(
      await page.evaluate("document.querySelector('#dialog-result').textContent"),
      "prompt:agent",
      "acceptDialog resumes page JavaScript"
    );
    assertEqual(await page.acceptDialog(), false, "acceptDialog is idempotent");

    await page.events();
    const confirmReceipt = await page.click("#dialog-confirm");
    assertEqual(confirmReceipt.dialog?.type, "confirm", "the action reports a confirm");
    await waitForDialogEvent(
      "Page.javascriptDialogOpening",
      (params) => params.type === "confirm"
    );
    assertEqual(await page.dismissDialog(), true, "dismissDialog closes a confirm");
    await waitForDialogEvent(
      "Page.javascriptDialogClosed",
      (params) => params.result === false
    );
    await page.waitForFunction(
      () => document.querySelector("#dialog-result")?.dataset.confirm === "false",
      undefined,
      { timeout: 2_000 }
    );
    assertEqual(await page.dismissDialog(), false, "dismissDialog is idempotent");

    await page.events();
    const alertReceipt = await page.click("#dialog-alert");
    assertEqual(alertReceipt.dialog?.type, "alert", "the action reports an alert");
    assertEqual(alertReceipt.dialog?.message, "Alert from real E2E", "the action reports the alert message");
    await waitForDialogEvent(
      "Page.javascriptDialogOpening",
      (params) => params.type === "alert"
    );
    assertEqual(await page.acceptDialog(), true, "acceptDialog closes an alert");
    await waitForDialogEvent(
      "Page.javascriptDialogClosed",
      (params) => params.result === true
    );
    await page.waitForFunction(
      () => document.querySelector("#dialog-result")?.dataset.alert === "closed",
      undefined,
      { timeout: 2_000 }
    );

    const beforeUnloadUrl = baseUrl + "/secondary?page-dialogs=beforeunload";
    await page.evaluate((url) => {
      window.addEventListener("beforeunload", (event) => {
        event.preventDefault();
        event.returnValue = "Leave real E2E?";
      });
      const link = document.createElement("a");
      link.id = "dialog-beforeunload";
      link.textContent = "Leave page";
      link.href = url;
      document.body.prepend(link);
    }, beforeUnloadUrl);
    await page.events();
    const beforeUnloadReceipt = await page.click("#dialog-beforeunload");
    assertEqual(
      beforeUnloadReceipt.dialog?.type,
      "beforeunload",
      "the action reports a beforeunload dialog"
    );
    await waitForDialogEvent(
      "Page.javascriptDialogOpening",
      (params) => params.type === "beforeunload"
    );
    assertEqual(
      await page.acceptDialog(),
      true,
      "acceptDialog allows beforeunload navigation"
    );
    await waitForDialogEvent(
      "Page.javascriptDialogClosed",
      (params) => params.result === true
    );
    await page.waitForURL(beforeUnloadUrl, { timeout: 3_000 });
    cliLog(JSON.stringify({ dialogHandled: true }));
  `;
}

export function pageJavaScriptDialogRecoveryCase() {
  return `
    const saved = JSON.parse(
      await readFile(join(tempDir, "dialog-hard-stop.json"), "utf8")
    );
    // This is test-only recovery after the native hard stop. On a native build
    // that lets the Agent handle JavaScript dialogs, takeover is a harmless
    // no-op and this still cleans up the same Page.
    const task = await takeOverTaskSpace(taskName);
    const page = task.page(saved.label);

    await page.close();
    assertEqual(page.targetId, saved.targetId, "recovery restores the dialog Page");
    assert(
      !(await task.pages()).some((candidate) => candidate.label === saved.label),
      "recovery closes the dialog Page"
    );
  `;
}
