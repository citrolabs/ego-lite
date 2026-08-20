#!/usr/bin/env node
/**
 * doctor-linux — diagnostic script for Linux ego-browser environments.
 *
 * Reports:
 *   - Chrome/Chromium version and install path
 *   - DevTools debugging port availability (default 9222)
 *   - Browser cache / user-data directory size
 *   - Wayland vs X11 display server
 *   - ws package (WebSocket) availability
 *   - Node.js version
 *
 * Usage:
 *   node scripts/doctor-linux.mjs
 *   node scripts/doctor-linux.mjs --json    (machine-readable output)
 *
 * Can also be consumed as a module from run.ts via the --doctor flag
 * when the platform is Linux.
 */

import { execSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { statSync, existsSync } from "node:fs";

const outputJson =
  process.argv.includes("--json") || process.argv.includes("-j");

/**
 * @param {string} cmd
 * @param {{ env?: Record<string,string> }} [opts]
 * @returns {string}
 */
function run(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
      ...opts,
    }).trim();
  } catch {
    return "";
  }
}

/**
 * Try to find the Chrome/Chromium binary and its version.
 */
function chromeInfo() {
  const candidates = [
    "google-chrome-stable",
    "google-chrome",
    "google-chrome-beta",
    "google-chrome-unstable",
    "chromium",
    "chromium-browser",
    "chrome",
  ];

  let binary = "";
  let version = "";

  for (const name of candidates) {
    const path = run(`which ${name} 2>/dev/null`);
    if (path) {
      binary = path;
      version = run(`${path} --version 2>/dev/null`);
      if (version) break;
    }
  }

  // Fallback: check common install locations
  if (!binary) {
    for (const dir of [
      "/opt/google/chrome",
      "/opt/google/chrome-beta",
      "/usr/bin",
      "/snap/bin",
    ]) {
      for (const name of [
        "google-chrome-stable",
        "google-chrome",
        "chromium",
        "chromium-browser",
      ]) {
        const p = join(dir, name);
        if (existsSync(p)) {
          binary = p;
          version = run(`${p} --version 2>/dev/null`);
          if (version) break;
        }
      }
      if (binary) break;
    }
  }

  return { binary, version };
}

/**
 * Check if a process is listening on the given port.
 */
function portStatus(port = 9222) {
  const methods = [
    // ss (iproute2, most common)
    () => {
      const out = run(`ss -tlnp 2>/dev/null | grep ":${port} "`);
      return out
        ? `listening: ${out.split(/\s+/).slice(0, 5).join(" ")}`
        : "not listening";
    },
    // netstat fallback
    () => {
      const out = run(`netstat -tlnp 2>/dev/null | grep ":${port} "`);
      return out
        ? `listening: ${out.split(/\s+/).slice(0, 5).join(" ")}`
        : "not listening";
    },
    // Direct HTTP check
    () => {
      const out = run(
        `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:${port}/json/version 2>/dev/null`,
      );
      return out === "200"
        ? "responding (HTTP 200)"
        : `HTTP ${out || "unreachable"}`;
    },
  ];

  for (const method of methods) {
    const result = method();
    if (result && result !== "not listening" && !result.startsWith("HTTP ")) {
      return { status: "ready", detail: result, port };
    }
    if (result === "responding (HTTP 200)") {
      return { status: "ready", detail: result, port };
    }
  }

  return {
    status: "unavailable",
    detail: methods[2]?.() || "unreachable",
    port,
  };
}

/**
 * Report Chrome cache directory size.
 */
function cacheInfo() {
  const candidates = [
    join(homedir(), ".cache/google-chrome"),
    join(homedir(), ".cache/chromium"),
    join(homedir(), ".config/google-chrome"),
    join(homedir(), ".config/chromium"),
    join(homedir(), "snap/chromium/common/.cache/chromium"),
    join(homedir(), "snap/chromium/current/.config/chromium"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const size = dirSize(candidate);
      return {
        path: candidate,
        sizeMB: size > 0 ? (size / (1024 * 1024)).toFixed(1) : "0",
      };
    }
  }
  return { path: "", sizeMB: "0" };
}

