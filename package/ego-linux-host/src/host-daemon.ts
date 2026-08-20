/**
 * Long-lived ego Linux host daemon.
 *
 * - Ensures Chrome + CDP on start
 * - Owns SpaceManager + EgoRuntime
 * - Serves NDJSON RPC on a Unix domain socket
 */

import { createServer, type Server, type Socket } from "node:net";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { connectCdp, type CdpBridge } from "./cdp-bridge.js";
import {
  ensureChrome,
  isCdpUp,
  type ChromeHandle,
} from "./chrome-supervisor.js";
import { loadConfig, type HostConfig } from "./config.js";
import { createEgoRuntime, type EgoRuntime } from "./ego-runtime.js";
import { makeEgoError } from "./errors.js";
import {
  decodeLine,
  encodeEvent,
  encodeResponse,
  isRpcRequest,
  LineBuffer,
  type RpcEvent,
  type RpcResponse,
} from "./rpc.js";
import { SpaceManager } from "./space-manager.js";

export const HOST_VERSION = "0.1.0";
// macOS sockaddr_un.sun_path is 104 bytes including the trailing NUL.
const MAX_PORTABLE_UNIX_SOCKET_PATH_BYTES = 103;

export type HostDaemonOptions = {
  config?: HostConfig;
  env?: NodeJS.ProcessEnv;
  /** Skip real Chrome/CDP (unit/integration tests). */
  skipChrome?: boolean;
  /** Inject CDP bridge factory (defaults to connectCdp). */
  connectCdp?: (port: number) => Promise<CdpBridge>;
  /** Inject Chrome ensure (defaults to ensureChrome). */
  ensureChrome?: (config: HostConfig) => Promise<ChromeHandle>;
  /** Override spaces.json path. */
  spacesPath?: string;
  /** Override pid file path. */
  pidPath?: string;
  /** Listen without writing pid (tests). */
  writePid?: boolean;
};

export type HostDaemon = {
  socketPath: string;
  config: HostConfig;
  spaceManager: SpaceManager;
  runtime: EgoRuntime;
  close(): Promise<void>;
};

function errorToRpc(
  id: number,
  err: unknown,
): RpcResponse {
  const code =
    err &&
    typeof err === "object" &&
    typeof (err as { error_code?: string }).error_code === "string"
      ? (err as { error_code: string }).error_code
      : "EGO_OPERATION_FAILED";
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : String(err);
  return { id, error: { code, message } };
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") throw err;
  }
}

export function validateUnixSocketPath(socketPath: string): void {
  const bytes = Buffer.byteLength(socketPath);
  if (bytes > MAX_PORTABLE_UNIX_SOCKET_PATH_BYTES) {
    throw makeEgoError(
      "EGO_INVALID_ARGUMENT",
      `Unix socket path is ${bytes} bytes; keep it at or below ${MAX_PORTABLE_UNIX_SOCKET_PATH_BYTES}. Set EGO_RUNTIME_DIR to a shorter path such as /run/ego-lite.`,
    );
  }
}

async function closeChromeWithFallback(
  cdp: CdpBridge | null,
  chrome: ChromeHandle | null,
): Promise<void> {
  if (chrome === null) return;
  const ownsProcess =
    chrome.pid !== null && Number.isInteger(chrome.pid) && chrome.pid > 0;

  if (cdp) {
    if (ownsProcess) {
      try {
        await cdp.send("Browser.close");
      } catch {
        // Ignore failures from already-closed/debuggable-browser state.
      }
    }
    try {
      await cdp.close();
    } catch {
      // ignore
    }
  }

  // A browser discovered on an existing CDP endpoint is externally owned.
  // Closing the bridge is sufficient; never close or signal that process.
  if (!ownsProcess) return;

  const waitForExit = chrome.waitForExit;
  if (waitForExit) {
    const exited = await waitForExit(3000);
    if (exited) return;
  }
  try {
    await chrome.kill();
  } catch {
    // ignore
  }
}

/**
 * Start the host daemon: config → chrome → CDP → spaces → Unix socket.
 */
