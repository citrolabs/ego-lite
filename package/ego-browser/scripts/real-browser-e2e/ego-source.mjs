export function egoSource(body, context) {
  const {
    taskName,
    baseUrl,
    artifactDir,
    tempDir,
    uploadPath,
    uploadPathTwo,
    explicitScreenshotPath,
    environmentScreenshotPath,
    metadataPath,
    keepTaskSpace,
  } = context;
  return `
    const { readFile, readdir, stat, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { inflateSync } = await import("node:zlib");
    const taskName = ${JSON.stringify(taskName)};
    const baseUrl = ${JSON.stringify(baseUrl)};
    const artifactDir = ${JSON.stringify(artifactDir)};
    const tempDir = ${JSON.stringify(tempDir)};
    const uploadPath = ${JSON.stringify(uploadPath)};
    const uploadPathTwo = ${JSON.stringify(uploadPathTwo)};
    const explicitScreenshotPath = ${JSON.stringify(explicitScreenshotPath)};
    const environmentScreenshotPath = ${JSON.stringify(environmentScreenshotPath)};
    const metadataPath = ${JSON.stringify(metadataPath)};
    const keepTaskSpace = ${JSON.stringify(keepTaskSpace)};

    // The Ego Lite launcher does not forward arbitrary environment variables
    // to the SDK Node process. Set isolated test configuration before the first
    // taskSpace() call; page-model reads these values lazily.
    process.env.EGO_BROWSER_STATE_DIR = join(tempDir, "runtime-state");
    process.env.EGO_BROWSER_PAGE_BUDGET = "3";

    // Ledger files are scoped by browser instance (this isolated state
    // directory belongs to the one Ego Lite instance under test) and
    // versioned: every SDK write creates space-<id>@<instance>.<n>.json and
    // removes the versions before it. The current ledger is the highest
    // version that parses, and a path listed a moment ago may already be
    // gone, so read through readPageLedger instead of holding on to a path.
    async function pageLedgerVersions(spaceId) {
      const stateDir = process.env.EGO_BROWSER_STATE_DIR;
      const prefix = "space-" + spaceId + "@";
      const names = await readdir(stateDir).catch(() => []);
      return names
        .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
        .map((name) => ({
          name,
          seq: Number(/\\.(\\d+)\\.json$/.exec(name)?.[1] ?? 0),
        }))
        .sort((a, b) => b.seq - a.seq)
        .map((entry) => join(stateDir, entry.name));
    }

    async function pageLedgerPath(spaceId) {
      const [latest] = await pageLedgerVersions(spaceId);
      assert(Boolean(latest), "a page ledger exists for space " + spaceId);
      return latest;
    }

    async function readPageLedger(spaceId) {
      for (let attempt = 0; attempt < 5; attempt++) {
        for (const path of await pageLedgerVersions(spaceId)) {
          try {
            return JSON.parse(await readFile(path, "utf8"));
          } catch {
            // Superseded between listing and reading, or still being written.
          }
        }
      }
      throw new Error("no readable page ledger for space " + spaceId);
    }

    let __assertionCount = 0;

    function assert(condition, message) {
      __assertionCount++;
      if (!condition) throw new Error(message);
    }

    function assertEqual(actual, expected, message) {
      __assertionCount++;
      if (actual !== expected) {
        throw new Error(
          message + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual)
        );
      }
    }

    function assertIncludes(text, expected, message) {
      __assertionCount++;
      assert(
        String(text).includes(expected),
        message + ": expected " + JSON.stringify(String(text).slice(0, 500)) + " to include " + JSON.stringify(expected)
      );
    }

    function countColorfulPngSamples(png) {
      const signature = "89504e470d0a1a0a";
      assertEqual(png.subarray(0, 8).toString("hex"), signature, "artifact is a PNG");
      let width = 0;
      let height = 0;
      let bitDepth = 0;
      let colorType = 0;
      let interlace = 0;
      const imageData = [];
      for (let offset = 8; offset < png.length; ) {
        const length = png.readUInt32BE(offset);
        const type = png.subarray(offset + 4, offset + 8).toString("ascii");
        const data = png.subarray(offset + 8, offset + 8 + length);
        if (type === "IHDR") {
          width = data.readUInt32BE(0);
          height = data.readUInt32BE(4);
          bitDepth = data[8];
          colorType = data[9];
          interlace = data[12];
        } else if (type === "IDAT") {
          imageData.push(data);
        }
        offset += length + 12;
        if (type === "IEND") break;
      }
      assertEqual(bitDepth, 8, "PNG sampler supports 8-bit screenshots");
      assertEqual(interlace, 0, "PNG sampler supports non-interlaced screenshots");
      const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 })[colorType];
      assert(channels, "PNG sampler supports the screenshot color type");
      const inflated = inflateSync(Buffer.concat(imageData));
      const stride = width * channels;
      const pixels = Buffer.alloc(stride * height);
      let sourceOffset = 0;
      for (let y = 0; y < height; y++) {
        const filter = inflated[sourceOffset++];
        const rowOffset = y * stride;
        const previousOffset = (y - 1) * stride;
        for (let x = 0; x < stride; x++) {
          const raw = inflated[sourceOffset++];
          const left = x >= channels ? pixels[rowOffset + x - channels] : 0;
          const up = y > 0 ? pixels[previousOffset + x] : 0;
          const upperLeft = y > 0 && x >= channels
            ? pixels[previousOffset + x - channels]
            : 0;
          let predictor = 0;
          if (filter === 1) predictor = left;
          else if (filter === 2) predictor = up;
          else if (filter === 3) predictor = Math.floor((left + up) / 2);
          else if (filter === 4) {
            const estimate = left + up - upperLeft;
            const leftDistance = Math.abs(estimate - left);
            const upDistance = Math.abs(estimate - up);
            const upperLeftDistance = Math.abs(estimate - upperLeft);
            predictor = leftDistance <= upDistance && leftDistance <= upperLeftDistance
              ? left
              : upDistance <= upperLeftDistance
                ? up
                : upperLeft;
          } else if (filter !== 0) {
            throw new Error("Unsupported PNG filter " + filter);
          }
          pixels[rowOffset + x] = (raw + predictor) & 255;
        }
      }

      let colorful = 0;
      let sampled = 0;
      for (let row = 1; row <= 5; row++) {
        for (let column = 1; column <= 5; column++) {
          const x = Math.floor((width * column) / 6);
          const y = Math.floor((height * row) / 6);
          const offset = y * stride + x * channels;
          const red = pixels[offset];
          const green = colorType === 0 || colorType === 4 ? red : pixels[offset + 1];
          const blue = colorType === 0 || colorType === 4 ? red : pixels[offset + 2];
          sampled++;
          if (Math.max(red, green, blue) - Math.min(red, green, blue) > 30) colorful++;
        }
      }
      return { colorful, sampled, width, height };
    }

    async function assertRejects(fn, expected, message) {
      __assertionCount++;
      try {
        await fn();
      } catch (error) {
        assertIncludes(error?.message || String(error), expected, message);
        return;
      }
      throw new Error(message + ": expected rejection");
    }

    async function assertRejectsAny(fn, message) {
      __assertionCount++;
      try {
        await fn();
      } catch {
        return;
      }
      throw new Error(message + ": expected rejection");
    }

    async function newPageAt(task, url, options = {}) {
      const page = await task.newPage();
      await page.goto(url, options);
      return page;
    }

    async function waitForJsValue(expression, expected, message, debugExpression = null) {
      const deadline = Date.now() + 2000;
      let last;
      while (Date.now() <= deadline) {
        last = await js(expression);
        if (last === expected) return last;
        await wait(0.05);
      }
      let detail = "";
      if (debugExpression) {
        detail = "; debug=" + JSON.stringify(await js(debugExpression));
      }
      throw new Error(
        message + detail + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(last)
      );
    }

    async function waitForJsCondition(expression, message, debugExpression = null) {
      const deadline = Date.now() + 2000;
      let last;
      while (Date.now() <= deadline) {
        last = await js(expression);
        if (last) return last;
        await wait(0.05);
      }
      let detail = "";
      if (debugExpression) {
        detail = "; debug=" + JSON.stringify(await js(debugExpression));
      }
      throw new Error(message + detail + ": condition stayed false, last value " + JSON.stringify(last));
    }

    async function setStableViewport() {
      await cdp("Page.bringToFront").catch(() => {});
      await cdp("Emulation.clearDeviceMetricsOverride").catch(() => {});
      await setViewportSize({ width: 1280, height: 800 });
      await wait(0.1);
    }

    async function hitTestClickButton() {
      return js(
        "const el = document.querySelector('#click-button');" +
          "if (!el) return '';" +
          "const r = el.getBoundingClientRect();" +
          "const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);" +
          "return hit?.closest?.('#click-button')?.id || hit?.id || '';"
      ).catch(() => "");
    }

    async function closeFixtureTabs() {
      const tabs = await listTabs({ includeChrome: false }).catch(() => []);
      for (const tab of tabs) {
        if (String(tab.url || "").startsWith(baseUrl)) {
          await closeTab(tab.targetId).catch(() => {});
        }
      }
    }

    async function resetHome() {
      await takeOverTaskSpace(taskName).catch(() => {});
      await waitForAgentControl(taskName, { interval: 0.1, timeout: 5 });
      await closeFixtureTabs();
      const tab = await openOrReuseTab(baseUrl + "/?e2e-reset=" + Date.now(), { wait: true, timeout: 10 });
      await switchTab(tab.targetId);
      await setStableViewport();
      const nav = await gotoAndWait(baseUrl + "/", { timeout: 10 });
      assert(nav.loaded, "home page loaded");
      await setStableViewport();
      assert(
        await waitForElement("#click-button", { timeout: 3, visible: true }),
        "home fixture click button is visible"
      );
      for (let i = 0; i < 10; i += 1) {
        const info = await pageInfo();
        if (info.w > 0 && info.h > 0 && await hitTestClickButton() === "click-button") return tab;
        await setStableViewport();
      }
      const info = await pageInfo();
      assert(info.w > 0 && info.h > 0, "viewport initialized with non-zero size");
      assertEqual(await hitTestClickButton(), "click-button", "viewport hit-testing reaches the click fixture");
      return tab;
    }

    // Page ledgers persist across cases and the budget is three Pages. Record
    // the Pages each space already had so a failed case can close only the
    // Pages it opened instead of exhausting the budget for every later case.
    // Read the ledger file: task.pages() can adopt the active tab as a Page.
    const __pagesBeforeCase = new Map();
    const __taskSpace = taskSpace;
    taskSpace = async (...args) => {
      const task = await __taskSpace(...args);
      if (!__pagesBeforeCase.has(task.spaceId)) {
        __pagesBeforeCase.set(task.spaceId, {
          task,
          targetIds: await ledgerTargetIds(task.spaceId),
        });
      }
      return task;
    };

    async function ledgerTargetIds(spaceId) {
      const ledger = await readPageLedger(spaceId).catch(() => ({}));
      return new Set(
        Object.values(ledger.pages || {}).map((page) => page.targetId)
      );
    }

    async function closePagesOpenedByCase() {
      for (const { task, targetIds } of __pagesBeforeCase.values()) {
        const pages = await task.pages().catch(() => []);
        for (const page of pages) {
          if (!targetIds.has(page.targetId)) await page.close().catch(() => {});
        }
      }
    }

    try {
      ${body}
      cliLog(JSON.stringify({ ok: true, assertions: __assertionCount }));
    } catch (error) {
      cliLog(JSON.stringify({ ok: false, assertions: __assertionCount, error: error.message }));
      await closePagesOpenedByCase().catch(() => {});
      error.message = ${JSON.stringify("real browser e2e")} + ": " + error.message;
      throw error;
    }
  `;
}
