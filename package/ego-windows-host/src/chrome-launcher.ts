import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const READY_TIMEOUT_MS = 20000;
const POLL_INTERVAL_MS = 250;
// Chromium's own default window is small enough that responsive sites collapse
// their controls: Wikipedia replaces its search field with a toggle button and
// leaves a 0x0 unfocusable input behind, so fill() silently writes nothing. A
// desktop-sized window keeps agent scripts on the layout desktop users see.
const DEFAULT_WINDOW = { width: 1440, height: 960 };

type EndpointInfo = {
  webSocketDebuggerUrl: string;
  Browser?: string;
};

type EnsureBrowserOptions = {
  port: number;
  userDataDir: string;
  /** Lazy so the browser is only located when a launch is actually needed. */
  browserPath: () => string;
  headless?: boolean;
  spawnFn?: typeof spawn;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  exists?: (path: string) => boolean;
  windowSize?: { width: number; height: number };
};

/**
 * Probe the DevTools HTTP endpoint on the loopback interface. Resolves with
 * the version info (including the browser-level websocket URL) when a
 * CDP-capable browser answers, or null when nothing (or something else)
 * listens on the port.
 */
export async function browserEndpoint(
  port: number,
  fetchFn: typeof fetch = fetch,
): Promise<EndpointInfo | null> {
  try {
    const response = await fetchFn(`http://127.0.0.1:${port}/json/version`);
    if (!response.ok) {
      return null;
    }
    const info = await response.json();
    return typeof info?.webSocketDebuggerUrl === "string" ? info : null;
  } catch {
    return null;
  }
}

/**
 * Reuse the browser already serving CDP on the port, or launch one detached
 * so it outlives this process. The browser itself is the persistent state
 * holder across CLI invocations — there is no separate daemon to manage.
 */
export async function ensureBrowser(options: EnsureBrowserOptions) {
  const fetchFn = options.fetchFn || fetch;
  const sleep =
    options.sleep ||
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const existing = await browserEndpoint(options.port, fetchFn);
  if (existing) {
    return { endpoint: existing, launched: false };
  }
  const browserPath = options.browserPath();
  const windowSize = options.windowSize ?? DEFAULT_WINDOW;
  mkdirSync(options.userDataDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${options.port}`,
    `--user-data-dir=${options.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    `--window-size=${windowSize.width},${windowSize.height}`,
    ...(options.headless ? ["--headless=new"] : []),
    "about:blank",
  ];
  const spawnFn = options.spawnFn || spawn;
  const child = spawnFn(browserPath, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const timeoutMs = options.timeoutMs ?? READY_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const endpoint = await browserEndpoint(options.port, fetchFn);
    if (endpoint) {
      return { endpoint, launched: true };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `browser did not expose CDP on port ${options.port} within ${timeoutMs}ms.` +
      diagnoseLaunchFailure({
        port: options.port,
        userDataDir: options.userDataDir,
        browserPath,
        args,
        exists: options.exists ?? existsSync,
      }),
  );
}

/**
 * Explain a launch that never came up. Two causes account for nearly all of
 * them and neither is guessable from the bare timeout:
 *
 *  - The profile is already open in another browser process. Chromium forwards
 *    the command line to the running instance and exits, so the debugging port
 *    is never bound and no error is printed anywhere.
 *  - Something else already holds the port, so binding fails silently.
 *
 * The launched command line is included so the failure can be reproduced by
 * hand, which is the fastest way to see the browser's own message.
 */
function diagnoseLaunchFailure(context: {
  port: number;
  userDataDir: string;
  browserPath: string;
  args: string[];
  exists: (path: string) => boolean;
}) {
  const causes: string[] = [];
  // Chromium writes this while a process holds the profile; a stale one is left
  // behind by a crash, which is equally worth reporting.
  if (context.exists(join(context.userDataDir, "lockfile"))) {
    causes.push(
      `the profile at ${context.userDataDir} looks locked by another browser process (close it, or use a different EGO_HOST_STATE_DIR)`,
    );
  }
  causes.push(
    `another process may already hold port ${context.port} (set EGO_HOST_DEBUG_PORT to a free port)`,
  );
  return [
    "",
    "Possible causes:",
    ...causes.map((cause) => `  - ${cause}`),
    "",
    "Run this by hand to see the browser's own error:",
    `  "${context.browserPath}" ${context.args.join(" ")}`,
  ].join("\n");
}
