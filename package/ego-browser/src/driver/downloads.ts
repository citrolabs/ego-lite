import { mkdirSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

import { cdp } from "../cdp-eval.js";
import { ensureSession, waitForBrowserEvent } from "../browser-runtime.js";
import { state } from "../state.js";

type WaitForEventOptions = {
  timeout?: number;
};

type DownloadWillBegin = {
  method: "Page.downloadWillBegin";
  params?: {
    guid?: string;
    url?: string;
    suggestedFilename?: string;
  };
};

type DownloadProgress = {
  method: "Page.downloadProgress";
  params?: {
    guid?: string;
    state?: string;
  };
};

/**
 * Wait for a Playwright-style page event. Currently supports "download".
 * @param {"download"} eventName Event name.
 * @param {{timeout?: number}} [options] Timeout in milliseconds.
 * @returns {Promise<object>} Download facade with suggestedFilename(), path(), saveAs(path), url().
 */
export async function waitForEvent(
  eventName,
  options: WaitForEventOptions = {},
) {
  if (eventName !== "download") {
    throw new Error(
      `page.waitForEvent currently supports only "download", got ${JSON.stringify(eventName)}`,
    );
  }
  return waitForDownload(options);
}

async function waitForDownload(options: WaitForEventOptions = {}) {
  const timeout = options.timeout ?? state.defaultTimeout;
  const downloadDir = join(
    tmpdir(),
    `ego-browser-downloads-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(downloadDir, { recursive: true });
  const sessionPromise = ensureSession();
  const behaviorPromise = setDownloadBehavior(downloadDir);
  const willBeginPromise = waitForBrowserEvent(
    (event) => event?.method === "Page.downloadWillBegin",
    timeout,
  ) as Promise<DownloadWillBegin>;
  let downloadGuid;
  const progressPromise = waitForBrowserEvent(
    (event) =>
      event?.method === "Page.downloadProgress" &&
      (!downloadGuid || event?.params?.guid === downloadGuid) &&
      (event?.params?.state === "completed" ||
        event?.params?.state === "canceled"),
    timeout,
  ) as Promise<DownloadProgress>;
  const [, naming] = await Promise.all([sessionPromise, behaviorPromise]);
  const willBegin = await willBeginPromise;
  const guid = willBegin.params?.guid;
  downloadGuid = guid;
  const suggestedFilename =
    willBegin.params?.suggestedFilename || guid || "download";
  const progress = await progressPromise;
  if (progress.params?.state === "canceled") {
    throw new Error(`Download canceled: ${suggestedFilename}`);
  }
  // Under "allowAndName" the browser writes the file as its download guid, so
  // the reported path cannot drift from the on-disk name. Under plain "allow"
  // (the Page-level fallback) the browser chooses the name itself — it
  // sanitizes suggestedFilename per platform and deduplicates collisions with
  // " (1)" suffixes — so suggestedFilename is the best available guess there.
  const fileName = naming === "guid" && guid ? guid : suggestedFilename;
  const downloadedPath = confinePath(downloadDir, fileName);
  return {
    suggestedFilename: () => suggestedFilename,
    url: () => willBegin.params?.url || "",
    path: async () => downloadedPath,
    saveAs: async (targetPath) => {
      await copyFile(downloadedPath, targetPath);
      return targetPath;
    },
  };
}

// Prefer Playwright's naming scheme: "allowAndName" saves the file as its
// download guid inside downloadDir. Page.setDownloadBehavior (the fallback
// for runtimes without the Browser-level command) only supports "allow", so
// in that mode the on-disk name stays browser-chosen and the caller derives
// the path from suggestedFilename instead.
async function setDownloadBehavior(downloadDir) {
  try {
    await cdp("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath: downloadDir,
      eventsEnabled: true,
    });
    return "guid";
  } catch (error) {
    if (
      !/Browser\.setDownloadBehavior.*wasn't found|wasn't found/i.test(
        error?.message || "",
      )
    ) {
      throw error;
    }
    await cdp("Page.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadDir,
    });
    return "name";
  }
}

// Refuse a composed path that escapes downloadDir. Chromium sanitizes path
// separators out of suggestedFilename before emitting the download events, so
// a well-behaved runtime never trips this; it guards the boundary against an
// event source that does not sanitize.
function confinePath(downloadDir, fileName) {
  const composed = resolve(downloadDir, fileName);
  if (!composed.startsWith(downloadDir + sep)) {
    throw new Error(
      `download path escapes the download directory: ${JSON.stringify(fileName)}`,
    );
  }
  return composed;
}
