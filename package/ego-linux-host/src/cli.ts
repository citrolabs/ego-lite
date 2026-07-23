/**
 * ego-browser CLI shim for Linux host.
 *
 * Ensures host daemon is up, installs globalThis.ego, runs ego-browser harness.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { open, mkdir, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { loadConfig, type HostConfig } from "./config.js";
import { connectHost, installEgoClient, pingSocket } from "./ego-client.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const CLI_HELP = `ego-browser (Linux host)

Read the ego-browser skill for the default workflow and examples.

Typical usage:
  ego-browser <<'JS'
  await page.waitForLoadState()
  console.log(await page.info())
  JS

  ego-browser nodejs <<'JS'
  // same helpers; optional "nodejs" subcommand is stripped
  JS

Commands:
  ego-browser --help           show this help
  ego-browser --doctor         ensure host and print diagnostics
  ego-browser --reload         reconnect host CDP channel
`;

export type RunCliOptions = {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  harnessPath?: string;
  /** Override host ensure (tests). */
  ensureHost?: (
    config: HostConfig,
    options?: { env?: NodeJS.ProcessEnv; packageRoot?: string },
  ) => Promise<void>;
  packageRoot?: string;
};

export type CliFlags = {
  help: boolean;
  doctor: boolean;
  reload: boolean;
  remaining: string[];
};

/** Strip optional leading "nodejs" subcommand used by skill docs. */
export function stripNodejsSubcommand(argv: string[]): string[] {
  if (argv[0] === "nodejs") return argv.slice(1);
  return argv.slice();
}

/**
 * Parse argv: strip nodejs, detect --help / --doctor / --reload as first flag.
 */
export function parseCliFlags(argv: string[]): CliFlags {
  const stripped = stripNodejsSubcommand(argv);
  const head = stripped[0];
  if (head === "--help" || head === "-h") {
    return { help: true, doctor: false, reload: false, remaining: [] };
  }
  if (head === "--doctor") {
    return { help: false, doctor: true, reload: false, remaining: [] };
  }
  if (head === "--reload") {
    return { help: false, doctor: false, reload: true, remaining: [] };
  }
  return {
    help: false,
    doctor: false,
    reload: false,
    remaining: stripped,
  };
}

/**
 * Resolve harness module path that exports runMain.
 *
 * Order:
 * 1. explicit harnessPath / EGO_HARNESS_PATH
 * 2. ../ego-browser/dist/src/run.js (preferred)
 * 3. ../ego-browser/dist/out/index.js
 * 4. ../ego-browser/deps/ego-browser/index.js
 */
