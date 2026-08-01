import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, type HostConfig } from "./config.js";
import { pingSocket } from "./ego-client.js";
import { makeEgoError } from "./errors.js";
import {
  startDaemon,
  type HostDaemon,
  type HostDaemonOptions,
} from "./host-daemon.js";

type LockOwner = {
  pid: number;
  token: string;
  startedAt: string;
};

export type HostRuntimePaths = {
  socketPath: string;
  pidPath: string;
  lockPath: string;
};

export type HostStatus = {
  state: "ready" | "starting" | "stale" | "stopped";
  pid: number | null;
  ownershipVerified: boolean;
  socketPath: string;
  pidPath: string;
  lockPath: string;
};

export type HostLock = {
  pid: number;
  path: string;
  release(): Promise<void>;
};

export type StopResult = {
  alreadyStopped: boolean;
  pid: number | null;
};

type HostControlDeps = {
  pingSocket?: (socketPath: string) => Promise<boolean>;
  isProcessAlive?: (pid: number) => boolean;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
};

export function hostRuntimePaths(config: HostConfig): HostRuntimePaths {
  return {
    socketPath: config.hostSocket,
    pidPath: join(config.runtimeDir, "host.pid"),
    lockPath: join(config.runtimeDir, "host.lock"),
  };
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLockOwner(path: string): Promise<LockOwner | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (
      Number.isInteger(parsed?.pid) &&
      parsed.pid > 0 &&
      typeof parsed?.token === "string"
    ) {
      return parsed as LockOwner;
    }
    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    return null;
  }
}

async function readPid(path: string): Promise<number | null> {
  try {
    const pid = Number((await readFile(path, "utf8")).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    return null;
  }
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
  }
}

export async function inspectHost(
  config: HostConfig,
  deps: HostControlDeps = {},
): Promise<HostStatus> {
  const paths = hostRuntimePaths(config);
  const ping = deps.pingSocket ?? pingSocket;
  const alive = deps.isProcessAlive ?? isProcessAlive;
  const [ready, lockOwner, pidFile] = await Promise.all([
    ping(paths.socketPath),
    readLockOwner(paths.lockPath),
    readPid(paths.pidPath),
  ]);
  const pid = pidFile ?? lockOwner?.pid ?? null;
  const recordsAgree =
    pidFile !== null && lockOwner !== null && pidFile === lockOwner.pid;
  const ownerAlive = pid !== null && alive(pid);

  if (ready) {
    return {
      state: "ready",
      pid,
      ownershipVerified: recordsAgree && ownerAlive,
      ...paths,
    };
  }
  if (ownerAlive) {
    return { state: "starting", pid, ownershipVerified: false, ...paths };
  }
  if (lockOwner !== null || pidFile !== null) {
    return { state: "stale", pid, ownershipVerified: false, ...paths };
  }
  return {
    state: "stopped",
    pid: null,
    ownershipVerified: false,
    ...paths,
  };
}

export async function acquireHostLock(
  config: HostConfig,
  deps: Pick<HostControlDeps, "isProcessAlive"> = {},
): Promise<HostLock> {
  const paths = hostRuntimePaths(config);
  const alive = deps.isProcessAlive ?? isProcessAlive;
  await mkdir(config.runtimeDir, { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(paths.lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    const owner = await readLockOwner(paths.lockPath);
    if (owner && alive(owner.pid)) {
      throw makeEgoError(
        "EGO_HOST_ALREADY_RUNNING",
        `ego Linux host is already owned by pid ${owner.pid}`,
      );
    }
    throw makeEgoError(
      "EGO_HOST_STALE_LOCK",
      `stale ego Linux host lock at ${paths.lockPath}; run ego-linux-hostd stop before retrying`,
    );
  }

  const owner: LockOwner = {
    pid: process.pid,
    token: randomUUID(),
    startedAt: new Date().toISOString(),
  };
  try {
    await handle.writeFile(JSON.stringify(owner), "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await safeUnlink(paths.lockPath).catch(() => {});
    throw error;
  }

  let released = false;
  return {
    pid: owner.pid,
    path: paths.lockPath,
    async release() {
      if (released) return;
      released = true;
      await handle.close().catch(() => {});
      const current = await readLockOwner(paths.lockPath);
      if (current?.token === owner.token) {
        await safeUnlink(paths.lockPath);
      }
    },
  };
}

export async function cleanupStoppedHost(
  config: HostConfig,
  deps: HostControlDeps = {},
): Promise<void> {
  const status = await inspectHost(config, deps);
  if (status.state === "ready" || status.state === "starting") {
    throw makeEgoError(
      "EGO_HOST_ALREADY_RUNNING",
      `refusing to clean runtime files owned by live pid ${status.pid}`,
    );
  }
  await safeUnlink(status.socketPath);
  await safeUnlink(status.pidPath);
  await safeUnlink(status.lockPath);
}

export async function startManagedDaemon(
  options: HostDaemonOptions = {},
): Promise<HostDaemon> {
  const env = options.env ?? process.env;
  const config = options.config ?? (await loadConfig(env));
  const lock = await acquireHostLock(config);
  try {
    const daemon = await startDaemon({
      ...options,
      config,
      pidPath: options.pidPath ?? hostRuntimePaths(config).pidPath,
    });
    let closed = false;
    return {
      ...daemon,
      async close() {
        if (closed) return;
        closed = true;
        try {
          await daemon.close();
        } finally {
          await lock.release();
        }
      },
    };
  } catch (error) {
    await lock.release();
    throw error;
  }
}

export async function stopHost(
  config: HostConfig,
  options: HostControlDeps & { timeoutMs?: number; pollMs?: number } = {},
): Promise<StopResult> {
  const initial = await inspectHost(config, options);
  if (initial.state === "stopped" || initial.state === "stale") {
    await cleanupStoppedHost(config, options);
    return { alreadyStopped: true, pid: initial.pid };
  }
  if (initial.state === "starting") {
    throw makeEgoError(
      "EGO_OPERATION_FAILED",
      `ego Linux host pid ${initial.pid} is not ready; refusing to signal an unverified process`,
    );
  }
  if (initial.pid === null) {
    throw makeEgoError(
      "EGO_OPERATION_FAILED",
      "host answered but no owning pid was recorded",
    );
  }
  if (!initial.ownershipVerified) {
    throw makeEgoError(
      "EGO_OPERATION_FAILED",
      `ego Linux host pid ${initial.pid} answered but ownership records do not agree; refusing to signal`,
    );
  }

  const signal = options.signal ?? ((pid, value) => process.kill(pid, value));
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  try {
    signal(initial.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ESRCH") throw error;
  }

  const timeoutMs = options.timeoutMs ?? 12_000;
  const pollMs = options.pollMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await inspectHost(config, options);
    if (current.state === "stopped" || current.state === "stale") {
      await cleanupStoppedHost(config, options);
      return { alreadyStopped: false, pid: initial.pid };
    }
    await sleep(pollMs);
  }

  throw makeEgoError(
    "EGO_HOST_STOP_TIMEOUT",
    `ego Linux host pid ${initial.pid} did not stop within ${timeoutMs}ms`,
  );
}
