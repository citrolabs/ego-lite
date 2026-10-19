#!/usr/bin/env node
// Read-only diagnostics. Does not start or attach to any browser.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { findChrome } from "../dist/src/linux/launcher.js";

export function report() {
  const binary = findChrome();
  let version = "";
  if (binary) {
    try {
      version = execFileSync(binary, ["--version"], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch {}
  }
  return {
    node: process.version,
    platform: process.platform,
    chrome: { binary: binary ?? null, version, available: Boolean(version) },
    transport:
      "owned Chrome process via remote-debugging-pipe (no TCP attachment)",
    sandbox: "enabled; startup fails if the OS cannot provide it",
    display: process.env.WAYLAND_DISPLAY
      ? "wayland"
      : process.env.DISPLAY
        ? "x11"
        : "none (headless)",
    hostBundle: existsSync(new URL("../dist/out/host.js", import.meta.url)),
  };
}
if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const value = report();
  console.log(JSON.stringify(value, null, 2));
  process.exitCode = value.chrome.available && value.hostBundle ? 0 : 1;
}
