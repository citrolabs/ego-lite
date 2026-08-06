import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { stdin as processStdin } from "node:process";

import { locateBrowser } from "./browser-locator.js";
import { browserEndpoint, ensureBrowser } from "./chrome-launcher.js";
import { CdpConnection } from "./cdp-connection.js";
import { createEgoBridge } from "./ego-bridge.js";
import { TaskSpaceRegistry } from "./task-spaces.js";

export const HELP = `ego-windows-host

Runs ego-browser scripts against stock Microsoft Edge or Google Chrome on
Windows. The first call launches a dedicated browser profile (detached, it
stays running); later calls reuse it, so task spaces and logins persist
across invocations.

Usage:
  ego-windows-host <script.js>      run JavaScript from a file
  ego-windows-host -e <code>        run inline JavaScript (alias: --eval)
  ego-windows-host < task.js        read JavaScript from stdin
  ego-windows-host --doctor         report browser, endpoint, and space state
  ego-windows-host --help           print this help

A leading "nodejs" argument is accepted for compatibility with the
"ego-browser nodejs" invocation shape.

Environment:
  EGO_HOST_BROWSER_PATH   full path to msedge.exe / chrome.exe (default: auto-detect)
  EGO_HOST_DEBUG_PORT     CDP port for the hosted browser (default: 9522)
  EGO_HOST_STATE_DIR      state root (default: %LOCALAPPDATA%\\ego-windows-host)
  EGO_HOST_HEADLESS       set to 1 to launch the browser headless
`;

export function hostConfig(
  env: Record<string, string | undefined> = process.env,
) {
  const stateDir =
    env.EGO_HOST_STATE_DIR ||
    join(
      env.LOCALAPPDATA || join(homedir(), ".local", "share"),
      "ego-windows-host",
    );
  return {
    port: Number(env.EGO_HOST_DEBUG_PORT) || 9522,
    stateDir,
    userDataDir: join(stateDir, "profile"),
    headless: env.EGO_HOST_HEADLESS === "1" || env.EGO_HOST_HEADLESS === "true",
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = [...argv];
  if (args[0] === "nodejs") {
    args.shift();
  }
  if (args[0] === "-h" || args[0] === "--help") {
    process.stdout.write(HELP);
    return 0;
  }
  const config = hostConfig();
  if (args[0] === "--doctor") {
    return runDoctor(config);
  }

  const code = await resolveInput(args);
  if (code === null || !code.trim()) {
    process.stderr.write(HELP);
    return 2;
  }

  const { endpoint, launched } = await ensureBrowser({
    port: config.port,
    userDataDir: config.userDataDir,
    browserPath: () => locateBrowser(),
    headless: config.headless,
  });
  if (launched) {
    process.stderr.write(
      `[ego-windows-host] launched ${endpoint.Browser || "browser"} on port ${config.port}\n`,
    );
  }

  const hostConnection = await CdpConnection.open(
    endpoint.webSocketDebuggerUrl,
  );
  const agentConnection = await CdpConnection.open(
    endpoint.webSocketDebuggerUrl,
  );
  const registry = new TaskSpaceRegistry(config.stateDir);
  (globalThis as any).ego = createEgoBridge({
    hostConnection,
    agentConnection,
    registry,
    browserVersion: `${endpoint.Browser || "chromium"} (ego-windows-host)`,
  });

  // The runtime reads globalThis.ego at call time, so the bridge must exist
  // before helpers run. run.js has no import-time side effects (unlike the
  // package entry point, which auto-installs the SDK when imported).
  const { runMain } = await import("ego-browser-v2/dist/src/run.js");
  try {
    return await runMain({ argv: [], stdinText: code });
  } finally {
    hostConnection.close();
    agentConnection.close();
  }
}

async function resolveInput(args: string[]): Promise<string | null> {
  if (args[0] === "-e" || args[0] === "--eval") {
    return args.length === 2 ? args[1] : null;
  }
  if (args.length === 1 && !args[0].startsWith("-")) {
    return readFile(args[0], "utf8");
  }
  if (args.length > 0) {
    return null;
  }
  return new Promise<string>((resolve, reject) => {
    let data = "";
    processStdin.setEncoding("utf8");
    processStdin.on("data", (chunk) => {
      data += chunk;
    });
    processStdin.on("end", () => resolve(data));
    processStdin.on("error", reject);
  });
}

async function runDoctor(config: ReturnType<typeof hostConfig>) {
  const lines: string[] = [];
  try {
    lines.push(`browser: ${locateBrowser()}`);
  } catch (error) {
    lines.push(`browser: NOT FOUND (${error.message})`);
  }
  const endpoint = await browserEndpoint(config.port);
  lines.push(
    endpoint
      ? `endpoint: ${endpoint.Browser || "unknown"} on port ${config.port}`
      : `endpoint: not running (will launch on port ${config.port} at next call)`,
  );
  lines.push(`state dir: ${config.stateDir}`);
  const registry = new TaskSpaceRegistry(config.stateDir);
  const spaces = registry.list();
  lines.push(`task spaces: ${spaces.length}`);
  for (const space of spaces) {
    lines.push(
      `  #${space.id} ${JSON.stringify(space.name)} ownership=${space.ownership} tabs=${space.targetIds.length}`,
    );
  }
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}
