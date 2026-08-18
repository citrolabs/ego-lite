/**
 * Linux polyfill entrypoint — `src/linux/index.ts`
 *
 * Installs a `globalThis.ego` polyfill on Linux that routes all browser
 * work through a local Chrome instance via CDP. Zero cost on macOS.
 *
 * Activation:
 *   - `EGO_LINUX=1` forces activation (explicit opt-in).
 *   - Otherwise on Linux: requires `google-chrome` binary to auto-activate.
 *   - Unit tests: set `EGO_LINUX=0` or `CI=1` to suppress (helpers.test.mjs
 *     mocks cdpOverride so chrome must NOT be spawned during tests).
 *   - macOS: never auto-activates.
 *
 * Wiring: imported by `src/state.ts` (side-effect) so activation happens
 * before any helper is evaluated. To avoid breaking tests, activation is
 * deferred to the first `globalThis.ego` access when not already present.
 */

import { existsSync } from "node:fs";

import { connectLinuxBridge } from "./bridge.js";
import { launchChrome, type ChromeInstance } from "./launcher.js";
import { LinuxSnapshot } from "./snapshot-ax.js";
import { LinuxTaskSpaces } from "./task-spaces.js";

const WS_PORT = Number(process.env.EGO_LINUX_PORT ?? 9222);

let instance: ChromeInstance | null = null;
let bridge: { send: (m: string) => void; close: () => void } | null = null;
let bridgePromise: Promise<{ send: (m: string) => void }> | null = null;
let installed = false;

function hasChrome(): boolean {
  const bin = process.env.EGO_CHROME_BIN ?? "/usr/bin/google-chrome";
  if (existsSync(bin)) return true;
  for (const p of [
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
  ]) {
    if (existsSync(p)) return true;
  }
  return false;
}

function shouldActivate(): boolean {
  if (process.env.EGO_LINUX === "0") return false;
  if (process.env.EGO_LINUX === "1") return true;
  // Suppress during unit tests — helpers.test.mjs uses cdpOverride
  if (process.env.CI === "1" && process.env.EGO_LINUX !== "1") return false;
  if (process.platform !== "linux") return false;
  return hasChrome();
}

function onBridgeMessage(data: string): void {
  const cb = (globalThis.ego as Record<string, unknown>)?.onCDPMessage as
    | ((msg: string) => void)
    | undefined;
  if (typeof cb === "function") cb(data);
}

function onBridgeClose(): void {
  // The WS died (crash, kill, network blip). Drop both handles so the next
  // ensureBridge() call respawns cleanly instead of reusing a dead bridge
  // forever or leaking the old Chrome process.
  bridge = null;
  bridgePromise = null;
  try {
    instance?.process.kill("SIGTERM");
  } catch {}
  instance = null;
}

async function ensureBridge(): Promise<{ send: (m: string) => void }> {
  if (bridge) return bridge;
  if (bridgePromise) return bridgePromise;
  bridgePromise = (async (): Promise<{ send: (m: string) => void }> => {
    try {
      bridge = await connectLinuxBridge({
        port: WS_PORT,
        timeoutMs: 1500,
        onMessage: onBridgeMessage,
        onClose: onBridgeClose,
      });
      return bridge;
    } catch {}
    instance = await launchChrome({ headless: true });
    await new Promise((r) => setTimeout(r, 600));
    bridge = await connectLinuxBridge({
      port: instance.port,
      timeoutMs: 5000,
      onMessage: onBridgeMessage,
      onClose: onBridgeClose,
    });
    const cleanup = () => {
      try {
        bridge?.close();
      } catch {}
      try {
        instance?.process.kill("SIGTERM");
      } catch {}
    };
    process.once("exit", cleanup);
    process.once("SIGINT", () => {
      cleanup();
      process.exit(130);
    });
    process.once("SIGTERM", () => {
      cleanup();
      process.exit(143);
    });
    return bridge;
  })();
  try {
    return await bridgePromise;
  } catch (e) {
    bridgePromise = null;
    throw e;
  }
}

