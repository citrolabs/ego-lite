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

      const uploadButton = document.createElement("button");
      uploadButton.id = "dialog-upload";
      uploadButton.textContent = "Upload project";
      uploadButton.addEventListener("click", () => {
        const input = document.createElement("input");
        input.type = "file";
        input.addEventListener("change", () => {
          result.dataset.uploadAccepted = String(
            confirm("Replace the current project?")
          );
          result.dataset.uploadFile = input.files?.[0]?.name || "";
        });
        document.body.append(input);
        input.click();
      });

      document.body.prepend(
        noDialogButton,
        promptButton,
        confirmButton,
        alertButton,
        uploadButton,
        result
      );
    });

    assertEqual(await page.acceptDialog(), false, "acceptDialog reports no open dialog");
    assertEqual(await page.dismissDialog(), false, "dismissDialog reports no open dialog");
    await page.click("#no-dialog-action");
    assertEqual(
      await page.evaluate("document.querySelector('#dialog-result').dataset.noDialogClicks"),
      "1",
      "a no-dialog check leaves ordinary Page actions usable"
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

    const chooserPromise = page.waitForFileChooser({ timeout: 2_000 });
    await page.click("#dialog-upload");
    const chooser = await chooserPromise;
    const uploadReceipt = await chooser.setFiles(uploadPath);
    assertEqual(
      uploadReceipt.dialog?.type,
      "confirm",
      "an upload reports the JavaScript dialog opened by its change handler"
    );
    assertEqual(
      uploadReceipt.dialog?.message,
      "Replace the current project?",
      "an upload preserves the confirmation message"
    );
    assertEqual(
      await page.acceptDialog(),
      true,
      "acceptDialog resumes an upload blocked by a confirm"
    );
    await page.waitForFunction(
      () => document.querySelector("#dialog-result")?.dataset.uploadAccepted === "true",
      undefined,
      { timeout: 2_000 }
    );
    assertEqual(
      await page.evaluate("document.querySelector('#dialog-result').dataset.uploadFile"),
      "fixture-upload.txt",
      "the accepted upload keeps the selected file"
    );

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

    await page.close();
  `;
}
