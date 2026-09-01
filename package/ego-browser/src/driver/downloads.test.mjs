import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  disposeDownloadArtifacts,
  preparePageDownload,
} from "../../dist/src/driver/downloads.js";

test("a page download is isolated in a temporary directory and can be saved", async () => {
  const calls = [];
  const listeners = new Set();
  const services = {
    async cdp(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      return {};
    },
    subscribePageEvents(_targetId, listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const interception = preparePageDownload(services, "target-1", {
    timeoutMs: 1_000,
  });

  await interception.ready("session-1");
  const allow = calls.find(
    (call) =>
      call.method === "Page.setDownloadBehavior" &&
      call.params.behavior === "allow",
  );
  assert(allow);
  assert.equal(allow.sessionId, "session-1");

  for (const listener of listeners) {
    listener({
      method: "Page.downloadWillBegin",
      params: {
        guid: "guid-1",
        url: "https://example.test/report",
        suggestedFilename: "report.txt",
      },
    });
  }
  const download = await interception.event;
  await writeFile(join(allow.params.downloadPath, "report.txt"), "contents");
  for (const listener of listeners) {
    listener({
      method: "Page.downloadProgress",
      params: {
        guid: "guid-1",
        state: "completed",
        totalBytes: 8,
        receivedBytes: 8,
      },
    });
  }

  const outputDir = await mkdtemp(join(tmpdir(), "ego-download-output-"));
  const outputPath = join(outputDir, "saved.txt");
  assert.equal(download.url, "https://example.test/report");
  assert.equal(download.suggestedFilename, "report.txt");
  assert.equal(await download.failure(), null);
  await download.cancel();
  assert.equal(
    calls.some((call) => call.method === "Browser.cancelDownload"),
    false,
    "cancel is a no-op after completion",
  );
  assert.equal(
    await download.path(),
    join(allow.params.downloadPath, "report.txt"),
  );
  await download.saveAs(outputPath);
  assert.equal(await readFile(outputPath, "utf8"), "contents");
  assert(
    calls.some(
      (call) =>
        call.method === "Page.setDownloadBehavior" &&
        call.params.behavior === "default",
    ),
  );

  await download.delete();
  await assert.rejects(access(join(allow.params.downloadPath, "report.txt")));
  await rm(outputDir, { recursive: true, force: true });
  disposeDownloadArtifacts();
});

test("saveAs waits for an in-progress download", async () => {
  const listeners = new Set();
  let downloadPath;
  const interception = preparePageDownload(
    {
      async cdp(method, params) {
        if (
          method === "Page.setDownloadBehavior" &&
          params.behavior === "allow"
        ) {
          downloadPath = params.downloadPath;
        }
        return {};
      },
      subscribePageEvents(_targetId, listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    "target-slow",
    { timeoutMs: 1_000 },
  );
  await interception.ready("session-slow");
  for (const listener of listeners) {
    listener({
      method: "Page.downloadWillBegin",
      params: {
        guid: "guid-slow",
        url: "https://example.test/slow",
        suggestedFilename: "slow.txt",
      },
    });
  }
  const download = await interception.event;
  const outputDir = await mkdtemp(join(tmpdir(), "ego-download-output-"));
  const outputPath = join(outputDir, "slow.txt");
  let saved = false;
  const save = download.saveAs(outputPath).then(() => {
    saved = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saved, false);
  await writeFile(join(downloadPath, "slow.txt"), "slow contents");
  for (const listener of listeners) {
    listener({
      method: "Page.downloadProgress",
      params: { guid: "guid-slow", state: "completed" },
    });
  }

  await save;
  assert.equal(await readFile(outputPath, "utf8"), "slow contents");
  await download.delete();
  await rm(outputDir, { recursive: true, force: true });
  disposeDownloadArtifacts();
});

test("saveAs detects a completed file without a final progress event", async () => {
  const listeners = new Set();
  let downloadPath;
  const interception = preparePageDownload(
    {
      async cdp(method, params) {
        if (
          method === "Page.setDownloadBehavior" &&
          params.behavior === "allow"
        ) {
          downloadPath = params.downloadPath;
        }
        return {};
      },
      subscribePageEvents(_targetId, listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    "target-without-progress",
    { timeoutMs: 1_000 },
  );
  await interception.ready("session-without-progress");
  for (const listener of listeners) {
    listener({
      method: "Page.downloadWillBegin",
      params: {
        guid: "guid-without-progress",
        url: "https://example.test/without-progress",
        suggestedFilename: "without-progress.txt",
      },
    });
  }
  const download = await interception.event;
  const outputDir = await mkdtemp(join(tmpdir(), "ego-download-output-"));
  const outputPath = join(outputDir, "without-progress.txt");
  const save = download.saveAs(outputPath).then(() => "saved");
  await writeFile(
    join(downloadPath, "without-progress.txt"),
    "completed without progress",
  );

  const outcome = await Promise.race([
    save,
    new Promise((resolve) => setTimeout(() => resolve("timed out"), 200)),
  ]);
  if (outcome === "saved") await download.delete();
  else await interception.dispose(new Error("test cleanup"));
  await rm(outputDir, { recursive: true, force: true });
  disposeDownloadArtifacts();

  assert.equal(outcome, "saved");
});

test("cancel scopes the download guid to its browser context", async () => {
  const calls = [];
  const listeners = new Set();
  let downloadPath;
  const interception = preparePageDownload(
    {
      async cdp(method, params, sessionId) {
        calls.push({ method, params, sessionId });
        if (
          method === "Page.setDownloadBehavior" &&
          params.behavior === "allow"
        ) {
          downloadPath = params.downloadPath;
        }
        if (method === "Target.getTargetInfo") {
          return { targetInfo: { browserContextId: "context-1" } };
        }
        return {};
      },
      subscribePageEvents(_targetId, listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    "target-1",
    { timeoutMs: 1_000 },
  );
  await interception.ready("session-1");
  for (const listener of listeners) {
    listener({
      method: "Page.downloadWillBegin",
      params: {
        guid: "guid-cancel",
        url: "https://example.test/archive",
        suggestedFilename: "archive.zip",
      },
    });
  }
  const download = await interception.event;

  await download.cancel();
  for (const listener of listeners) {
    listener({
      method: "Page.downloadProgress",
      params: { guid: "guid-cancel", state: "canceled" },
    });
  }

  assert(
    calls.some(
      (call) =>
        call.method === "Browser.cancelDownload" &&
        call.params.guid === "guid-cancel" &&
        call.params.browserContextId === "context-1" &&
        call.sessionId === undefined,
    ),
  );
  assert.equal(
    calls.some((call) => call.method === "Browser.setDownloadBehavior"),
    false,
  );
  assert.equal(await download.failure(), "canceled");
  await assert.rejects(download.path(), /download failed: canceled/);
  await download.delete();
  await assert.rejects(access(downloadPath));
  disposeDownloadArtifacts();
});

test("one target cannot arm two download directories at the same time", async () => {
  const listeners = new Set();
  const services = {
    async cdp() {
      return {};
    },
    subscribePageEvents(_targetId, listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const first = preparePageDownload(services, "target-shared", {
    timeoutMs: 1_000,
  });
  void first.event.catch(() => {});

  assert.throws(
    () =>
      preparePageDownload(services, "target-shared", {
        timeoutMs: 1_000,
      }),
    /target-shared is already waiting for a download/,
  );

  await first.dispose();
  disposeDownloadArtifacts();
});

test("different targets download concurrently into isolated directories", async () => {
  const listeners = new Map();
  const downloadPaths = new Map();
  const services = {
    async cdp(method, params, sessionId) {
      if (
        method === "Page.setDownloadBehavior" &&
        params.behavior === "allow"
      ) {
        downloadPaths.set(sessionId, params.downloadPath);
      }
      return {};
    },
    subscribePageEvents(targetId, listener) {
      listeners.set(targetId, listener);
      return () => listeners.delete(targetId);
    },
  };
  const first = preparePageDownload(services, "target-a", {
    timeoutMs: 1_000,
  });
  const second = preparePageDownload(services, "target-b", {
    timeoutMs: 1_000,
  });
  await Promise.all([first.ready("session-a"), second.ready("session-b")]);
  assert.notEqual(
    downloadPaths.get("session-a"),
    downloadPaths.get("session-b"),
  );

  listeners.get("target-a")({
    method: "Page.downloadWillBegin",
    params: {
      guid: "guid-a",
      url: "https://example.test/a",
      suggestedFilename: "a.txt",
    },
  });
  listeners.get("target-b")({
    method: "Page.downloadWillBegin",
    params: {
      guid: "guid-b",
      url: "https://example.test/b",
      suggestedFilename: "b.txt",
    },
  });
  const [downloadA, downloadB] = await Promise.all([first.event, second.event]);
  await Promise.all([
    writeFile(join(downloadPaths.get("session-a"), "a.txt"), "contents-a"),
    writeFile(join(downloadPaths.get("session-b"), "b.txt"), "contents-b"),
  ]);
  listeners.get("target-b")({
    method: "Page.downloadProgress",
    params: { guid: "guid-b", state: "completed" },
  });
  listeners.get("target-a")({
    method: "Page.downloadProgress",
    params: { guid: "guid-a", state: "completed" },
  });

  assert.equal(await readFile(await downloadA.path(), "utf8"), "contents-a");
  assert.equal(await readFile(await downloadB.path(), "utf8"), "contents-b");
  await Promise.all([downloadA.delete(), downloadB.delete()]);
  disposeDownloadArtifacts();
});

test("a download wait times out and restores the Page default", async () => {
  const calls = [];
  const interception = preparePageDownload(
    {
      async cdp(method, params, sessionId) {
        calls.push({ method, params, sessionId });
        return {};
      },
      subscribePageEvents() {
        return () => {};
      },
    },
    "target-timeout",
    { timeoutMs: 5 },
  );
  await interception.ready("session-timeout");

  await assert.rejects(
    interception.event,
    /page\.waitForEvent\("download"\) timed out after 5ms/,
  );
  assert(
    calls.some(
      (call) =>
        call.method === "Page.setDownloadBehavior" &&
        call.params.behavior === "default" &&
        call.sessionId === "session-timeout",
    ),
  );
  disposeDownloadArtifacts();
});

test("the target stays reserved until its Page behavior is restored", async () => {
  const listeners = new Set();
  let downloadPath;
  let restoreDefault;
  let markRestoreStarted;
  const restoreStarted = new Promise((resolve) => {
    markRestoreStarted = resolve;
  });
  const defaultRestored = new Promise((resolve) => {
    restoreDefault = resolve;
  });
  const services = {
    async cdp(method, params) {
      if (
        method === "Page.setDownloadBehavior" &&
        params.behavior === "allow"
      ) {
        downloadPath = params.downloadPath;
      }
      if (
        method === "Page.setDownloadBehavior" &&
        params.behavior === "default"
      ) {
        markRestoreStarted();
        await defaultRestored;
      }
      return {};
    },
    subscribePageEvents(_targetId, listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const first = preparePageDownload(services, "target-restoring", {
    timeoutMs: 1_000,
  });
  await first.ready("session-restoring");
  for (const listener of listeners) {
    listener({
      method: "Page.downloadWillBegin",
      params: {
        guid: "guid-restoring",
        url: "https://example.test/restoring",
        suggestedFilename: "restoring.txt",
      },
    });
  }
  const download = await first.event;
  await writeFile(join(downloadPath, "restoring.txt"), "restored");
  for (const listener of listeners) {
    listener({
      method: "Page.downloadProgress",
      params: { guid: "guid-restoring", state: "completed" },
    });
  }
  const completed = download.failure();
  await restoreStarted;

  assert.throws(
    () =>
      preparePageDownload(services, "target-restoring", {
        timeoutMs: 1_000,
      }),
    /target-restoring is already waiting for a download/,
  );

  restoreDefault();
  assert.equal(await completed, null);
  const next = preparePageDownload(services, "target-restoring", {
    timeoutMs: 1_000,
  });
  void next.event.catch(() => {});
  await next.dispose();
  disposeDownloadArtifacts();
});