export async function installEgoLinux(): Promise<void> {
  if (installed) return;
  if (!shouldActivate()) return;

  const taskSpaces = new LinuxTaskSpaces(() => ensureBridge());
  const snapshot = new LinuxSnapshot(() => ensureBridge());

  const ego: Record<string, unknown> = {
    sendCDPMessage(payload: string) {
      void ensureBridge()
        .then((b) => b.send(payload))
        .catch((e) => {
          const cb = (globalThis.ego as Record<string, unknown>)
            ?.onSendCDPMessageError as
            | ((msg: string, code?: string) => void)
            | undefined;
          if (typeof cb === "function")
            cb(e.message ?? String(e), "EGO_CDP_SEND_FAILED");
        });
    },
    onCDPMessage: null as unknown as (msg: string) => void,
    onSendCDPMessageError: null as unknown as (
      msg: string,
      code?: string,
    ) => void,

    async listTabs() {
      try {
        await ensureBridge();
      } catch {}
      try {
        const { request } = await import("node:http");
        const port = instance?.port ?? WS_PORT;
        const tabs: Array<{ targetId: string; title?: string; url?: string }> =
          await new Promise((resolve, reject) => {
            const req = request(`http://127.0.0.1:${port}/json`, (res) => {
              let d = "";
              res.on("data", (c: Buffer) => (d += c.toString()));
              res.on("end", () => {
                try {
                  const arr = JSON.parse(d) as Array<{
                    id?: string;
                    targetId?: string;
                    title?: string;
                    url?: string;
                    type?: string;
                  }>;
                  resolve(
                    arr
                      .filter((t) => t.type === "page" || !t.type)
                      .map((t) => ({
                        targetId: t.id ?? t.targetId ?? "",
                        title: t.title ?? "",
                        url: t.url ?? "",
                      })),
                  );
                } catch (e) {
                  reject(e);
                }
              });
            });
            req.on("error", () => resolve([]));
            req.end();
          });
        if (tabs.length) return { tabs };
      } catch {}
      return { tabs: [] };
    },
    async createTab(url: string) {
      const { request } = await import("node:http");
      const port = instance?.port ?? WS_PORT;
      const qs = url ? `?${new URLSearchParams({ url }).toString()}` : "";
      const tid: string = await new Promise<string>((resolve, reject) => {
        const req = request(
          {
            hostname: "127.0.0.1",
            port,
            path: `/json/new${qs}`,
            method: "PUT",
          },
          (res) => {
            let d = "";
            res.on("data", (c: Buffer) => (d += c.toString()));
            res.on("end", () => {
              try {
                const j = JSON.parse(d) as { id?: string; targetId?: string };
                resolve(j.id ?? j.targetId ?? "");
              } catch (e) {
                reject(e);
              }
            });
          },
        );
        req.on("error", reject);
        req.end();
      }).catch(() => "");
      if (tid) return { targetId: tid };
      const b = await ensureBridge();
      void b;
      void url;
      return { targetId: "" };
    },
    async snapshot(opts: unknown) {
      return snapshot.snapshot(opts as never);
    },
    async listTaskSpaces() {
      return taskSpaces.listTaskSpaces();
    },
    async createTaskSpace(name: string) {
      return taskSpaces.createTaskSpace(name);
    },
    async useTaskSpace(id: number) {
      return taskSpaces.useTaskSpace(id);
    },
    async closeTaskSpace() {
      return taskSpaces.closeTaskSpace();
    },
    async claimTaskSpace(id: number, name?: string) {
      return taskSpaces.claimTaskSpace(id, name);
    },
    async handOffTaskSpace() {
      return taskSpaces.handOffTaskSpace();
    },
    async takeOverTaskSpace() {
      return taskSpaces.takeOverTaskSpace();
    },
    async completeTaskSpace() {
      return taskSpaces.completeTaskSpace();
    },
    getBrowserVersion() {
      return null;
    },
  };

  if (!globalThis.ego) {
    (globalThis as Record<string, unknown>).ego = ego;
  }
  installed = true;
}

export function isLinuxEgoInstalled(): boolean {
  return installed;
}

// Do NOT auto-activate at import time when CI=1 or EGO_LINUX=0 —
// that would spawn Chrome during unit tests (helpers.test.mjs mocks
// cdpOverride and must NOT trigger launcher). Manual callers can
// `await installEgoLinux()` or rely on helpers.ts which triggers it lazily.
// Eager activation only when explicitly opted in via EGO_LINUX=1.
if (process.env.EGO_LINUX === "1") {
  void installEgoLinux().catch(() => {});
}
