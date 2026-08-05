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
import { existsSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { browserStatus, stopBrowser } from "../src/chrome.mjs";
import { installDesktopEntry } from "../src/desktop.mjs";
import { CHROME_CONFIG_CANDIDATES, PROFILE_DIR } from "../src/paths.mjs";
import { createEgoShim } from "../src/shim.mjs";

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
  --stop                    stop the backing browser
  --import-chrome-profile   copy your real Chrome profile in, to inherit logins
  --install-desktop-entry   add it to your app launcher, with an icon
  --headless                run the backing browser headless (first launch only)
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

  const headless = argv.includes("--headless");
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
