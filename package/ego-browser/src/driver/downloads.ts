import {
  type Dirent,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { runtimeStateDir } from "../env.js";

type DownloadServices = {
  cdp(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<any>;
  subscribePageEvents(
    targetId: string,
    listener: (event: any) => void,
  ): () => void;
};

type DownloadCompletion = { path: string; failure: null } | { failure: string };

export type DownloadArtifact = {
  readonly url: string;
  readonly suggestedFilename: string;
  readonly finished: Promise<void>;
  saveAs(path: string): Promise<void>;
  path(): Promise<string>;
  failure(): Promise<string | null>;
  cancel(): Promise<void>;
  delete(): Promise<void>;
};

export type DownloadInterception = {
  ready(sessionId: string): Promise<void>;
  event: Promise<DownloadArtifact>;
  dispose(reason?: Error): Promise<void>;
};

// Chromium keeps one download behavior per BrowserContext, and every ego lite
// TaskSpace shares one context, so Page.setDownloadBehavior from any Page, in
// any ego-browser process, overrides the others: the most recent call wins
// and "default" from one Page strips the directory from everyone. Downloads
// therefore all use the same directory with Chromium's `allowAndName`
// behavior, which names each file after its download guid. Re-applying the
// identical setting is harmless, and a waiter finds its own file by guid no
// matter which Page armed last. The behavior goes back to default only when
// no process on this machine still waits for a download.
const WAITERS_DIRECTORY = "waiters";
const STALE_WAITER_MS = 60 * 60 * 1_000;
const WAITER_REFRESH_MS = 10 * 60 * 1_000;
const STALE_FILE_MS = 24 * 60 * 60 * 1_000;
const FILE_POLL_INTERVAL_MS = 50;

let sharedDirectory: string | undefined;
let waiterRefreshTimer: ReturnType<typeof setInterval> | undefined;
const ownedFiles = new Set<string>();
const armedInterceptions = new Set<symbol>();
const activeInterceptions = new Set<() => void>();
const activeDownloadTargets = new Set<string>();

/**
 * The directory every ego-browser process on this machine downloads into.
 * Files are named after their Chromium download guid.
 */
export function downloadDirectory(): string {
  if (sharedDirectory) return sharedDirectory;
  const directory = join(runtimeStateDir(), "downloads");
  mkdirSync(join(directory, WAITERS_DIRECTORY), { recursive: true });
  removeStaleFiles(directory);
  sharedDirectory = directory;
  return directory;
}

/**
 * Arm one Page session for its next download.
 */
export function preparePageDownload(
  services: DownloadServices,
  targetId: string,
  { timeoutMs }: { timeoutMs: number },
): DownloadInterception {
  if (activeDownloadTargets.has(targetId)) {
    throw new Error(`${targetId} is already waiting for a download`);
  }
  activeDownloadTargets.add(targetId);
  const token = Symbol(targetId);
  const configuredSessions = new Set<string>();
  let guid: string | undefined;
  let filePath: string | undefined;
  let disposed = false;
  let settled = false;
  let filePollTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveEvent!: (artifact: DownloadArtifact) => void;
  let rejectEvent!: (error: Error) => void;
  let resolveCompletion!: (completion: DownloadCompletion) => void;
  const event = new Promise<DownloadArtifact>((resolve, reject) => {
    resolveEvent = resolve;
    rejectEvent = reject;
  });
  void event.catch(() => {});
  const completion = new Promise<DownloadCompletion>((resolve) => {
    resolveCompletion = resolve;
  });

  // Decide synchronously whether this waiter was the last one, and send the
  // reset in the same tick, so a `ready()` that follows in this process always
  // sends its setting after the reset.
  const restoreBehavior = async () => {
    const sessions = [...configuredSessions];
    configuredSessions.clear();
    if (!releaseSharedBehavior(token)) return;
    const restored = await Promise.all(
      sessions.map((sessionId) =>
        services
          .cdp(
            "Page.setDownloadBehavior",
            { behavior: "default" },
            sessionId,
            1_000,
          )
          .then(
            () => sessionId,
            () => undefined,
          ),
      ),
    );
    // Another process may have registered, and sent its setting, between the
    // marker check and Chromium applying the reset; its setting then lost.
    // The reset has been applied once its response is back, so a marker seen
    // now belongs to a waiter whose later sends land after it, and one seen
    // from before only needs the setting put back for it.
    const session = restored.find((sessionId) => sessionId !== undefined);
    if (!session || armedInterceptions.size > 0 || !hasOtherLiveWaiter()) {
      return;
    }
    await services
      .cdp(
        "Page.setDownloadBehavior",
        { behavior: "allowAndName", downloadPath: downloadDirectory() },
        session,
        1_000,
      )
      .catch(() => {});
  };
  const finish = async (result: DownloadCompletion) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (filePollTimer) clearTimeout(filePollTimer);
    unsubscribe();
    activeInterceptions.delete(disposeSynchronously);
    await restoreBehavior();
    activeDownloadTargets.delete(targetId);
    resolveCompletion(result);
  };
  // Chromium writes `<guid>.crdownload` and renames it to `<guid>` once the
  // download completes, so the final name appearing is the completion signal
  // even when the final progress event never arrives.
  const checkForDownloadedFile = async () => {
    filePollTimer = undefined;
    if (disposed || settled || !filePath) return;
    try {
      await stat(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        scheduleFileCheck();
        return;
      }
      await finish({ failure: asError(error).message });
      return;
    }
    await finish({ path: filePath, failure: null });
  };
  const scheduleFileCheck = () => {
    if (disposed || settled || filePollTimer) return;
    filePollTimer = setTimeout(
      () => void checkForDownloadedFile(),
      FILE_POLL_INTERVAL_MS,
    );
  };
  const onEvent = (message: any) => {
    const params = message?.params;
    if (message?.method === "Page.downloadWillBegin" && !guid) {
      if (
        typeof params?.guid !== "string" ||
        typeof params?.url !== "string" ||
        typeof params?.suggestedFilename !== "string"
      ) {
        return;
      }
      guid = params.guid;
      filePath = join(downloadDirectory(), params.guid);
      ownedFiles.add(filePath);
      clearTimeout(timer);
      resolveEvent(
        new PageDownloadArtifact(
          services,
          targetId,
          params.guid,
          params.url,
          params.suggestedFilename,
          filePath,
          completion,
        ),
      );
      scheduleFileCheck();
      return;
    }
    if (message?.method !== "Page.downloadProgress" || params?.guid !== guid) {
      return;
    }
    if (params.state === "completed") {
      if (filePollTimer) clearTimeout(filePollTimer);
      filePollTimer = undefined;
      void checkForDownloadedFile();
    } else if (params.state === "canceled") {
      void finish({ failure: "canceled" });
    }
  };
  const unsubscribe = services.subscribePageEvents(targetId, onEvent);
  const disposeSynchronously = () => {
    if (disposed || settled) return;
    disposed = true;
    clearTimeout(timer);
    if (filePollTimer) clearTimeout(filePollTimer);
    unsubscribe();
    activeDownloadTargets.delete(targetId);
    void restoreBehavior();
    rejectEvent(new Error("download waiter was disposed"));
    resolveCompletion({ failure: "download waiter was disposed" });
  };
  activeInterceptions.add(disposeSynchronously);
  const timer = setTimeout(() => {
    if (guid || disposed || settled) return;
    disposed = true;
    unsubscribe();
    activeInterceptions.delete(disposeSynchronously);
    void (async () => {
      await restoreBehavior();
      activeDownloadTargets.delete(targetId);
      rejectEvent(
        new Error(
          `page.waitForEvent("download") timed out after ${timeoutMs}ms`,
        ),
      );
      resolveCompletion({ failure: "download did not start" });
    })();
  }, timeoutMs);

  return {
    async ready(sessionId: string) {
      if (disposed || settled) {
        throw new Error("download waiter is no longer active");
      }
      const downloadPath = downloadDirectory();
      // Register the session before sending: a rejected call (a timeout, say)
      // may still have been applied, and the restore must reach that session.
      configuredSessions.add(sessionId);
      claimSharedBehavior(token);
      await services.cdp(
        "Page.setDownloadBehavior",
        { behavior: "allowAndName", downloadPath },
        sessionId,
      );
    },
    event,
    async dispose(reason = new Error("download waiter was disposed")) {
      if (disposed || settled) return;
      disposed = true;
      clearTimeout(timer);
      if (filePollTimer) clearTimeout(filePollTimer);
      unsubscribe();
      activeInterceptions.delete(disposeSynchronously);
      await restoreBehavior();
      activeDownloadTargets.delete(targetId);
      rejectEvent(reason);
      resolveCompletion({ failure: reason.message });
    },
  };
}

class PageDownloadArtifact implements DownloadArtifact {
  readonly url: string;
  readonly suggestedFilename: string;
  readonly finished: Promise<void>;
  readonly #services: DownloadServices;
  readonly #targetId: string;
  readonly #guid: string;
  readonly #filePath: string;
  readonly #completion: Promise<DownloadCompletion>;
  #completionResult?: DownloadCompletion;

  constructor(
    services: DownloadServices,
    targetId: string,
    guid: string,
    url: string,
    suggestedFilename: string,
    filePath: string,
    completion: Promise<DownloadCompletion>,
  ) {
    this.#services = services;
    this.#targetId = targetId;
    this.#guid = guid;
    this.url = url;
    this.suggestedFilename = suggestedFilename;
    this.#filePath = filePath;
    this.#completion = completion;
    this.finished = completion.then((result) => {
      this.#completionResult = result;
    });
  }

  async saveAs(path: string): Promise<void> {
    assertAbsolutePath(path, "download.saveAs");
    const sourcePath = await this.path();
    await mkdir(dirname(path), { recursive: true });
    await copyFile(sourcePath, path);
  }

  async path(): Promise<string> {
    const result = await this.#completion;
    if (!("path" in result)) {
      throw new Error(`download failed: ${result.failure}`);
    }
    return result.path;
  }

  async failure(): Promise<string | null> {
    return (await this.#completion).failure;
  }

  async cancel(): Promise<void> {
    if (this.#completionResult) return;
    try {
      const targetInfo = await this.#services.cdp("Target.getTargetInfo", {
        targetId: this.#targetId,
      });
      const browserContextId = targetInfo?.targetInfo?.browserContextId;
      await this.#services.cdp("Browser.cancelDownload", {
        guid: this.#guid,
        ...(typeof browserContextId === "string" ? { browserContextId } : {}),
      });
    } catch (error) {
      if (this.#completionResult) return;
      throw error;
    }
  }

  async delete(): Promise<void> {
    await this.#completion;
    ownedFiles.delete(this.#filePath);
    await rm(this.#filePath, { force: true });
  }
}

// Every process that waits for a download leaves `waiters/<pid>` in the shared
// directory while it waits. The last live waiter restores the default
// behavior; the others leave it alone so their downloads keep landing here.
// A marker is rewritten while its process waits, so one that stopped aging
// belongs to a process that died and whose pid another process now holds.
function claimSharedBehavior(token: symbol): void {
  armedInterceptions.add(token);
  writeWaiterMarker();
  if (!waiterRefreshTimer) {
    waiterRefreshTimer = setInterval(writeWaiterMarker, WAITER_REFRESH_MS);
    waiterRefreshTimer.unref?.();
  }
}

function releaseSharedBehavior(token: symbol): boolean {
  armedInterceptions.delete(token);
  if (armedInterceptions.size > 0) return false;
  stopWaiterMarker();
  return !hasOtherLiveWaiter();
}

function writeWaiterMarker(): void {
  try {
    writeFileSync(
      waiterMarkerPath(),
      JSON.stringify({ pid: process.pid, since: Date.now() }),
    );
  } catch {
    // A read-only state directory only loses cross-process coordination.
  }
}

function stopWaiterMarker(): void {
  if (waiterRefreshTimer) clearInterval(waiterRefreshTimer);
  waiterRefreshTimer = undefined;
  rmSync(waiterMarkerPath(), { force: true });
}

function waiterMarkerPath(): string {
  return join(downloadDirectory(), WAITERS_DIRECTORY, String(process.pid));
}

function hasOtherLiveWaiter(): boolean {
  const waitersDirectory = join(downloadDirectory(), WAITERS_DIRECTORY);
  let names: string[];
  try {
    names = readdirSync(waitersDirectory);
  } catch {
    return false;
  }
  const now = Date.now();
  for (const name of names) {
    const path = join(waitersDirectory, name);
    const pid = Number(name);
    if (pid === process.pid) continue;
    let stale = !Number.isInteger(pid) || !isProcessAlive(pid);
    if (!stale) {
      try {
        stale = now - statSync(path).mtimeMs > STALE_WAITER_MS;
      } catch {
        continue;
      }
    }
    if (stale) {
      rmSync(path, { force: true });
      continue;
    }
    return true;
  }
  return false;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

// Files a process could not clean up (a crash mid-download) would otherwise
// stay forever; anything older than a day is nobody's pending download.
function removeStaleFiles(directory: string): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_FILE_MS;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(directory, entry.name);
    try {
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
    } catch {
      // Another process may have removed it first.
    }
  }
}

function assertAbsolutePath(path: string, method: string): void {
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path)) {
    throw new TypeError(`${method} requires an absolute file path`);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Remove this process's download files and stop pending waits during SDK disposal. */
export function disposeDownloadArtifacts(): void {
  for (const dispose of [...activeInterceptions]) dispose();
  activeInterceptions.clear();
  activeDownloadTargets.clear();
  if (armedInterceptions.size > 0) {
    armedInterceptions.clear();
    if (sharedDirectory) stopWaiterMarker();
  }
  for (const path of ownedFiles) {
    rmSync(path, { force: true });
    rmSync(`${path}.crdownload`, { force: true });
  }
  ownedFiles.clear();
}
