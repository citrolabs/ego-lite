export function environmentCase() {
  return `
    const metadataStat = await stat(metadataPath);
    assert(metadataStat.size > 0, "environment metadata file exists");
    const uploadStat = await stat(uploadPath);
    const uploadStatTwo = await stat(uploadPathTwo);
    assert(uploadStat.size > 0 && uploadStatTwo.size > 0, "upload fixture files exist");
    const artifactStat = await stat(artifactDir);
    assert(artifactStat.isDirectory(), "artifact directory exists");

    const healthText = await serverFetch(baseUrl + "/healthz", { timeout: 5 });
    const health = JSON.parse(healthText);
    assertEqual(health.ok, true, "fixture health endpoint is ok through serverFetch");
    assertEqual(health.taskName, taskName, "fixture health endpoint carries the current task name");

    const task = await useOrCreateTaskSpace(taskName);
    assertEqual(task.name, taskName, "environment creates/selects isolated task space");

    let home = await resetHome();
    assert(home.targetId, "environment opens a real fixture tab");

    const info = await pageInfo();
    assertEqual(info.title, "ego-lite helper e2e", "environment page title is stable");
    assertIncludes(info.url, baseUrl + "/", "environment page URL is fixture root");
    assert(info.w > 0 && info.h > 0, "environment viewport is usable");

    const browserHealthText = await browserFetch("/healthz", { timeout: 5 });
    const browserHealth = JSON.parse(browserHealthText);
    assertEqual(browserHealth.ok, true, "fixture health endpoint is ok through browserFetch");

    const jsonText = await serverFetch(baseUrl + "/api/json", { timeout: 5 });
    assertEqual(JSON.parse(jsonText).value, "json fixture", "JSON fixture route is deterministic");

    const runtimeProbe = await cdp("Runtime.evaluate", {
      expression: "1 + 1",
      returnByValue: true,
    });
    assertEqual(runtimeProbe.result.value, 2, "CDP Runtime.evaluate is available");
    try {
      const browserVersion = await cdp("Browser.getVersion");
      assert(browserVersion.product || browserVersion.userAgent, "CDP Browser.getVersion returns capability data");
    } catch (error) {
      cliLog(JSON.stringify({ capabilityWarning: { method: "Browser.getVersion", message: error?.message || String(error) } }));
    }

    await fillInput("#text-input", "dirty", { timeout: 3 });
    assertEqual(await js("return document.querySelector('#text-input').value"), "dirty", "environment can dirty fixture state");
    home = await resetHome();
    assertEqual(await js("return document.querySelector('#text-input').value"), "initial", "resetHome restores deterministic fixture state");

    const envShot = await captureScreenshot(environmentScreenshotPath, { full: false });
    assertEqual(envShot, environmentScreenshotPath, "environment screenshot uses artifact path");
    const envShotStat = await stat(envShot);
    assert(envShotStat.size > 0, "environment screenshot artifact is non-empty");

    const tabs = await listTabs({ includeChrome: false });
    assert(tabs.some((tab) => tab.targetId === home.targetId), "environment tab appears in listTabs");
  `;
}
