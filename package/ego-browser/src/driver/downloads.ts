import { mkdtempSync, rmSync } from "node:fs";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

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

const artifactDirectories = new Set<string>();
const activeInterceptions = new Set<() => void>();
const activeDownloadTargets = new Set<string>();

/**
 * Arm one Page session for its next download without changing the shared
 * Chromium BrowserContext download behavior.
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
  const directory = mkdtempSync(join(tmpdir(), "ego-browser-download-"));
  artifactDirectories.add(directory);
  const directoryPromise = Promise.resolve(directory);
  const configuredSessions = new Set<string>();
  let guid: string | undefined;
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

  const resetBehavior = async () => {
    const sessions = [...configuredSessions];
    configuredSessions.clear();
    await Promise.all(
      sessions.map((sessionId) =>
        services
          .cdp(
            "Page.setDownloadBehavior",
            { behavior: "default" },
            sessionId,
            1_000,
          )
          .catch(() => {}),
      ),
    );
  };
  const finish = async (result: DownloadCompletion) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (filePollTimer) clearTimeout(filePollTimer);
    unsubscribe();
    activeInterceptions.delete(disposeSynchronously);
    await resetBehavior();
    activeDownloadTargets.delete(targetId);
    resolveCompletion(result);
  };
  const checkForDownloadedFile = async () => {
    filePollTimer = undefined;
    if (disposed || settled || !guid) return;
    try {
      const path = await directoryPromise.then(findDownloadedFile);
      if (path) {
        await finish({ path, failure: null });
        return;
      }
    } catch (error) {
      await finish({ failure: asError(error).message });
      return;
    }
    scheduleFileCheck();
  };
  const scheduleFileCheck = () => {
    if (disposed || settled || filePollTimer) return;
    filePollTimer = setTimeout(() => void checkForDownloadedFile(), 50);
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
      clearTimeout(timer);
      resolveEvent(
        new PageDownloadArtifact(
          services,
          targetId,
          params.guid,
          params.url,
          params.suggestedFilename,
          directoryPromise,
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
    void resetBehavior();
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
      await resetBehavior();
      activeDownloadTargets.delete(targetId);
      rejectEvent(
        new Error(
          `page.waitForEvent("download") timed out after ${timeoutMs}ms`,
        ),
      );
      resolveCompletion({ failure: "download did not start" });
      await directoryPromise.then(removeArtifactDirectory);
    })();
  }, timeoutMs);

  return {
    async ready(sessionId: string) {
      if (disposed || settled) {
        throw new Error("download waiter is no longer active");
      }
      const downloadPath = await directoryPromise;
      await services.cdp(
        "Page.setDownloadBehavior",
        { behavior: "allow", downloadPath },
        sessionId,
      );
      configuredSessions.add(sessionId);
    },
    event,
    async dispose(reason = new Error("download waiter was disposed")) {
      if (disposed || settled) return;
      disposed = true;
      clearTimeout(timer);
      if (filePollTimer) clearTimeout(filePollTimer);
      unsubscribe();
      activeInterceptions.delete(disposeSynchronously);
      await resetBehavior();
      activeDownloadTargets.delete(targetId);
      rejectEvent(reason);
      resolveCompletion({ failure: reason.message });
      await directoryPromise.then(removeArtifactDirectory);
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
  readonly #directory: Promise<string>;
  readonly #completion: Promise<DownloadCompletion>;
  #completionResult?: DownloadCompletion;

  constructor(
    services: DownloadServices,
    targetId: string,
    guid: string,
    url: string,
    suggestedFilename: string,
    directory: Promise<string>,
    completion: Promise<DownloadCompletion>,
  ) {
    this.#services = services;
    this.#targetId = targetId;
    this.#guid = guid;
    this.url = url;
    this.suggestedFilename = suggestedFilename;
    this.#directory = directory;
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
    await removeArtifactDirectory(await this.#directory);
  }
}

async function findDownloadedFile(
  directory: string,
): Promise<string | undefined> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries.filter(
    (entry) => entry.isFile() && !entry.name.endsWith(".crdownload"),
  );
  if (files.length > 1) {
    throw new Error(
      `download completed with ${files.length} files in its temporary directory`,
    );
  }
  return files.length === 1 ? join(directory, files[0].name) : undefined;
}

async function removeArtifactDirectory(directory: string): Promise<void> {
  artifactDirectories.delete(directory);
  await rm(directory, { recursive: true, force: true });
}

function assertAbsolutePath(path: string, method: string): void {
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path)) {
    throw new TypeError(`${method} requires an absolute file path`);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Remove round-local files and stop pending waits during SDK disposal. */
export function disposeDownloadArtifacts(): void {
  for (const dispose of [...activeInterceptions]) dispose();
  activeInterceptions.clear();
  activeDownloadTargets.clear();
  for (const directory of artifactDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  artifactDirectories.clear();
}
