import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { HostConfig } from "./config.js";
import { makeEgoError } from "./errors.js";

/** Ordered bare names and absolute fallbacks for Chrome/Chromium. */
export const DEFAULT_CHROME_CANDIDATES = [
  "google-chrome-stable",
  "google-chrome",
  "chromium",
  "chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
] as const;

export type ResolveChromePathOptions = {
  /** Override candidate list (default: DEFAULT_CHROME_CANDIDATES). Empty isolates host binaries in tests. */
  candidates?: readonly string[];
};

export type EnsureChromeOptions = {
  /** Passed through to resolveChromePath for test isolation. */
  candidates?: readonly string[];
};

const CDP_READY_TIMEOUT_MS = 15_000;
const CDP_POLL_MS = 100;

export type ChromeHandle = {
  pid: number;
  cdpPort: number;
  userDataDir: string;
  kill(): Promise<void>;
  waitForExit?(timeoutMs?: number): Promise<boolean>;
};

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveCandidate(
  candidate: string,
  env: NodeJS.ProcessEnv,
): string | null {
  if (candidate.includes("/") || candidate.startsWith(".")) {
    return isExecutable(candidate) ? candidate : null;
  }
  const pathEnv = env.PATH ?? "";
  for (const dir of pathEnv.split(":")) {
    if (!dir) continue;
    const full = join(dir, candidate);
    if (isExecutable(full)) return full;
  }
  return null;
}

/**
 * Resolve a Chrome/Chromium binary path.
 * Order: explicit → EGO_CHROME_PATH → well-known candidates on PATH / absolute paths.
 * Pass `options.candidates` (e.g. `[]`) to isolate tests from host-installed binaries.
 */
export function resolveChromePath(
  env: NodeJS.ProcessEnv = process.env,
  explicit?: string | null,
  options?: ResolveChromePathOptions,
): string | null {
  if (explicit) {
    const hit = resolveCandidate(explicit, env);
    if (hit) return hit;
  }
  const fromEnv = env.EGO_CHROME_PATH;
  if (fromEnv) {
    const hit = resolveCandidate(fromEnv, env);
    if (hit) return hit;
  }
  const candidates = options?.candidates ?? DEFAULT_CHROME_CANDIDATES;
  for (const candidate of candidates) {
    const hit = resolveCandidate(candidate, env);
    if (hit) return hit;
  }
  return null;
}

/** True when CDP HTTP endpoint answers on 127.0.0.1:port. */
export async function isCdpUp(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await sleep(50);
    } catch {
      return true;
    }
  }
  return false;
}

function hasDisplayEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

async function killProcessGroup(pid: number): Promise<void> {
  if (!pid || pid <= 0) return;

  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
      return true;
    } catch {
      try {
        process.kill(pid, sig);
        return true;
      } catch {
        return false;
      }
    }
  };

  if (!signal("SIGTERM")) return;

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await sleep(50);
    } catch {
      return;
    }
  }
  signal("SIGKILL");
}

function makeHandle(
  pid: number,
  cdpPort: number,
  userDataDir: string,
  child?: ChildProcess,
): ChromeHandle {
  let killed = false;
  return {
    pid,
    cdpPort,
    userDataDir,
    async waitForExit(timeoutMs = 3000) {
      if (!pid || pid <= 0) return false;
      return waitForProcessExit(pid, timeoutMs);
    },
    async kill() {
      if (killed) return;
      killed = true;
      if (child && child.pid) {
        await killProcessGroup(child.pid);
        return;
      }
      await killProcessGroup(pid);
    },
  };
}

export function buildChromeArgs(config: HostConfig): string[] {
  const args = [
    `--user-data-dir=${config.userDataDir}`,
    `--remote-debugging-port=${config.cdpPort}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (config.headless) {
    args.push("--headless=new");
  }
  if (config.noSandbox) {
    args.push("--no-sandbox");
  }
  return args;
}

/**
 * Attach to an existing CDP endpoint or launch Chrome with the host profile.
 * Headed by default; throws if headed and no DISPLAY/WAYLAND_DISPLAY.
 * When CDP is down (Chrome died or never started), spawns a new process —
 * call again after death to respawn. Throws EGO_BROWSER_UNAVAILABLE with
 * clear text on missing binary, no display, spawn failure, or CDP timeout.
 * `options.candidates` is for tests only (isolates host Chrome binaries).
 */
export async function ensureChrome(
  config: HostConfig,
  options?: EnsureChromeOptions,
): Promise<ChromeHandle> {
  if (await isCdpUp(config.cdpPort)) {
    // Attached mode: we did not spawn; pid unknown (0). kill is best-effort no-op on 0.
    return makeHandle(0, config.cdpPort, config.userDataDir);
  }

  const chromePath = resolveChromePath(process.env, config.chromePath, {
    candidates: options?.candidates,
  });
  if (!chromePath) {
    throw makeEgoError(
      "EGO_BROWSER_UNAVAILABLE",
      "Chrome/Chromium binary not found. Set EGO_CHROME_PATH or install google-chrome / chromium.",
    );
  }

  if (!config.headless && !hasDisplayEnv()) {
    throw makeEgoError(
      "EGO_BROWSER_UNAVAILABLE",
      "Headed Chrome requires DISPLAY or WAYLAND_DISPLAY. " +
        "Use WSLg/X11, or set EGO_HEADLESS=1 for headless mode.",
    );
  }

  await mkdir(config.userDataDir, { recursive: true });

  const args = buildChromeArgs(config);

  const child = spawn(chromePath, args, {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });

  // Own process group so kill(-pid) tears down Chrome helpers.
  child.unref();

  if (child.pid === undefined) {
    throw makeEgoError(
      "EGO_BROWSER_UNAVAILABLE",
      `Failed to spawn Chrome at ${chromePath}`,
    );
  }

  const pid = child.pid;
  const handle = makeHandle(pid, config.cdpPort, config.userDataDir, child);

  const deadline = Date.now() + CDP_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw makeEgoError(
        "EGO_BROWSER_UNAVAILABLE",
        `Chrome exited before CDP became ready (code=${child.exitCode}, signal=${child.signalCode})`,
      );
    }
    if (await isCdpUp(config.cdpPort)) {
      return handle;
    }
    await sleep(CDP_POLL_MS);
  }

  await handle.kill();
  throw makeEgoError(
    "EGO_BROWSER_UNAVAILABLE",
    `Chrome CDP did not become ready on port ${config.cdpPort} within ${CDP_READY_TIMEOUT_MS}ms`,
  );
}
