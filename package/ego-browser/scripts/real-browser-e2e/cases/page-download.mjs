export function pageDownloadCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/?page=download");
    const savedPath = join(tempDir, "browser-download.txt");
    try {
      await page.evaluate((downloadUrl) => {
        const link = document.createElement("a");
        link.id = "download-link";
        link.href = downloadUrl;
        link.textContent = "Download fixture";
        document.body.append(link);
      }, baseUrl + "/api/download");

      const pendingDownload = page.waitForEvent("download", {
        timeout: 10_000,
      });
      await page.click("#download-link");
      const download = await pendingDownload;

      assertEqual(download.page(), page, "download reports its source Page");
      assertIncludes(download.url(), "/api/download", "download reports its URL");
      assertEqual(
        download.suggestedFilename(),
        "ego-download.txt",
        "download reports the Content-Disposition filename"
      );
      assertEqual(await download.failure(), null, "download completes successfully");
      await download.saveAs(savedPath);
      assertEqual(
        await readFile(savedPath, "utf8"),
        "ego-browser download fixture\\n",
        "download.saveAs preserves the response body"
      );
      const temporaryPath = await download.path();
      assert(
        temporaryPath !== savedPath,
        "download.path returns a round-local artifact instead of the saveAs destination"
      );
      await download.delete();
      let temporaryExists = true;
      try {
        await stat(temporaryPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        temporaryExists = false;
      }
      assertEqual(temporaryExists, false, "download.delete removes the temporary artifact");
    } finally {
      await page.close();
    }
  `;
}

export function concurrentTaskSpaceDownloadCase() {
  return `
    let firstTask;
    let secondTask;
    try {
      firstTask = await taskSpace(taskName + " concurrent download first");
      secondTask = await taskSpace(taskName + " concurrent download second");
      const firstPage = firstTask.page("p1");
      const secondPage = secondTask.page("p1");
      await Promise.all([
        firstPage.goto(baseUrl + "/?download-space=first"),
        secondPage.goto(baseUrl + "/?download-space=second"),
      ]);
      await Promise.all([
        firstPage.evaluate((downloadUrl) => {
          const link = document.createElement("a");
          link.id = "concurrent-download";
          link.href = downloadUrl;
          link.textContent = "Download first TaskSpace file";
          document.body.append(link);
        }, baseUrl + "/api/download?space=first"),
        secondPage.evaluate((downloadUrl) => {
          const link = document.createElement("a");
          link.id = "concurrent-download";
          link.href = downloadUrl;
          link.textContent = "Download second TaskSpace file";
          document.body.append(link);
        }, baseUrl + "/api/download?space=second"),
      ]);

      const firstPending = firstPage.waitForEvent("download", {
        timeout: 10_000,
      });
      const secondPending = secondPage.waitForEvent("download", {
        timeout: 10_000,
      });
      await Promise.all([
        firstPage.click("#concurrent-download"),
        secondPage.click("#concurrent-download"),
      ]);
      const [firstDownload, secondDownload] = await Promise.all([
        firstPending,
        secondPending,
      ]);

      assertEqual(
        firstDownload.page(),
        firstPage,
        "the first TaskSpace receives only its download"
      );
      assertEqual(
        secondDownload.page(),
        secondPage,
        "the second TaskSpace receives only its download"
      );
      assertEqual(
        firstDownload.suggestedFilename(),
        "ego-first-download.txt",
        "the first TaskSpace keeps its response filename"
      );
      assertEqual(
        secondDownload.suggestedFilename(),
        "ego-second-download.txt",
        "the second TaskSpace keeps its response filename"
      );
      assertIncludes(
        firstDownload.url(),
        "space=first",
        "the first TaskSpace keeps its download URL"
      );
      assertIncludes(
        secondDownload.url(),
        "space=second",
        "the second TaskSpace keeps its download URL"
      );
      const [firstTemporaryPath, secondTemporaryPath] = await Promise.all([
        firstDownload.path(),
        secondDownload.path(),
      ]);
      const { dirname } = await import("node:path");
      assert(
        dirname(firstTemporaryPath) !== dirname(secondTemporaryPath),
        "concurrent TaskSpaces use isolated temporary directories"
      );

      const firstSavedPath = join(tempDir, "task-space-first-download.txt");
      const secondSavedPath = join(tempDir, "task-space-second-download.txt");
      await firstDownload.saveAs(firstSavedPath);
      await firstDownload.delete();
      await secondDownload.saveAs(secondSavedPath);
      assertEqual(
        await readFile(firstSavedPath, "utf8"),
        "ego-browser first TaskSpace download\\n",
        "the first TaskSpace saves its own response body"
      );
      assertEqual(
        await readFile(secondSavedPath, "utf8"),
        "ego-browser second TaskSpace download\\n",
        "deleting the first artifact does not affect the second TaskSpace"
      );
      await secondDownload.delete();

      const firstResetPending = firstPage.waitForEvent("download", {
        timeout: 10_000,
      });
      const secondAfterResetPending = secondPage.waitForEvent("download", {
        timeout: 10_000,
      });
      await secondPage.click("#click-button");
      await firstPage.click("#concurrent-download");
      const firstResetDownload = await firstResetPending;
      assertEqual(
        await firstResetDownload.failure(),
        null,
        "the first TaskSpace completes while the second wait stays armed"
      );
      await firstResetDownload.delete();

      await secondPage.click("#concurrent-download");
      const secondAfterResetDownload = await secondAfterResetPending;
      const secondAfterResetPath = join(
        tempDir,
        "task-space-second-after-reset.txt"
      );
      await secondAfterResetDownload.saveAs(secondAfterResetPath);
      assertEqual(
        await readFile(secondAfterResetPath, "utf8"),
        "ego-browser second TaskSpace download\\n",
        "the first TaskSpace reset does not disarm the second TaskSpace"
      );
      await secondAfterResetDownload.delete();
    } finally {
      const cleanupResults = await Promise.allSettled(
        [firstTask, secondTask]
          .filter(Boolean)
          .map((task) => task.finish({ keep: [] }))
      );
      const cleanupFailure = cleanupResults.find(
        (result) => result.status === "rejected"
      );
      if (cleanupFailure) throw cleanupFailure.reason;
    }
  `;
}

export function pagePdfViewerDownloadCase() {
  return `
    const task = await taskSpace(taskName);
    const source = await newPageAt(task, baseUrl + "/download-entry");
    const savedPath = join(tempDir, "pdf-viewer-download.pdf");
    let preview;
    try {
      const pendingPopup = source.waitForEvent("popup", { timeout: 3_000 });
      await source.click("loc=role:link[name='Preview report']");
      preview = await pendingPopup;

      assertIncludes(
        await preview.url(),
        "/api/openai-gpt-4-system-card.pdf",
        "the file link opens the PDF in a new Page instead of downloading"
      );
      const viewerDeadline = Date.now() + 10_000;
      let viewerSnapshot = "";
      let viewerToolbar;
      while (Date.now() <= viewerDeadline) {
        viewerSnapshot = await preview.snapshot({
          scope: "only_within_viewport",
        });
        viewerToolbar = viewerSnapshot.match(
          /        container\\n          button "([^"]+)"\\n            svg_root\\n          button "([^"]+)"\\n            svg_root\\n          button "([^"]+)"\\n            svg_root\\n          button "([^"]+)"/
        );
        if (viewerToolbar && viewerSnapshot.includes('text "60"')) break;
        await preview.waitForTimeout(100);
      }
      assertIncludes(
        viewerSnapshot,
        'text "60"',
        "Chromium renders the complete 60-page PDF in its viewer"
      );
      const downloadButtonName = viewerToolbar?.[2] || "";
      assert(downloadButtonName, "the PDF viewer exposes its localized download label");

      const pendingDownload = preview.waitForEvent("download", {
        timeout: 10_000,
      });
      await preview.click(
        "loc=role:button[name=" + JSON.stringify(downloadButtonName) + "]",
        { timeout: 10_000 }
      );
      const download = await pendingDownload;

      assertEqual(
        download.page(),
        preview,
        "the download belongs to the PDF viewer Page that started it"
      );
      assertIncludes(
        download.url(),
        "/api/openai-gpt-4-system-card.pdf",
        "the PDF viewer downloads its source resource"
      );
      assertEqual(
        download.suggestedFilename(),
        "openai-gpt-4-system-card.pdf",
        "the PDF viewer preserves the source filename"
      );
      assertEqual(await download.failure(), null, "the PDF viewer download completes");
      await download.saveAs(savedPath);
      const bytes = await readFile(savedPath);
      assertEqual(
        bytes.length,
        1_014_552,
        "the PDF viewer saves the complete official document"
      );
      const { createHash } = await import("node:crypto");
      assertEqual(
        createHash("sha256").update(bytes).digest("hex"),
        "ca3677e1b83e255aa1296d432d374378154f230f3c296b32ee67540d571b7004",
        "the saved PDF matches the checked-in OpenAI fixture"
      );
      await download.delete();
      assertIncludes(
        await source.url(),
        "/download-entry",
        "the source Page remains on the download entry"
      );
    } finally {
      if (preview) await preview.close().catch(() => {});
      await source.close();
    }
  `;
}

export function pageDownloadPrepareRoundCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/?page=download-across-rounds");
    const savedPath = join(tempDir, "browser-download-round-1.txt");
    await page.evaluate((downloadUrl) => {
      window.__egoDownloadRound = 1;
      const link = document.createElement("a");
      link.id = "cross-round-download-link";
      link.href = downloadUrl;
      link.textContent = "Download across rounds";
      document.body.append(link);
    }, baseUrl + "/api/download");

    const pendingDownload = page.waitForEvent("download", { timeout: 10_000 });
    await page.click("#cross-round-download-link");
    const download = await pendingDownload;
    await download.saveAs(savedPath);
    assertEqual(
      await readFile(savedPath, "utf8"),
      "ego-browser download fixture\\n",
      "the first process saves its download"
    );
    await download.delete();
    await writeFile(
      join(tempDir, "download-round-state.json"),
      JSON.stringify({ label: page.label, targetId: page.targetId })
    );
  `;
}

export function pageDownloadResumeRoundCase() {
  return `
    const task = await taskSpace(taskName);
    const saved = JSON.parse(
      await readFile(join(tempDir, "download-round-state.json"), "utf8")
    );
    const page = task.page(saved.label);
    const savedPath = join(tempDir, "browser-download-round-2.txt");

    assertEqual(
      await page.evaluate("window.__egoDownloadRound"),
      1,
      "the restored Page keeps its JavaScript state"
    );
    assertEqual(
      page.targetId,
      saved.targetId,
      "the second process restores the same Page target"
    );
    const pendingDownload = page.waitForEvent("download", { timeout: 10_000 });
    await page.click("#cross-round-download-link");
    const download = await pendingDownload;
    assertEqual(
      download.suggestedFilename(),
      "ego-download.txt",
      "the restored Page captures the second download"
    );
    await download.saveAs(savedPath);
    assertEqual(
      await readFile(savedPath, "utf8"),
      "ego-browser download fixture\\n",
      "the second process saves into its explicit destination"
    );
    await download.delete();
    await page.close();
  `;
}
