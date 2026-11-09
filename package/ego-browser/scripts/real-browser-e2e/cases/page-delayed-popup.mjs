export function pageDelayedPopupScheduleCase() {
  return `
    const task = await taskSpace(taskName);
    const source = await newPageAt(task, baseUrl + "/?delayed-popup=schedule");
    const ledgerPath = join(
      process.env.EGO_BROWSER_STATE_DIR,
      "space-" + task.spaceId + ".json"
    );
    const beforeLedger = JSON.parse(await readFile(ledgerPath, "utf8"));
    await writeFile(
      join(tempDir, "delayed-popup-state.json"),
      JSON.stringify({
        sourceLabel: source.label,
        beforeTargets: Object.values(beforeLedger.pages).map((entry) => entry.targetId),
      })
    );

    await source.evaluate((popupUrl) => {
      const button = document.createElement("button");
      button.id = "cross-round-delayed-popup";
      button.textContent = "Open later";
      button.addEventListener("click", () => {
        setTimeout(() => window.open(popupUrl, "_blank"), 650);
      });
      document.body.append(button);
    }, baseUrl + "/secondary?delayed-popup=cross-round");

    const receipt = await source.click("#cross-round-delayed-popup");
    assertEqual(
      receipt.popups?.length ?? 0,
      0,
      "the first round ends before the delayed target exists"
    );
  `;
}

export function pageDelayedPopupResumeCase() {
  return `
    const task = await taskSpace(taskName);
    const saved = JSON.parse(
      await readFile(join(tempDir, "delayed-popup-state.json"), "utf8")
    );
    const source = task.page(saved.sourceLabel);
    await source.waitForTimeout(1_000);
    const beforeTargets = new Set(saved.beforeTargets);
    const ledger = JSON.parse(
      await readFile(
        join(process.env.EGO_BROWSER_STATE_DIR, "space-" + task.spaceId + ".json"),
        "utf8"
      )
    );
    const delayedPopup = Object.entries(ledger.pages).find(
      ([, entry]) => !beforeTargets.has(entry.targetId)
    );
    assert(Boolean(delayedPopup), "the next round adopts the delayed popup in the background");

    const popup = task.page(delayedPopup[0]);
    assertIncludes(
      await popup.url(),
      "delayed-popup=cross-round",
      "the automatically assigned Page label is immediately usable"
    );
    await popup.close();
    await source.close();
  `;
}
