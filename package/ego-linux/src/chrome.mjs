import { spawn } from "node:child_process";
import { access, mkdir, readFile, readlink, writeFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

import { BROWSER_STATE_FILE, PROFILE_DIR, STATE_DIR } from "./paths.mjs";

const BINARY_CANDIDATES = [
  process.env.EGO_LINUX_CHROME,
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "brave-browser",
  "microsoft-edge",
].filter(Boolean);

// Chrome writes the negotiated port here once the DevTools endpoint is live.
const PORT_FILE = "DevToolsActivePort";

const LAUNCH_FLAGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  // Node's WebSocket sends no Origin; without this Chrome rejects the upgrade.
  "--remote-allow-origins=*",
  // Big enough that a page laid out for a desktop viewport fits. The default
  // headless window is ~800x600, which pushes lower page content out of view;
  // input dispatched at those coordinates hit-tests to nothing and
  // Input.dispatchMouseEvent can hang waiting for a frame that never comes.
  "--window-size=1280,900",
  // Without this the desktop's HiDPI scaling (1.5x here) shrinks the CSS
  // viewport — a 1280px window lays out as 853px — so page content the agent
  // expects on screen falls below the fold.
  "--force-device-scale-factor=1",
];

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveBinary() {
  for (const candidate of BINARY_CANDIDATES) {
    if (candidate.includes("/")) {
      if (await exists(candidate)) return candidate;
      continue;
    }
    const found = await which(candidate);
    if (found) return found;
  }
  throw new Error(
    `no Chrome/Chromium binary found (tried: ${BINARY_CANDIDATES.join(", ")}). ` +
      `Set EGO_LINUX_CHROME to an absolute path.`,
  );
}

function which(name) {
  return new Promise((resolve) => {
    const child = spawn("which", [name], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? out.trim() : null));
  });
}

/** Ask a running DevTools endpoint for its browser-level WebSocket URL. */
async function probe(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    const info = await response.json();
    return info.webSocketDebuggerUrl || null;
  } catch {
    return null;
  }
}

async function readBrowserState() {
  try {
    return JSON.parse(await readFile(BROWSER_STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function writeBrowserState(state) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(BROWSER_STATE_FILE, JSON.stringify(state, null, 2));
}

/** Poll for Chrome's port file; it appears a beat after the process starts. */
async function waitForPortFile(profileDir, timeoutMs = 20000) {
  const path = join(profileDir, PORT_FILE);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const [port] = (await readFile(path, "utf8")).split("\n");
      if (port && port.trim()) return Number(port.trim());
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Chrome did not expose a DevTools port within ${timeoutMs}ms`);
}

/**
 * Reset page zoom in the agent profile.
 *
 * --import-chrome-profile copies real Chrome preferences, which include the
 * user's zoom level. A 150% zoom lays a 1280px window out as 853 CSS px, so
 * content the page expects on screen falls below the fold — element coordinates
 * then hit-test to nothing and pointer input silently does nothing. This profile
 * exists only to drive agents, so zoom is pinned to 100%.
 */
async function neutralizeZoom(profileDir) {
  const path = join(profileDir, "Default", "Preferences");
  try {
    const prefs = JSON.parse(await readFile(path, "utf8"));
    let changed = false;
    for (const scope of ["partition", "profile"]) {
      for (const key of ["default_zoom_level", "per_host_zoom_levels"]) {
        if (prefs[scope]?.[key] && Object.keys(prefs[scope][key]).length > 0) {
          prefs[scope][key] = {};
          changed = true;
        }
      }
    }
    if (changed) await writeFile(path, JSON.stringify(prefs));
    return changed;
  } catch {
    // A fresh profile has no Preferences file yet; nothing to reset.
    return false;
  }
}

/** Whether a pid is a browser running against our own profile directory. */
async function ownsOurProfile(pid, profileDir) {
  try {
    const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8");
    return cmdline.includes(profileDir);
  } catch {
    return false;
  }
}

/**
 * Clear the profile lock before launching.
 *
 * Chrome's SingletonLock is a symlink named `<host>-<pid>`; a browser that dies
 * without a clean shutdown leaves it behind, and the next launch refuses to
 * start ("Failed to create a ProcessSingleton ... Aborting now").
 *
 * launch() only runs after ensureBrowser() has confirmed no DevTools endpoint
 * answers, so a lock owner that is still alive is an unreachable orphan of ours
 * — a browser we can no longer drive. Since this profile is single-purpose,
 * that orphan is terminated rather than left to block every future run.
 */
async function clearProfileLock(profileDir) {
  const lock = join(profileDir, "SingletonLock");
  let target;
  try {
    target = await readlink(lock);
  } catch {
    return false; // no lock at all
  }

  const pid = Number(target.slice(target.lastIndexOf("-") + 1));
  if (Number.isFinite(pid) && pid > 0 && (await ownsOurProfile(pid, profileDir))) {
    try {
      process.kill(pid, "SIGTERM");
      // Give it a moment to release the lock on its own.
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch {
      // already gone
    }
  }

  await Promise.all(
    ["SingletonLock", "SingletonSocket", "SingletonCookie"].map((name) =>
      rm(join(profileDir, name), { force: true }),
    ),
  );
  return true;
}

async function launch({ headless }) {
  const binary = await resolveBinary();
  await mkdir(PROFILE_DIR, { recursive: true });
  await neutralizeZoom(PROFILE_DIR);
  await clearProfileLock(PROFILE_DIR);
  // A stale port file would be read as this launch's port.
  await rm(join(PROFILE_DIR, PORT_FILE), { force: true });

  const args = [
    ...LAUNCH_FLAGS,
    `--user-data-dir=${PROFILE_DIR}`,
    "--remote-debugging-port=0",
    ...(headless ? ["--headless=new"] : []),
    "about:blank",
  ];
  const child = spawn(binary, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const port = await waitForPortFile(PROFILE_DIR);
  const wsUrl = await probe(port);
  if (!wsUrl) {
    throw new Error(`Chrome came up on port ${port} but exposed no WebSocket URL`);
  }
  await writeBrowserState({
    port,
    wsUrl,
    pid: child.pid,
    binary,
    headless,
    profileDir: PROFILE_DIR,
  });
  return { port, wsUrl, launched: true };
}

/**
 * Return a live browser-level CDP endpoint, reusing the browser this machine
 * already has open when possible. Each heredoc runs in its own short-lived Node
 * process, so the browser — not this process — is what has to persist.
 */
export async function ensureBrowser({ headless = false } = {}) {
  if (process.env.EGO_LINUX_CDP_URL) {
    return { wsUrl: process.env.EGO_LINUX_CDP_URL, launched: false };
  }

  const state = await readBrowserState();
  if (state?.port) {
    const wsUrl = await probe(state.port);
    if (wsUrl) return { port: state.port, wsUrl, launched: false };
  }
  return launch({ headless });
}

/** Terminate the backing browser and forget it. */
export async function stopBrowser() {
  const state = await readBrowserState();
  let stopped = false;
  if (state?.pid) {
    try {
      process.kill(state.pid, "SIGTERM");
      stopped = true;
    } catch {
      // already gone
    }
  }
  await rm(BROWSER_STATE_FILE, { force: true });
  // A SIGTERMed Chrome does not always release its profile lock, which would
  // block the next launch.
  await clearProfileLock(PROFILE_DIR);
  return stopped;
}

export async function browserStatus() {
  const state = await readBrowserState();
  if (!state?.port) return { running: false };
  const wsUrl = await probe(state.port);
  return wsUrl ? { running: true, ...state, wsUrl } : { running: false, ...state };
}
