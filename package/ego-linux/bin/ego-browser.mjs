#!/usr/bin/env node
/**
 * ego-browser, Linux edition.
 *
 * Same CLI shape as the macOS app's `ego-browser`: a heredoc of JS on stdin,
 * executed with every ego-browser helper preloaded. The difference is what backs
 * it — `globalThis.ego` is this port's CDP shim over a stock Chromium instead of
 * the app's native bindings. Everything above that line is the upstream harness,
 * unmodified.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { browserStatus, stopBrowser } from "../src/chrome.mjs";
import { installDesktopEntry } from "../src/desktop.mjs";
import {
  CHROME_CONFIG_CANDIDATES,
  PROFILE_DIR,
  SPACES_STATE_FILE,
  TASK_SPACE_FILE,
  STATE_DIR,
} from "../src/paths.mjs";
import { createEgoShim } from "../src/shim.mjs";
import { startSpacesServer } from "../src/spaces-server.mjs";

const HARNESS = new URL("../../ego-browser/dist/out/index.js", import.meta.url);
const SKILL_WORKSPACE = new URL("../../../skills/ego-browser", import.meta.url);

const USAGE = `ego-browser (Linux port)

  ego-browser <<'JS'
  await page.goto('https://example.com')
  console.log(await page.snapshot())
  JS

Linux-only commands:
  --status                  show the backing browser's connection state
  --open                    open the shared agent browser window
  --spaces                  open the Spaces overview panel
  --prune-spaces            close spaces that hold nothing but about:blank
                            Spaces nobody returns to are also closed on their
                            own after 30 minutes idle; a space stays alive as
                            long as its session keeps using it. Set
                            EGO_LINUX_SPACE_IDLE_MIN to change the window, or
                            0 to sweep only by hand
  --stop                    stop the backing browser
  --import-chrome-profile   copy your real Chrome profile in, to inherit logins
  --install-desktop-entry   add it to your app launcher, with an icon
  --headless                run the backing browser headless (first launch only)
                            EGO_LINUX_HEADLESS=1 makes that the default, so the
                            agent window never opens over your work; --open
                            still gives you a visible one when you want it
`;

async function importChromeProfile() {
  const source = CHROME_CONFIG_CANDIDATES.find((candidate) =>
    existsSync(join(candidate, "Default")),
  );
  if (!source) {
    process.stderr.write("no Chrome/Chromium profile found to import\n");
    return 1;
  }
  const status = await browserStatus();
  if (status.running) {
    process.stderr.write(
      "the backing browser is running; run --stop and close it before importing\n",
    );
    return 1;
  }
  process.stderr.write(`importing ${join(source, "Default")} -> ${PROFILE_DIR}/Default\n`);
  await cp(join(source, "Default"), join(PROFILE_DIR, "Default"), {
    recursive: true,
    force: true,
  });
  process.stderr.write("done — logins and cookies now carry into agent tasks\n");
  return 0;
}

/** Is a Spaces server already listening on the recorded port? */
async function liveSpacesServer() {
  try {
    const state = JSON.parse(await readFile(SPACES_STATE_FILE, "utf8"));
    const response = await fetch(`http://127.0.0.1:${state.port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok ? state.port : null;
  } catch {
    return null;
  }
}

/** Open the panel as a chrome-less app window on the shared browser. */
async function openPanelWindow(url) {
  const status = await browserStatus();
  spawn(status.binary || "google-chrome", [`--user-data-dir=${PROFILE_DIR}`, `--app=${url}`], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

/**
 * Serve the Spaces panel until the browser goes away.
 *
 * Runs detached, because the panel's backend must outlive the command that
 * opened it. Tying the server to a foreground CLI process meant that closing
 * the terminal — or any timeout around it — left the panel showing
 * "cannot reach the browser".
 */
async function runSpacesDaemon() {
  // Spaces created from the panel are the user's, not the profile that happened
  // to launch this daemon (see agent-identity.mjs).
  process.env.EGO_LINUX_PANEL = "1";
  const shim = await createEgoShim({ headless: false });
  const spaces = await startSpacesServer(shim);
  const url = `http://127.0.0.1:${spaces.port}/`;

  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(
    SPACES_STATE_FILE,
    JSON.stringify({ port: spaces.port, pid: process.pid }, null, 2),
  );

  // The daemon owns the window it serves, so starting one always shows it.
  await openPanelWindow(url);

  const outcome = await new Promise((resolve) => {
    process.on("SIGINT", () => resolve("signal"));
    process.on("SIGTERM", () => resolve("signal"));

    // Give Chrome a moment to register the window before deciding it is absent.
    let seenPanel = false;
    const started = Date.now();

    const timer = setInterval(async () => {
      let tabs;
      try {
        ({ tabs } = await shim.ego.listTabs());
      } catch {
        // The browser went away, taking every window — including this panel —
        // with it. That is a restart, not a decision, so hand off to a fresh
        // daemon that will reopen the panel against the new browser.
        clearInterval(timer);
        resolve("browser-gone");
        return;
      }

      const open = tabs.some((tab) => tab.url.startsWith(url));
      if (open) {
        seenPanel = true;
        return;
      }
      // Closing the panel while the browser keeps running is deliberate: stop
      // serving rather than reopening a window the user just dismissed.
      if (seenPanel || Date.now() - started > 20000) {
        clearInterval(timer);
        resolve("panel-closed");
      }
    }, 2500);
  });

  spaces.close();
  shim.close();
  await rm(SPACES_STATE_FILE, { force: true });

  if (outcome === "browser-gone") {
    spawn(process.execPath, [fileURLToPath(import.meta.url), "--spaces-daemon"], {
      detached: true,
      stdio: "ignore",
    }).unref();
  }
  return 0;
}

/**
 * Open the Spaces overview.
 *
 * The panel is a real Chrome app window (`--app`): no tab strip, no toolbar, its
 * own app_id. Chrome routes the request to the already-running instance because
 * the profile matches, so this adds a window rather than a second browser.
 */
async function openSpaces() {
  const running = await liveSpacesServer();

  // A running daemon already owns a window; ask it for another one. A cold start
  // opens its own, so opening one here too would give you two.
  if (running) {
    await openPanelWindow(`http://127.0.0.1:${running}/`);
    process.stderr.write(`Spaces panel: http://127.0.0.1:${running}/\n`);
    return 0;
  }

  spawn(process.execPath, [fileURLToPath(import.meta.url), "--spaces-daemon"], {
    detached: true,
    stdio: "ignore",
  }).unref();

  let port = null;
  const deadline = Date.now() + 30000;
  while (!port && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    port = await liveSpacesServer();
  }
  if (!port) {
    process.stderr.write("the Spaces server did not come up\n");
    return 1;
  }

  process.stderr.write(`Spaces panel: http://127.0.0.1:${port}/\n`);
  return 0;
}

/**
 * Sweep spaces that hold nothing but about:blank.
 *
 * The automatic sweep in reconcile only touches spaces stamped with a creation
 * time, so it cannot reach the drift left behind before that existed — and a
 * user staring at twenty empty windows wants them gone now, not in two minutes.
 * Explicitly invoked, so it ignores age and asks no questions.
 */
async function pruneSpaces() {
  // Maintenance must never be the thing that opens a browser. Forcing a headed
  // launch here meant running the sweep on a quiet machine started a visible
  // window — producing exactly the empty windows it exists to clear.
  const status = await browserStatus();
  if (!status.running) {
    process.stdout.write("no backing browser is running; nothing to prune\n");
    return 0;
  }
  const shim = await createEgoShim({ headless: status.headless === true });
  try {
    const { taskSpaces = [] } = await shim.ego.listTaskSpaces();
    // The selected space is the one an agent is working in right now, and its
    // tab is about:blank for a moment on every navigation. Closing it would
    // take the agent's context out from under it mid-task.
    let selectedId = null;
    try {
      ({ selectedId = null } = JSON.parse(await readFile(TASK_SPACE_FILE, "utf8")));
    } catch {
      // No state file means no selection to protect.
    }
    const { targetInfos = [] } = await shim.cdp.call("Target.getTargets");
    const byTarget = new Map(targetInfos.map((target) => [target.targetId, target]));

    let closed = 0;
    for (const space of taskSpaces) {
      const tabs = (space.targetIds || []).map((id) => byTarget.get(id)).filter(Boolean);
      if (tabs.length === 0) continue;
      if (space.id === selectedId) continue;
      if (space.lastContentAt) continue;
      if (!tabs.every((target) => target.url === "about:blank")) continue;
      await shim.ego.closeTaskSpace(space.id).then(
        () => {
          closed += 1;
        },
        () => {},
      );
    }
    process.stdout.write(
      closed === 0
        ? "no empty spaces to close\n"
        : `closed ${closed} empty ${closed === 1 ? "space" : "spaces"}\n`,
    );
  } finally {
    shim.close();
  }
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);

  // The skill documents `ego-browser nodejs <<'EOF'`; accept it as a no-op prefix.
  if (argv[0] === "nodejs") argv.shift();

  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (argv[0] === "--status") {
    process.stdout.write(`${JSON.stringify(await browserStatus(), null, 2)}\n`);
    return 0;
  }
  if (argv[0] === "--stop") {
    const stopped = await stopBrowser();
    process.stdout.write(
      stopped
        ? "backing browser stopped; the next run launches a fresh one\n"
        : "no backing browser was running; profile lock cleared\n",
    );
    return 0;
  }
  if (argv[0] === "--import-chrome-profile") {
    return importChromeProfile();
  }
  if (argv[0] === "--prune-spaces") {
    return pruneSpaces();
  }
  if (argv[0] === "--spaces") {
    return openSpaces();
  }
  if (argv[0] === "--spaces-daemon") {
    return runSpacesDaemon();
  }
  if (argv[0] === "--install-desktop-entry") {
    const { entryPath, iconPath } = await installDesktopEntry();
    process.stdout.write(`installed ${entryPath}\n         ${iconPath}\n`);
    return 0;
  }
  if (argv[0] === "--open") {
    // Launched from a desktop icon there is no terminal to read an error in, so
    // this has to succeed rather than explain. A headless browser has no window
    // to show, so trade it for a visible one.
    const status = await browserStatus();
    if (status.running && status.headless) {
      process.stderr.write("replacing the headless browser with a visible one\n");
      await stopBrowser();
    }
    const shim = await createEgoShim({ headless: false });
    try {
      const { tabs } = await shim.ego.listTabs();
      // A browser with no page target shows no window; give it one.
      let targetId = tabs.find((tab) => tab.active)?.targetId ?? tabs[0]?.targetId;
      if (!targetId) ({ targetId } = await shim.ego.createTab("about:blank"));

      // The window usually already exists — it is just behind everything else.
      // Clicking a launcher icon has to raise it, not quietly confirm it is
      // running, which looks identical to nothing happening.
      await shim.cdp.call("Target.activateTarget", { targetId }).catch(() => {});
      const { sessionId } = await shim.cdp.call("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      await shim.cdp.call("Page.bringToFront", {}, sessionId).catch(() => {});
    } finally {
      shim.close();
    }
    return 0;
  }

  // EGO_LINUX_HEADLESS is for a machine whose owner does not want the agent
  // window in front of their work. The harness needs a page target to attach to,
  // so a visible browser always shows a window — headless is the only way to be
  // driven without one. --headless still works per run, and --open still trades
  // a headless browser for a visible one on demand.
  const envHeadless = !["", "0", "false", "no"].includes(
    (process.env.EGO_LINUX_HEADLESS ?? "").toLowerCase(),
  );
  const headless = argv.includes("--headless") || envHeadless;
  const rest = argv.filter((arg) => arg !== "--headless");

  // `--sdk-path <file>` selects which harness bundle to run. Upstream's real
  // browser e2e runner passes it to test a local build; here the local build is
  // the only harness there is, so honour the path it names.
  let harness = HARNESS.href;
  const sdkFlag = rest.indexOf("--sdk-path");
  if (sdkFlag !== -1) {
    const path = rest[sdkFlag + 1];
    if (!path) {
      process.stderr.write("--sdk-path requires a path\n");
      return 2;
    }
    harness = pathToFileURL(path).href;
    rest.splice(sdkFlag, 2);
  }

  // Site skills and learnings live in the repo's skill directory.
  process.env.EGO_BROWSER_AGENT_WORKSPACE ||= SKILL_WORKSPACE.pathname;

  const shim = await createEgoShim({ headless });
  globalThis.ego = shim.ego;

  const { runMain } = await import(harness);
  try {
    return await runMain({ argv: rest });
  } finally {
    shim.close();
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exit(1);
  });
