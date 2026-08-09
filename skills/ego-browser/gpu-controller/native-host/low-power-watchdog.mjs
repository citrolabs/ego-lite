#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  access,
  open,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";

const scriptPath = fileURLToPath(import.meta.url);
const userDataDirectory =
  process.env.EGO_LITE_USER_DATA_DIR ||
  join(homedir(), "Library", "Application Support", "Citro Labs", "ego lite");
const pidPath =
  process.env.EGO_LITE_WATCHDOG_PID_PATH ||
  join(userDataDirectory, "gpu_mode_low_power.pid");
const errorPath =
  process.env.EGO_LITE_WATCHDOG_ERROR_PATH ||
  join(userDataDirectory, "gpu_mode_watchdog_error.log");
const startLockPath =
  process.env.EGO_LITE_WATCHDOG_START_LOCK_PATH ||
  join(userDataDirectory, "gpu_mode_watchdog_start.lock");
const restartLockPath =
  process.env.EGO_LITE_RESTART_LOCK_PATH ||
  join(userDataDirectory, "gpu_mode_restart.lock");
const osascriptPath =
  process.env.EGO_LITE_OSASCRIPT_PATH || "/usr/bin/osascript";
const pollMilliseconds = positiveInteger(
  process.env.EGO_LITE_WATCHDOG_POLL_MS,
  1_000,
);
const unfocusedMilliseconds = positiveInteger(
  process.env.EGO_LITE_WATCHDOG_UNFOCUSED_MS,
  1_500,
);

export async function startWatchdog() {
  const lock = await acquireStartLock();
  if (lock === null) {
    return false;
  }
  try {
    if (await watchdogIsRunning()) {
      return false;
    }
    await unlinkIfPresent(pidPath);
    const child = spawn(process.execPath, [scriptPath, "run"], {
      detached: true,
      env: process.env,
      stdio: "ignore",
    });
    try {
      await writeFile(pidPath, `${child.pid}\n`, { mode: 0o600 });
    } catch (error) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {}
      throw error;
    }
    child.unref();
    return true;
  } finally {
    await lock.close();
    await unlinkIfPresent(startLockPath);
  }
}

export async function stopWatchdog() {
  const pid = await readWatchdogPid();
  if (pid !== null && (await processIsWatchdog(pid))) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  await unlinkIfPresent(pidPath);
  return pid !== null;
}

export async function watchdogIsRunning() {
  const pid = await readWatchdogPid();
  return pid !== null && (await processIsWatchdog(pid));
}

async function runWatchdog() {
  let stopped = false;
  let unfocusedSince = null;
  let errorDelayMilliseconds = pollMilliseconds;
  const stop = () => {
    stopped = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    while (!stopped) {
      if (await fileExists(restartLockPath)) {
        unfocusedSince = null;
        await delay(pollMilliseconds);
        continue;
      }
      try {
        const state = await readEgoState();
        if (!state.running) {
          return;
        }
        if (!state.visible || state.frontmost) {
          unfocusedSince = null;
        } else if (unfocusedSince === null) {
          unfocusedSince = Date.now();
        } else if (Date.now() - unfocusedSince >= unfocusedMilliseconds) {
          await hideEgo();
          unfocusedSince = null;
        }
        await unlinkIfPresent(errorPath);
        errorDelayMilliseconds = pollMilliseconds;
      } catch (error) {
        await writeFile(
          errorPath,
          `${new Date().toISOString()} ${error.stack || error.message}\n`,
          { mode: 0o600 },
        );
        await delay(errorDelayMilliseconds);
        errorDelayMilliseconds = Math.min(
          errorDelayMilliseconds * 2,
          30_000,
        );
        continue;
      }
      await delay(pollMilliseconds);
    }
  } finally {
    const pid = await readWatchdogPid();
    if (pid === process.pid) {
      await unlinkIfPresent(pidPath);
    }
  }
}

async function acquireStartLock() {
  const now = Date.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await open(startLockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }

    try {
      const info = await stat(startLockPath);
      if (now - info.mtimeMs < 10_000) {
        return null;
      }
      await unlink(startLockPath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return null;
}

async function readEgoState() {
  const output = await execFileText(osascriptPath, [
    "-e",
    'tell application "System Events"',
    "-e",
    'if not (exists process "ego lite") then return "stopped"',
    "-e",
    'set egoVisible to visible of process "ego lite"',
    "-e",
    'set egoFrontmost to frontmost of process "ego lite"',
    "-e",
    'return "running|" & egoVisible & "|" & egoFrontmost',
    "-e",
    "end tell",
  ]);
  const [status, visible, frontmost] = output.trim().split("|");
  return {
    running: status === "running",
    visible: visible === "true",
    frontmost: frontmost === "true",
  };
}

async function hideEgo() {
  await execFilePromise(osascriptPath, [
    "-e",
    'tell application "System Events"',
    "-e",
    'if exists process "ego lite" then',
    "-e",
    'if not frontmost of process "ego lite" then set visible of process "ego lite" to false',
    "-e",
    "end if",
    "-e",
    "end tell",
  ]);
}

async function readWatchdogPid() {
  try {
    const pid = Number.parseInt((await readFile(pidPath, "utf8")).trim(), 10);
    return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}

async function processIsWatchdog(pid) {
  try {
    const command = await execFileText("ps", [
      "-p",
      String(pid),
      "-o",
      "command=",
    ]);
    return command.includes(scriptPath) && /\brun\b/.test(command);
  } catch {
    return false;
  }
}

function execFileText(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function execFilePromise(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function unlinkIfPresent(path) {
  try {
    await unlink(path);
  } catch {}
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  switch (process.argv[2]) {
    case "start":
      await startWatchdog();
      break;
    case "stop":
      await stopWatchdog();
      break;
    case "status":
      process.stdout.write(
        (await watchdogIsRunning()) ? "running\n" : "stopped\n",
      );
      break;
    case "run":
      await runWatchdog();
      break;
    default:
      process.stderr.write(
        "usage: low-power-watchdog.mjs [start|stop|status|run]\n",
      );
      process.exitCode = 2;
  }
}

if (process.argv[1] === scriptPath) {
  await main();
}