export function resolveHarnessPath(
  env: NodeJS.ProcessEnv = process.env,
  packageRoot: string = PACKAGE_ROOT,
  explicit?: string,
): string {
  if (explicit) return resolve(explicit);
  if (env.EGO_HARNESS_PATH) return resolve(env.EGO_HARNESS_PATH);

  const sibling = join(packageRoot, "..", "ego-browser");
  const candidates = [
    join(sibling, "dist", "src", "run.js"),
    join(sibling, "dist", "out", "index.js"),
    join(sibling, "deps", "ego-browser", "index.js"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    [
      "ego-browser harness not found. Build it first:",
      "  cd package/ego-browser && npm ci && npm run build",
      `Looked under: ${sibling}`,
    ].join("\n"),
  );
}

/** Default skills workspace relative to monorepo root. */
export function defaultAgentWorkspace(packageRoot: string = PACKAGE_ROOT): string {
  return join(packageRoot, "..", "..", "skills", "ego-browser");
}

/**
 * Unlink a leftover host socket file when the daemon is not answering.
 * Safe if the path is already gone (ENOENT).
 */
export async function unlinkStaleSocket(socketPath: string): Promise<boolean> {
  if (!existsSync(socketPath)) return false;
  try {
    await unlink(socketPath);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return false;
    // Best-effort: daemon start also unlinks before listen.
    return false;
  }
}

/**
 * Ensure host daemon is listening on config.hostSocket.
 * If the socket file exists but ping fails, unlinks the stale sock and restarts.
 * Spawns bin/ego-linux-hostd.mjs detached if needed; polls ping up to 15s.
 */
export async function ensureHost(
  config: HostConfig,
  options: {
    env?: NodeJS.ProcessEnv;
    packageRoot?: string;
    timeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<void> {
  const env = options.env ?? process.env;
  if (await pingSocket(config.hostSocket)) return;

  // Stale socket recovery: file exists but daemon is not answering → unlink + restart.
  await unlinkStaleSocket(config.hostSocket);

  const packageRoot = options.packageRoot ?? PACKAGE_ROOT;
  const daemonScript = join(packageRoot, "bin", "ego-linux-hostd.mjs");
  if (!existsSync(daemonScript)) {
    throw new Error(`daemon entry not found: ${daemonScript}`);
  }

  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const logPath = join(config.dataDir, "host.log");
  const logFh = await open(logPath, "a");

  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    EGO_HOST_SOCK: config.hostSocket,
    EGO_DATA_DIR: config.dataDir,
    EGO_USER_DATA_DIR: config.userDataDir,
    EGO_CDP_PORT: String(config.cdpPort),
  };
  if (config.chromePath) childEnv.EGO_CHROME_PATH = config.chromePath;
  if (config.headless) childEnv.EGO_HEADLESS = "1";

  const child = spawn(process.execPath, [daemonScript], {
    detached: true,
    stdio: ["ignore", logFh.fd, logFh.fd],
    env: childEnv,
  });
  child.unref();
  // Parent no longer needs the fd; child has inherited it.
  await logFh.close().catch(() => {});

  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollMs = options.pollMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pingSocket(config.hostSocket)) return;
    await sleep(pollMs);
  }
  throw new Error(
    `ego-linux-hostd did not become ready within ${timeoutMs}ms (socket ${config.hostSocket}; log ${logPath})`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function writeStream(
  stream: NodeJS.WritableStream | undefined,
  text: string,
): void {
  if (!stream) return;
  stream.write(text);
}

/**
 * CLI entry: flags, ensure host, install ego, run harness runMain.
 */
export async function runCli(
  argv: string[],
  opts: RunCliOptions = {},
): Promise<number> {
  const env = { ...(opts.env ?? process.env) };
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const stdin = opts.stdin ?? process.stdin;
  const packageRoot = opts.packageRoot ?? PACKAGE_ROOT;

  const flags = parseCliFlags(argv);

  if (flags.help) {
    writeStream(stdout, CLI_HELP);
    if (!CLI_HELP.endsWith("\n")) writeStream(stdout, "\n");
    return 0;
  }

  if (!env.EGO_BROWSER_AGENT_WORKSPACE) {
    const ws = defaultAgentWorkspace(packageRoot);
    if (existsSync(ws)) {
      env.EGO_BROWSER_AGENT_WORKSPACE = ws;
      process.env.EGO_BROWSER_AGENT_WORKSPACE = ws;
    }
  }

  const config = await loadConfig(env);
  const ensure = opts.ensureHost ?? ensureHost;

  if (flags.doctor) {
    await ensure(config, { env, packageRoot });
    let harnessPath: string | null = null;
    try {
      harnessPath = resolveHarnessPath(env, packageRoot, opts.harnessPath);
    } catch {
      harnessPath = null;
    }
    const conn = await connectHost(config.hostSocket);
    try {
      const doctor = (await conn.request("doctor")) as Record<string, unknown>;
      writeStream(
        stdout,
        JSON.stringify({ ...doctor, harnessPath }, null, 2) + "\n",
      );
      return 0;
    } finally {
      conn.close();
    }
  }

  if (flags.reload) {
    await ensure(config, { env, packageRoot });
    const conn = await connectHost(config.hostSocket);
    try {
      await conn.request("reload");
      writeStream(stdout, "browser connection reset on next call\n");
      return 0;
    } finally {
      conn.close();
    }
  }

  await ensure(config, { env, packageRoot });
  const conn = await connectHost(config.hostSocket);
  installEgoClient(conn);

  let harnessPath: string;
  try {
    harnessPath = resolveHarnessPath(env, packageRoot, opts.harnessPath);
  } catch (err) {
    conn.close();
    writeStream(
      stderr,
      (err instanceof Error ? err.message : String(err)) + "\n",
    );
    return 1;
  }

  try {
    const mod = await import(pathToFileURL(harnessPath).href);
    const runMain = mod.runMain;
    if (typeof runMain !== "function") {
      writeStream(
        stderr,
        `harness at ${harnessPath} does not export runMain\n`,
      );
      return 1;
    }
    const code = await runMain({
      argv: flags.remaining,
      stdin,
      stdout,
      stderr,
      env,
    });
    return typeof code === "number" ? code : 0;
  } finally {
    conn.close();
  }
}