export async function startDaemon(
  options: HostDaemonOptions = {},
): Promise<HostDaemon> {
  const env = options.env ?? process.env;
  const config = options.config ?? (await loadConfig(env));
  validateUnixSocketPath(config.hostSocket);
  const dataDir = config.dataDir;
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await mkdir(config.runtimeDir, { recursive: true, mode: 0o700 });

  const spacesPath =
    options.spacesPath ?? join(dataDir, "spaces.json");
  const pidPath = options.pidPath ?? join(config.runtimeDir, "host.pid");
  const socketPath = config.hostSocket;

  const spaceManager = new SpaceManager(spacesPath);
  await spaceManager.load();

  const ensureChromeFn = options.ensureChrome ?? ensureChrome;
  const connectCdpFn = options.connectCdp ?? connectCdp;

  let chrome: ChromeHandle | null = null;
  let cdp: CdpBridge | null = null;

  if (!options.skipChrome) {
    chrome = await ensureChromeFn(config);
    cdp = await connectCdpFn(config.cdpPort);
    // Adopt orphan page targets into user space
    try {
      const pages = await cdp.listPageTargets();
      spaceManager.adoptOrphanTargets(pages.map((p) => p.targetId));
      await spaceManager.save();
    } catch {
      // non-fatal on startup
    }
  } else {
    // Minimal stub so getCdp never throws before a real inject
    cdp = {
      async send() {
        throw makeEgoError(
          "EGO_CDP_CHANNEL_UNAVAILABLE",
          "CDP not connected (skipChrome)",
        );
      },
      sendRaw() {
        throw makeEgoError(
          "EGO_CDP_CHANNEL_UNAVAILABLE",
          "CDP not connected (skipChrome)",
        );
      },
      onEvent() {
        return () => {};
      },
      onMessage() {
        return () => {};
      },
      async close() {},
      async listPageTargets() {
        return [];
      },
      async createTarget() {
        throw makeEgoError(
          "EGO_CDP_CHANNEL_UNAVAILABLE",
          "CDP not connected (skipChrome)",
        );
      },
      async attach() {
        throw makeEgoError(
          "EGO_CDP_CHANNEL_UNAVAILABLE",
          "CDP not connected (skipChrome)",
        );
      },
    };
  }

  const getCdp = () => {
    if (!cdp) {
      throw makeEgoError(
        "EGO_CDP_CHANNEL_UNAVAILABLE",
        "CDP bridge not available",
      );
    }
    return cdp;
  };

  const ensureSession = async (): Promise<string> => {
    const bridge = getCdp();
    const allowed = new Set(spaceManager.targetsForSelected());
    const pages = await bridge.listPageTargets();
    const inSpace = pages.filter((p) => allowed.has(p.targetId));
    const active = inSpace[inSpace.length - 1];
    if (!active) {
      throw makeEgoError(
        "EGO_WEB_CONTENTS_UNAVAILABLE",
        "no tab in selected task space to attach",
      );
    }
    return bridge.attach(active.targetId);
  };

  const runtime = createEgoRuntime({
    spaceManager,
    getCdp,
    ensureSession,
    version: HOST_VERSION,
  });

  let detachForward: (() => void) | undefined;
  if (!options.skipChrome) {
    detachForward = runtime.attachCdpForwarding();
  }

  /**
   * If Chrome/CDP died, respawn via ensureChrome and reconnect the bridge.
   * Ego methods call this so a dead browser surfaces as a clear
   * EGO_BROWSER_UNAVAILABLE (or recovers when spawn succeeds).
   */
  async function ensureBrowserReady(): Promise<void> {
    if (options.skipChrome) return;

    if (cdp && (await isCdpUp(config.cdpPort))) {
      return;
    }

    if (detachForward) {
      detachForward();
      detachForward = undefined;
    }
    if (cdp) {
      try {
        await cdp.close();
      } catch {
        // ignore
      }
      cdp = null;
    }

    try {
      // ensureChrome attaches if CDP is already back, otherwise respawns Chrome.
      chrome = await ensureChromeFn(config);
      cdp = await connectCdpFn(config.cdpPort);
      detachForward = runtime.attachCdpForwarding();
    } catch (err) {
      const code =
        err &&
        typeof err === "object" &&
        typeof (err as { error_code?: string }).error_code === "string"
          ? (err as { error_code: string }).error_code
          : undefined;
      if (code === "EGO_BROWSER_UNAVAILABLE") throw err;
      const message =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : String(err);
      throw makeEgoError(
        "EGO_BROWSER_UNAVAILABLE",
        `Browser/CDP unavailable: ${message}. Chrome may have exited; the host will try to respawn on the next request.`,
      );
    }
  }

  const clients = new Set<Socket>();

  async function handleRequest(
    method: string,
    params: any,
  ): Promise<any> {
    if (method === "ping") {
      return { ok: true, version: HOST_VERSION };
    }
    if (method === "doctor") {
      return buildDoctor(config, chrome, spaceManager, socketPath);
    }
    if (method === "reload") {
      // Drop CDP and reconnect; respawn Chrome if CDP is down.
      if (detachForward) {
        detachForward();
        detachForward = undefined;
      }
      if (cdp) {
        try {
          await cdp.close();
        } catch {
          // ignore
        }
        cdp = null;
      }
      if (!options.skipChrome) {
        try {
          if (!(await isCdpUp(config.cdpPort))) {
            chrome = await ensureChromeFn(config);
          }
          cdp = await connectCdpFn(config.cdpPort);
          detachForward = runtime.attachCdpForwarding();
        } catch (err) {
          const code =
            err &&
            typeof err === "object" &&
            typeof (err as { error_code?: string }).error_code === "string"
              ? (err as { error_code: string }).error_code
              : undefined;
          if (code === "EGO_BROWSER_UNAVAILABLE") throw err;
          const message =
            err instanceof Error
              ? err.message
              : typeof err === "string"
                ? err
                : String(err);
          throw makeEgoError(
            "EGO_BROWSER_UNAVAILABLE",
            `Browser/CDP unavailable after reload: ${message}`,
          );
        }
      }
      return { ok: true };
    }
    if (method.startsWith("ego.")) {
      await ensureBrowserReady();
      const result = await runtime.handle(method, params ?? {});
      // Persist space mutations (best-effort)
      try {
        await spaceManager.save();
      } catch {
        // ignore
      }
      return result;
    }
    throw makeEgoError(
      "EGO_INVALID_ARGUMENT",
      `unknown RPC method: ${method}`,
    );
  }

  function writeToClient(socket: Socket, text: string): void {
    if (socket.destroyed) return;
    try {
      socket.write(text);
    } catch {
      // ignore write failures on dead sockets
    }
  }

  function broadcastEvent(ev: RpcEvent): void {
    const line = encodeEvent(ev);
    for (const socket of clients) {
      writeToClient(socket, line);
    }
  }

  runtime.onEvent(broadcastEvent);

  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await safeUnlink(socketPath);

  const server: Server = createServer((socket) => {
    clients.add(socket);
    const lineBuf = new LineBuffer();

    socket.on("data", (chunk) => {
      const lines = lineBuf.push(chunk);
      for (const line of lines) {
        void (async () => {
          let id = -1;
          try {
            const msg = decodeLine(line);
            if (!isRpcRequest(msg)) {
              // ignore non-requests from client
              return;
            }
            id = msg.id;
            const result = await handleRequest(msg.method, msg.params);
            writeToClient(socket, encodeResponse({ id, result }));
          } catch (err) {
            if (id >= 0) {
              writeToClient(socket, encodeResponse(errorToRpc(id, err)));
            }
          }
        })();
      }
    });

    socket.on("close", () => {
      clients.delete(socket);
    });
    socket.on("error", () => {
      clients.delete(socket);
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    await chmod(socketPath, 0o600);

    if (options.writePid !== false) {
      await writeFile(pidPath, String(process.pid), { encoding: "utf8", mode: 0o600 });
    }
  } catch (error) {
    for (const socket of clients) socket.destroy();
    clients.clear();
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await safeUnlink(socketPath).catch(() => {});
    if (options.writePid !== false) {
      await safeUnlink(pidPath).catch(() => {});
    }
    if (detachForward) {
      detachForward();
      detachForward = undefined;
    }
    await closeChromeWithFallback(cdp, chrome);
    cdp = null;
    chrome = null;
    throw error;
  }

  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    if (detachForward) {
      detachForward();
      detachForward = undefined;
    }
    for (const s of clients) {
      try {
        s.destroy();
      } catch {
        // ignore
      }
    }
    clients.clear();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await safeUnlink(socketPath);
    try {
      await spaceManager.save();
    } catch {
      // ignore
    }
    await closeChromeWithFallback(cdp, chrome);
    cdp = null;
    chrome = null;
    if (options.writePid !== false) {
      await safeUnlink(pidPath);
    }
  }

  return {
    socketPath,
    config,
    spaceManager,
    runtime,
    close,
  };
}

function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Diagnostic payload for RPC `doctor` / CLI `--doctor`.
 * CLI merges `harnessPath` (resolved on the client) into this object.
 */
async function buildDoctor(
  config: HostConfig,
  chrome: ChromeHandle | null,
  spaceManager: SpaceManager,
  socketPath: string,
): Promise<Record<string, unknown>> {
  const cdpUp = await isCdpUp(config.cdpPort);
  const chromePid = chrome?.pid ?? null;
  const chromeRunning =
    cdpUp || (chromePid != null && isProcessAlive(chromePid));
  const selected = spaceManager.selected();
  return {
    ok: true,
    version: HOST_VERSION,
    chromePath: config.chromePath,
    chromeRunning,
    chromePid,
    cdpPort: config.cdpPort,
    cdpUp,
    profileDir: config.userDataDir,
    dataDir: config.dataDir,
    socketPath,
    daemonPid: process.pid,
    spaceCount: spaceManager.list().length,
    selectedSpace: selected
      ? {
          id: selected.id,
          name: selected.name,
          ownership: selected.ownership,
        }
      : null,
    headless: config.headless,
    displayEnv: Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY),
    // Resolved by the CLI shim (daemon does not know the harness layout).
    harnessPath: null,
  };
}
