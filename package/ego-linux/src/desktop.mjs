import { spawn } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { WM_CLASS } from "./chrome.mjs";

/**
 * Desktop integration.
 *
 * The macOS build installs as an app: an icon in the launcher you click to open
 * the browser your agents share. There is no Linux app to install, but the same
 * affordance is just an XDG desktop entry plus an icon, so this provides one.
 */

const DATA_HOME = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
const APP_ID = "ego-lite-linux";
const ICON_SOURCE = new URL("../assets/ego-lite-linux.svg", import.meta.url);
const LAUNCHER = new URL("../bin/ego-browser.mjs", import.meta.url);

/**
 * The desktop session's PATH is not your shell's. A node installed by nvm, fnm
 * or asdf lives outside it, so a `#!/usr/bin/env node` shebang resolves to
 * nothing and clicking the icon fails silently. Pin the interpreter that is
 * running this installer — re-run --install-desktop-entry after switching node
 * versions.
 */
function desktopEntry(execPath) {
  return `[Desktop Entry]
Type=Application
Name=ego lite (Linux port)
GenericName=Agent Browser
Comment=The browser you and your AI agents share
Exec=${process.execPath} ${execPath} --open
Icon=${APP_ID}
Terminal=false
# Ties the browser window (launched with --class=ego-lite-linux) to this entry,
# so the desktop shows it as its own running app under this icon instead of
# folding it into the ordinary Chrome window group.
StartupWMClass=${WM_CLASS}
Categories=Network;WebBrowser;
Keywords=agent;automation;browser;ego;
StartupNotify=true
`;
}

/** Best-effort cache refresh; the entry works without it on most desktops. */
function refresh(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

export async function installDesktopEntry() {
  const applications = join(DATA_HOME, "applications");
  const icons = join(DATA_HOME, "icons", "hicolor", "scalable", "apps");
  await mkdir(applications, { recursive: true });
  await mkdir(icons, { recursive: true });

  const iconPath = join(icons, `${APP_ID}.svg`);
  await copyFile(fileURLToPath(ICON_SOURCE), iconPath);

  const entryPath = join(applications, `${APP_ID}.desktop`);
  await writeFile(entryPath, desktopEntry(fileURLToPath(LAUNCHER)), { mode: 0o755 });

  await refresh("update-desktop-database", [applications]);
  await refresh("gtk-update-icon-cache", ["-f", "-t", join(DATA_HOME, "icons", "hicolor")]);

  return { entryPath, iconPath };
}
