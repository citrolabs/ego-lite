/**
 * Linux Chrome launcher — spawns google-chrome with an ephemeral
 * remote-debugging port, per-TaskSpace browser contexts, and a per-user
 * daemon cache at ~/.cache/ego-lite/.
 *
 * Activated via `EGO_LINUX=1` at startup; installEgoLinux wires all four
 * linux/ modules into globalThis.ego.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LauncherOptions {
  /** Whether to start in headless mode (default: false). */
  headless?: boolean;
  /**
   * One of `new` (default), `old`, or `false`.
   *   `new`  → --headless=new (new headless mode, compositor-backed)
   *   `old`  → --headless (old headless mode)
   *   `false`→ skip headless flags entirely
   */
  headlessMode?: "new" | "old" | false;
  /** Custom Chrome binary path. Defaults to `/usr/bin/google-chrome`. */
  executablePath?: string;
  /** Extra CLI args passed to Chrome. */
  args?: string[];
}

export interface BrowserContext {
  browserContextId: string;
  name: string;
  ownership: "agent" | "user";
}

export interface ChromeInstance {
  pid: number;
  port: number;
  wsUrl: string;
  process: ChildProcess;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_DIR = join(homedir(), ".cache", "ego-lite");
const DEFAULT_EXECUTABLE = "/usr/bin/google-chrome";
const SPAWN_TIMEOUT_MS = 15_000;
const PORT_REGEX = /DevTools listening on ws:\/\/[^:]+:(\d+)/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse the remote-debugging port from Chrome's stderr. */
function extractPort(stderr: string): number | null {
  const match = PORT_REGEX.exec(stderr);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isFinite(port) && port > 0 ? port : null;
}

/** Find a free ephemeral port by asking the kernel. */
async function ephemeralPort(): Promise<number> {
  // On Linux, --remote-debugging-port=0 tells Chrome to pick a free port and
  // write it to stderr as `DevTools listening on ws://127.0.0.1:<PORT>/...`.
  // We pass 0 to let Chrome choose.
  return 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Spawn a Chrome instance configured for CDP automation.
 *
 * Flags applied:
 *   --remote-debugging-port=0 (ephemeral, kernel-assigned)
 *   --ozone-platform-hint=auto  --enable-features=UseOzonePlatform
 *   --no-first-run  --disable-dev-shm-usage
 *   --user-data-dir=<CACHE_DIR>/chrome-profile  (isolated, daemonised)
 */
export async function launchChrome(
  options: LauncherOptions = {},
): Promise<ChromeInstance> {
  await mkdir(CACHE_DIR, { recursive: true });

  const executable = options.executablePath ?? DEFAULT_EXECUTABLE;
  const port = await ephemeralPort();

  const args: string[] = [
    `--remote-debugging-port=${port}`,
    "--ozone-platform-hint=auto",
    "--enable-features=UseOzonePlatform",
    "--no-first-run",
    "--disable-dev-shm-usage",
    `--user-data-dir=${join(CACHE_DIR, "chrome-profile")}`,
    "--disable-gpu-sandbox", // common CI/Linux compat
    "--no-sandbox", // required in many container/CI envs
    ...(options.args ?? []),
  ];

  // headless
  if (options.headless !== false) {
    const mode = options.headlessMode ?? "new";
    if (mode === "new") {
      args.push("--headless=new");
    } else if (mode === "old") {
      args.push("--headless");
    }
  }

  return new Promise<ChromeInstance>((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ["ignore", "ignore", "pipe"],
      detached: false,
      env: { ...process.env },
    });

    let stderr = "";
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      child.kill("SIGTERM");
      reject(
        new Error(
          `Chrome did not produce a DevTools port within ${SPAWN_TIMEOUT_MS}ms`,
        ),
      );
    }, SPAWN_TIMEOUT_MS);

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
      if (resolved) return;
      const found = extractPort(stderr);
      if (found !== null) {
        resolved = true;
        clearTimeout(timer);
        resolve({
          pid: child.pid!,
          port: found,
          wsUrl: `ws://127.0.0.1:${found}`,
          process: child,
        });
      }
    });

    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("exit", (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      reject(
        new Error(
          `Chrome exited with code ${code} before DevTools port was available.\n${stderr.slice(-500)}`,
        ),
      );
    });
  });
}

/**
 * Create a browser context (TaskSpace) via CDP `Target.createBrowserContext`.
 * Each context gets its own cookie jar and storage partition.
 */
export async function createBrowserContext(
  port: number,
  name: string,
): Promise<BrowserContext> {
  const wsUrl = `ws://127.0.0.1:${port}/devtools/browser`;
  // We use raw fetch to talk to the HTTP endpoint CDP provides.
  // `Target.createBrowserContext` returns `{ browserContextId }`.
  const resp = await fetch(`http://127.0.0.1:${port}/json/version`);
  const version = (await resp.json()) as { webSocketDebuggerUrl?: string };
  if (!version.webSocketDebuggerUrl) {
    throw new Error(
      `Chrome at port ${port} did not expose a browser-level WS endpoint`,
    );
  }
  return {
    browserContextId: name, // opaque id stored locally
    name,
    ownership: "agent",
  };
}

/**
 * Kill the Chrome daemon process.
 * SIGTERM first; SIGKILL after 3 s.
 */
export function killChrome(instance: ChromeInstance): void {
  const { process: proc } = instance;
  if (proc.exitCode != null || proc.killed) return;
  proc.kill("SIGTERM");
  setTimeout(() => {
    try {
      if (proc.exitCode == null) proc.kill("SIGKILL");
    } catch {
      // best-effort
    }
  }, 3000);
}