function dirSize(dir) {
  try {
    const out = run(`du -sm "${dir}" 2>/dev/null | cut -f1`);
    return parseInt(out, 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Detect display server type.
 */
function displayServer() {
  const wayland = process.env.WAYLAND_DISPLAY || run("echo $XDG_SESSION_TYPE");
  const x11 = process.env.DISPLAY;

  if (wayland && wayland !== "x11" && wayland !== "tty") {
    return {
      type: "wayland",
      display: wayland,
      x11Fallback: x11 || "",
    };
  }
  if (x11) {
    return { type: "x11", display: x11 };
  }
  return { type: "unknown", display: "" };
}

/**
 * Check ws package availability.
 */
function wsPackageInfo() {
  try {
    // Use dynamic require to check without statically importing
    const pkg = JSON.parse(
      run(
        "node -e \"console.log(JSON.stringify(require('ws/package.json')))\" 2>/dev/null",
      ) || "{}",
    );
    if (pkg.version) {
      return { available: true, version: pkg.version };
    }
  } catch {
    // not found
  }

  // Check if it's resolvable from the project
  try {
    const p = join(
      import.meta.dirname,
      "..",
      "node_modules",
      "ws",
      "package.json",
    );
    if (existsSync(p)) {
      const pkg = JSON.parse(run(`cat "${p}"`));
      return { available: true, version: pkg.version };
    }
  } catch {
    // not found
  }

  return { available: false, version: "" };
}

/**
 * Node.js info.
 */
function nodeInfo() {
  return {
    version: process.version,
    platform: platform(),
    arch: process.arch,
  };
}

function main() {
  const chrome = chromeInfo();
  const port = portStatus();
  const cache = cacheInfo();
  const display = displayServer();
  const wsPkg = wsPackageInfo();
  const node = nodeInfo();

  const report = {
    platform: "linux",
    timestamp: new Date().toISOString(),
    node,
    chrome: {
      binary: chrome.binary,
      version: chrome.version || "not found",
      detected: Boolean(chrome.binary && chrome.version),
    },
    devtools: {
      port: port.port,
      status: port.status,
      detail: port.detail,
    },
    browserCache: cache,
    displayServer: display,
    dependencies: {
      ws: wsPkg,
    },
  };

  if (outputJson) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  console.log("🩺 ego-browser Linux Diagnostic Report");
  console.log("======================================\n");
  console.log(`  Node.js:     ${node.version} (${node.platform} ${node.arch})`);

  console.log(`  Chrome:      ${chrome.version || "❌ not found"}`);
  if (chrome.binary) console.log(`  Chrome bin:  ${chrome.binary}`);

  console.log(`\n  DevTools:    port ${port.port} — ${port.status}`);
  console.log(`               ${port.detail}`);

  console.log(`\n  Cache:       ${cache.path || "❌ not found"}`);
  if (cache.path) console.log(`               ${cache.sizeMB} MB`);

  console.log(`\n  Display:     ${display.type}`);
  if (display.display)
    console.log(
      `               ${display.display}${display.x11Fallback ? ` (X11: ${display.x11Fallback})` : ""}`,
    );

  console.log(
    `\n  ws package:  ${wsPkg.available ? `✅ v${wsPkg.version}` : "❌ not installed"}`,
  );

  // Summary
  const issues = [];
  if (!report.chrome.detected) issues.push("Chrome/Chromium not found");
  if (port.status !== "ready" && process.env.EGO_LINUX !== "1")
    issues.push(
      `DevTools port ${port.port} not responding (launch with EGO_LINUX=1)`,
    );
  if (!wsPkg.available) issues.push("ws package not installed");
  if (display.type === "unknown")
    issues.push("Display server unknown (headless CI is normal)");

  console.log("\n--------------------------------------");
  if (issues.length === 0) {
    console.log("✅ All checks passed.");
  } else {
    console.log(`⚠️  ${issues.length} issue(s) found:`);
    for (const issue of issues) {
      console.log(`   - ${issue}`);
    }
  }

  return issues.length > 0 ? 1 : 0;
}

// Run if called directly
const isMain =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/^\.?\/?/, ""));
if (isMain || process.argv[1]?.includes("doctor-linux")) {
  process.exitCode = main();
}

export {
  chromeInfo,
  portStatus,
  cacheInfo,
  displayServer,
  wsPackageInfo,
  nodeInfo,
  main,
};
