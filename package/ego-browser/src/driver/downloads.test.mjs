import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import {
  access,
  mkdtemp,
  readFile,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The shared download directory lives under the runtime state directory;
// keep this test process away from the user's real one.
const stateDir = mkdtempSync(join(tmpdir(), "ego-download-state-"));
process.env.EGO_BROWSER_STATE_DIR = stateDir;

const { disposeDownloadArtifacts, downloadDirectory, preparePageDownload } =
  await import("../../dist/src/driver/downloads.js");

const sharedDirectory = join(stateDir, "downloads");
const waiterMarker = (pid) => join(sharedDirectory, "waiters", String(pid));

function recordingServices(calls = [], listeners = new Map()) {
  return {
    calls,
    listeners,
    async cdp(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      return {};
    },
    subscribePageEvents(targetId, listener) {
      listeners.set(targetId, listener);
      return () => listeners.delete(targetId);
    },
  };
}

function beginDownload(services, targetId, guid, suggestedFilename) {
  services.listeners.get(targetId)({
    method: "Page.downloadWillBegin",
    params: { guid, url: `https://example.test/${guid}`, suggestedFilename },
  });
}

function completeDownload(services, targetId, guid) {
  services.listeners.get(targetId)({
    method: "Page.downloadProgress",
    params: { guid, state: "completed" },
  });
}

function behaviorCalls(calls) {
  return calls
    .filter((call) => call.method === "Page.setDownloadBehavior")
    .map((call) => ({
      behavior: call.params.behavior,
      sessionId: call.sessionId,
    }));
}

test("a page download lands in the shared directory under its guid and can be saved", async () => {
  const services = recordingServices();
  const interception = preparePageDownload(services, "target-1", {
    timeoutMs: 1_000,
  });

  await interception.ready("session-1");
  const armed = services.calls.find(
    (call) => call.method === "Page.setDownloadBehavior",
  );
  assert.deepEqual(armed, {
    method: "Page.setDownloadBehavior",
    params: { behavior: "allowAndName", downloadPath: sharedDirectory },
    sessionId: "session-1",
  });
  assert.equal(downloadDirectory(), sharedDirectory);
  await access(waiterMarker(process.pid));

  beginDownload(services, "target-1", "guid-1", "report.txt");
  const download = await interception.event;
  await writeFile(join(sharedDirectory, "guid-1"), "contents");
  completeDownload(services, "target-1", "guid-1");

  const outputDir = await mkdtemp(join(tmpdir(), "ego-download-output-"));
  const outputPath = join(outputDir, "saved.txt");
  assert.equal(download.url, "https://example.test/guid-1");
  assert.equal(download.suggestedFilename, "report.txt");
  assert.equal(await download.failure(), null);
  await download.cancel();
  assert.equal(
    services.calls.some((call) => call.method === "Browser.cancelDownload"),
    false,
    "cancel is a no-op after completion",
  );
  assert.equal(await download.path(), join(sharedDirectory, "guid-1"));
  await download.saveAs(outputPath);
  assert.equal(await readFile(outputPath, "utf8"), "contents");
  assert.deepEqual(behaviorCalls(services.calls).at(-1), {
    behavior: "default",
    sessionId: "session-1",
  });
  await assert.rejects(
    access(waiterMarker(process.pid)),
    "the last waiter removes its marker",
  );

  await download.delete();
  await assert.rejects(access(join(sharedDirectory, "guid-1")));
  await access(sharedDirectory);
  await rm(outputDir, { recursive: true, force: true });
  disposeDownloadArtifacts();
});

test("saveAs waits for an in-progress download", async () => {
  const services = recordingServices();
  const interception = preparePageDownload(services, "target-slow", {
    timeoutMs: 1_000,
  });
  await interception.ready("session-slow");
  beginDownload(services, "target-slow", "guid-slow", "slow.txt");
  const download = await interception.event;
  const outputDir = await mkdtemp(join(tmpdir(), "ego-download-output-"));
  const outputPath = join(outputDir, "slow.txt");
  let saved = false;
  const save = download.saveAs(outputPath).then(() => {
    saved = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saved, false);
  await writeFile(join(sharedDirectory, "guid-slow"), "slow contents");
  completeDownload(services, "target-slow", "guid-slow");

  await save;
  assert.equal(await readFile(outputPath, "utf8"), "slow contents");
  await download.delete();
  await rm(outputDir, { recursive: true, force: true });
  disposeDownloadArtifacts();
});

test("saveAs detects a completed file without a final progress event", async () => {
  const services = recordingServices();
  const interception = preparePageDownload(
    services,
    "target-without-progress",
    {
      timeoutMs: 1_000,
    },
  );
  await interception.ready("session-without-progress");
  beginDownload(
    services,
    "target-without-progress",
    "guid-without-progress",
    "without-progress.txt",
  );
  const download = await interception.event;
  const outputDir = await mkdtemp(join(tmpdir(), "ego-download-output-"));
  const outputPath = join(outputDir, "without-progress.txt");
  const save = download.saveAs(outputPath).then(() => "saved");
  await writeFile(
    join(sharedDirectory, "guid-without-progress"),
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

test("a partial .crdownload file does not complete the download", async () => {
  const services = recordingServices();
  const interception = preparePageDownload(services, "target-partial", {
    timeoutMs: 1_000,
  });
  await interception.ready("session-partial");
  beginDownload(services, "target-partial", "guid-partial", "partial.bin");
  const download = await interception.event;
  const partialPath = join(sharedDirectory, "guid-partial.crdownload");
  await writeFile(partialPath, "partial");
  let state = "pending";
  const path = download.path().then(
    (value) => {
      state = "resolved";
      return value;
    },
    () => {
      state = "rejected";
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(state, "pending", "the intermediate file is not the download");

  await rename(partialPath, join(sharedDirectory, "guid-partial"));
  assert.equal(await path, join(sharedDirectory, "guid-partial"));
  await download.delete();
  disposeDownloadArtifacts();
});

test("cancel scopes the download guid to its browser context", async () => {
  const services = recordingServices();
  services.cdp = async (method, params, sessionId) => {
    services.calls.push({ method, params, sessionId });
    if (method === "Target.getTargetInfo") {
      return { targetInfo: { browserContextId: "context-1" } };
    }
    return {};
  };
  const interception = preparePageDownload(services, "target-1", {
    timeoutMs: 1_000,
  });
  await interception.ready("session-1");
  beginDownload(services, "target-1", "guid-cancel", "archive.zip");
  const download = await interception.event;

  await download.cancel();
  services.listeners.get("target-1")({
    method: "Page.downloadProgress",
    params: { guid: "guid-cancel", state: "canceled" },
  });

  assert(
    services.calls.some(
      (call) =>
        call.method === "Browser.cancelDownload" &&
        call.params.guid === "guid-cancel" &&
        call.params.browserContextId === "context-1" &&
        call.sessionId === undefined,
    ),
  );
  assert.equal(
    services.calls.some(
      (call) => call.method === "Browser.setDownloadBehavior",
    ),
    false,
  );
  assert.equal(await download.failure(), "canceled");
  await assert.rejects(download.path(), /download failed: canceled/);
  await download.delete();
  await assert.rejects(access(join(sharedDirectory, "guid-cancel")));
  disposeDownloadArtifacts();
});

test("a rejected ready still restores the session it may have configured", async () => {
  const services = recordingServices();
  services.cdp = async (method, params, sessionId) => {
    services.calls.push({ method, params, sessionId });
    if (params.behavior === "allowAndName") {
      throw new Error("Page.setDownloadBehavior timed out after 3000ms");
    }
    return {};
  };
  const interception = preparePageDownload(services, "target-rejected", {
    timeoutMs: 1_000,
  });
  void interception.event.catch(() => {});

  await assert.rejects(interception.ready("session-rejected"), /timed out/);
  await access(waiterMarker(process.pid));
  await interception.dispose(new Error("arming failed"));

  assert.deepEqual(behaviorCalls(services.calls), [
    { behavior: "allowAndName", sessionId: "session-rejected" },
    { behavior: "default", sessionId: "session-rejected" },
  ]);
  await assert.rejects(access(waiterMarker(process.pid)));
  disposeDownloadArtifacts();
});

test("one target cannot arm two download waits at the same time", async () => {
  const services = recordingServices();
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

test("different targets download concurrently into the shared directory under their own guids", async () => {
  const services = recordingServices();
  const first = preparePageDownload(services, "target-a", {
    timeoutMs: 1_000,
  });
  const second = preparePageDownload(services, "target-b", {
    timeoutMs: 1_000,
  });
  await first.ready("session-a");
  // The first download starts before the second Page arms, so Chromium
  // determines its target under whichever setting is current: identical.
  beginDownload(services, "target-a", "guid-a", "a.txt");
  await second.ready("session-b");
  beginDownload(services, "target-b", "guid-b", "b.txt");
  const armed = services.calls.filter(
    (call) => call.method === "Page.setDownloadBehavior",
  );
  assert.deepEqual(
    armed.map((call) => call.params),
    [
      { behavior: "allowAndName", downloadPath: sharedDirectory },
      { behavior: "allowAndName", downloadPath: sharedDirectory },
    ],
    "every Page applies the same shared setting",
  );

  const [downloadA, downloadB] = await Promise.all([first.event, second.event]);
  await Promise.all([
    writeFile(join(sharedDirectory, "guid-a"), "contents-a"),
    writeFile(join(sharedDirectory, "guid-b"), "contents-b"),
  ]);
  completeDownload(services, "target-b", "guid-b");
  completeDownload(services, "target-a", "guid-a");

  assert.equal(await readFile(await downloadA.path(), "utf8"), "contents-a");
  assert.equal(await readFile(await downloadB.path(), "utf8"), "contents-b");
  assert.equal(
    behaviorCalls(services.calls).filter((call) => call.behavior === "default")
      .length,
    1,
    "only the last waiter restores the default behavior",
  );
  await Promise.all([downloadA.delete(), downloadB.delete()]);
  disposeDownloadArtifacts();
});

test("a download wait times out and restores the Page default", async () => {
  const services = recordingServices();
  const interception = preparePageDownload(services, "target-timeout", {
    timeoutMs: 5,
  });
  await interception.ready("session-timeout");

  await assert.rejects(
    interception.event,
    /page\.waitForEvent\("download"\) timed out after 5ms/,
  );
  assert.deepEqual(behaviorCalls(services.calls).at(-1), {
    behavior: "default",
    sessionId: "session-timeout",
  });
  disposeDownloadArtifacts();
});

test("the target stays reserved until its Page behavior is restored", async () => {
  let restoreDefault;
  let markRestoreStarted;
  const restoreStarted = new Promise((resolve) => {
    markRestoreStarted = resolve;
  });
  const defaultRestored = new Promise((resolve) => {
    restoreDefault = resolve;
  });
  const services = recordingServices();
  services.cdp = async (method, params) => {
    if (
      method === "Page.setDownloadBehavior" &&
      params.behavior === "default"
    ) {
      markRestoreStarted();
      await defaultRestored;
    }
    return {};
  };
  const first = preparePageDownload(services, "target-restoring", {
    timeoutMs: 1_000,
  });
  await first.ready("session-restoring");
  beginDownload(
    services,
    "target-restoring",
    "guid-restoring",
    "restoring.txt",
  );
  const download = await first.event;
  await writeFile(join(sharedDirectory, "guid-restoring"), "restored");
  completeDownload(services, "target-restoring", "guid-restoring");
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
  await download.delete();
  disposeDownloadArtifacts();
});

test("a finished download keeps the shared behavior while another target still waits", async () => {
  const services = recordingServices();
  const first = preparePageDownload(services, "target-a", { timeoutMs: 1_000 });
  const second = preparePageDownload(services, "target-b", {
    timeoutMs: 1_000,
  });
  await first.ready("session-a");
  await second.ready("session-b");

  beginDownload(services, "target-a", "guid-a", "a.txt");
  const downloadA = await first.event;
  await writeFile(join(sharedDirectory, "guid-a"), "contents-a");
  completeDownload(services, "target-a", "guid-a");
  await downloadA.path();

  assert.equal(
    behaviorCalls(services.calls).some((call) => call.behavior === "default"),
    false,
    "the shared behavior is not reset while another target waits",
  );
  await access(waiterMarker(process.pid));

  await second.dispose();
  assert.deepEqual(
    behaviorCalls(services.calls).at(-1),
    { behavior: "default", sessionId: "session-b" },
    "the last waiter to go restores the default behavior",
  );
  await downloadA.delete();
  disposeDownloadArtifacts();
});

test("the default behavior waits for a live waiter in another process", async () => {
  // The test runner's parent process stands in for another ego-browser round.
  const foreignMarker = waiterMarker(process.ppid);
  await writeFile(foreignMarker, JSON.stringify({ pid: process.ppid }));
  const services = recordingServices();
  const interception = preparePageDownload(services, "target-foreign", {
    timeoutMs: 1_000,
  });
  await interception.ready("session-foreign");
  beginDownload(services, "target-foreign", "guid-foreign", "foreign.txt");
  const download = await interception.event;
  await writeFile(join(sharedDirectory, "guid-foreign"), "foreign");
  completeDownload(services, "target-foreign", "guid-foreign");
  await download.path();

  assert.equal(
    behaviorCalls(services.calls).some((call) => call.behavior === "default"),
    false,
    "another process still waits, so the behavior stays",
  );
  await assert.rejects(
    access(waiterMarker(process.pid)),
    "this process still removes its own marker",
  );
  await access(foreignMarker);
  await rm(foreignMarker, { force: true });
  await download.delete();
  disposeDownloadArtifacts();
});

test("a process that registers while the reset is in flight gets the setting back", async () => {
  const foreignMarker = waiterMarker(process.ppid);
  const services = recordingServices();
  services.cdp = async (method, params, sessionId) => {
    services.calls.push({ method, params, sessionId });
    if (
      method === "Page.setDownloadBehavior" &&
      params.behavior === "default"
    ) {
      // Another process arms between this process's marker check and the
      // reset reaching Chromium.
      await writeFile(foreignMarker, JSON.stringify({ pid: process.ppid }));
    }
    return {};
  };
  const interception = preparePageDownload(services, "target-late", {
    timeoutMs: 1_000,
  });
  await interception.ready("session-late");
  beginDownload(services, "target-late", "guid-late", "late.txt");
  const download = await interception.event;
  await writeFile(join(sharedDirectory, "guid-late"), "late");
  completeDownload(services, "target-late", "guid-late");
  await download.path();

  assert.deepEqual(behaviorCalls(services.calls).slice(-2), [
    { behavior: "default", sessionId: "session-late" },
    { behavior: "allowAndName", sessionId: "session-late" },
  ]);
  await rm(foreignMarker, { force: true });
  await download.delete();
  disposeDownloadArtifacts();
});

test("a marker left by a dead process does not block the default behavior", async () => {
  const exited = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  assert.equal(exited.status, 0);
  const staleMarker = waiterMarker(exited.pid);
  await writeFile(staleMarker, JSON.stringify({ pid: exited.pid }));
  const services = recordingServices();
  const interception = preparePageDownload(services, "target-stale", {
    timeoutMs: 1_000,
  });
  await interception.ready("session-stale");
  beginDownload(services, "target-stale", "guid-stale", "stale.txt");
  const download = await interception.event;
  await writeFile(join(sharedDirectory, "guid-stale"), "stale");
  completeDownload(services, "target-stale", "guid-stale");
  await download.path();

  assert.deepEqual(behaviorCalls(services.calls).at(-1), {
    behavior: "default",
    sessionId: "session-stale",
  });
  await assert.rejects(access(staleMarker), "the stale marker is removed");
  await download.delete();
  disposeDownloadArtifacts();
});

test("a marker that stopped aging is stale even when its pid is alive", async () => {
  // The runner's pid is alive, but a marker it has not refreshed for over an
  // hour belongs to a dead process whose pid was reused.
  const reusedMarker = waiterMarker(process.ppid);
  await writeFile(reusedMarker, JSON.stringify({ pid: process.ppid }));
  const old = new Date(Date.now() - 2 * 60 * 60 * 1_000);
  await utimes(reusedMarker, old, old);
  const services = recordingServices();
  const interception = preparePageDownload(services, "target-reused", {
    timeoutMs: 1_000,
  });
  await interception.ready("session-reused");
  beginDownload(services, "target-reused", "guid-reused", "reused.txt");
  const download = await interception.event;
  await writeFile(join(sharedDirectory, "guid-reused"), "reused");
  completeDownload(services, "target-reused", "guid-reused");
  await download.path();

  assert.deepEqual(behaviorCalls(services.calls).at(-1), {
    behavior: "default",
    sessionId: "session-reused",
  });
  await assert.rejects(access(reusedMarker));
  await download.delete();
  disposeDownloadArtifacts();
});

test("disposing the SDK removes only this process's download files", async () => {
  const services = recordingServices();
  const interception = preparePageDownload(services, "target-dispose", {
    timeoutMs: 1_000,
  });
  await interception.ready("session-dispose");
  beginDownload(services, "target-dispose", "guid-dispose", "dispose.txt");
  await interception.event;
  const ownPartial = join(sharedDirectory, "guid-dispose.crdownload");
  const foreignFile = join(sharedDirectory, "guid-of-another-process");
  await writeFile(ownPartial, "partial");
  await writeFile(foreignFile, "theirs");

  disposeDownloadArtifacts();

  await assert.rejects(access(ownPartial));
  await assert.rejects(access(waiterMarker(process.pid)));
  assert.equal(await readFile(foreignFile, "utf8"), "theirs");
  await access(sharedDirectory);
  await rm(foreignFile, { force: true });
});

test.after(async () => {
  await rm(stateDir, { recursive: true, force: true });
});
