// Default screenshot paths must stay unique across separate runs. The
// embedded host executes every `ego-browser nodejs` run in one long-lived
// Node process and reloads the SDK per run, so a pid-plus-counter name
// collides. These two cases are two separate runs on purpose.

export function pageDefaultScreenshotPathFirstRunCase() {
  return `
    const { tmpdir } = await import("node:os");
    const { basename, dirname } = await import("node:path");
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/?workflow=default-screenshot-first");

    try {
      const first = await page.screenshot();
      assertEqual(dirname(first), tmpdir(), "default screenshot lands in the system temp directory");
      assert(
        /^ego-browser-shot-\\d{6}\\.png$/.test(basename(first)),
        "default screenshot name carries a random id: " + basename(first)
      );
      assert((await stat(first)).size > 0, "default screenshot is a non-empty file");

      const second = await page.screenshot();
      assert(second !== first, "two default screenshots in one run use different names");

      const outputDir = join(artifactDir, "run-output");
      globalThis.EGO_BROWSER_OUTPUT_DIR = outputDir;
      const hooked = await page.screenshot();
      assertEqual(dirname(hooked), outputDir, "EGO_BROWSER_OUTPUT_DIR redirects default screenshots");
      assert((await stat(hooked)).size > 0, "redirected screenshot is a non-empty file");

      globalThis.EGO_BROWSER_OUTPUT_DIR = "relative-output";
      await assertRejects(
        () => page.screenshot(),
        "EGO_BROWSER_OUTPUT_DIR must be an absolute directory path",
        "a relative EGO_BROWSER_OUTPUT_DIR is rejected"
      );
      delete globalThis.EGO_BROWSER_OUTPUT_DIR;

      await writeFile(
        join(tempDir, "default-screenshot-run.json"),
        JSON.stringify({ path: first, pid: process.pid })
      );
    } finally {
      await page.close();
    }
  `;
}

export function pageDefaultScreenshotPathSecondRunCase() {
  return `
    const saved = JSON.parse(
      await readFile(join(tempDir, "default-screenshot-run.json"), "utf8")
    );
    assertEqual(
      globalThis.EGO_BROWSER_OUTPUT_DIR,
      undefined,
      "EGO_BROWSER_OUTPUT_DIR does not leak into the next run"
    );
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/?workflow=default-screenshot-second");

    try {
      const current = await page.screenshot();
      cliLog(JSON.stringify({ samePid: process.pid === saved.pid, previous: saved.path, current }));
      assert(current !== saved.path, "a later run does not reuse the previous run's default screenshot path");
      assert((await stat(saved.path)).size > 0, "the previous run's screenshot is still intact");
      assert((await stat(current)).size > 0, "the later run's screenshot is a non-empty file");
    } finally {
      await page.close();
    }
  `;
}
