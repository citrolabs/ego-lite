#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import {
  GPU_MODES,
  detectMode,
  unsupportedModesForAppVersion,
} from "./mode-state.mjs";
import {
  startWatchdog,
  watchdogIsRunning,
} from "./low-power-watchdog.mjs";
import { acquireRestartLock } from "./restart-lock.mjs";

const MAX_NATIVE_MESSAGE_BYTES = 64 * 1024;
const hostDirectory = dirname(fileURLToPath(import.meta.url));
const userDataDirectory =
  process.env.EGO_LITE_USER_DATA_DIR ||
  join(homedir(), "Library", "Application Support", "Citro Labs", "ego lite");
const appPath = process.env.EGO_LITE_APP_PATH || "/Applications/ego lite.app";
const localStatePath = join(userDataDirectory, "Local State");
const controllerStatePath = join(userDataDirectory, "gpu_mode.json");
const restartLockPath = join(userDataDirectory, "gpu_mode_restart.lock");
const applyScriptPath = join(hostDirectory, "apply-and-restart.mjs");
const plutilPath = process.env.EGO_LITE_PLUTIL_PATH || "/usr/bin/plutil";

let input = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  void consumeMessages();
});

process.stdin.on("error", (error) => {
  send({ ok: false, error: error.message });
});

async function consumeMessages() {
  while (input.length >= 4) {
    const length = input.readUInt32LE(0);
    if (length > MAX_NATIVE_MESSAGE_BYTES) {
      input = Buffer.alloc(0);
      send({
        ok: false,
        error: `native message exceeds ${MAX_NATIVE_MESSAGE_BYTES} bytes`,
      });
      process.stdin.destroy();
      return;
    }
    if (input.length < length + 4) {
      return;
    }
    const payload = input.subarray(4, length + 4);
    input = input.subarray(length + 4);
    try {
      const message = JSON.parse(payload.toString("utf8"));
      send(await handleMessage(message));
    } catch (error) {
      send({ ok: false, error: error.message });
    }
  }
}

async function handleMessage(message) {
  switch (message?.action) {
    case "status":
      return await status();
    case "setMode":
      return await setMode(message.mode);
    case "ensureMode":
      return await ensureMode();
    default:
      throw new Error(`unsupported action: ${JSON.stringify(message?.action)}`);
  }
}

async function status() {
  const [localState, controllerState, appVersion] = await Promise.all([
    readJson(localStatePath),
    readJson(controllerStatePath),
    readAppVersion(),
  ]);
  const mode = detectMode(localState, controllerState?.mode);
  const unsupportedModes = unsupportedModesForAppVersion(appVersion);
  return {
    ok: true,
    mode,
    active:
      !unsupportedModes.includes(mode) &&
      (mode !== "low-power" || (await watchdogIsRunning())),
    unsupportedModes,
  };
}

async function setMode(mode) {
  if (!GPU_MODES.includes(mode)) {
    throw new Error(`unsupported GPU mode: ${JSON.stringify(mode)}`);
  }
  const unsupportedModes = unsupportedModesForAppVersion(
    await readAppVersion(),
  );
  if (unsupportedModes.includes(mode)) {
    throw new Error(
      `GPU mode ${JSON.stringify(mode)} is disabled for this ego lite version because it causes the browser to exit`,
    );
  }
  const scheduled = await scheduleRestart(mode);
  return { ok: true, mode, restarting: true, scheduled };
}

async function ensureMode() {
  const current = await status();
  if (current.mode !== "low-power" || current.active) {
    return { ...current, restarting: false };
  }
  if (!(await browserHasSwitch("disable-webgl"))) {
    const started = await startWatchdog();
    return {
      ...current,
      active: await watchdogIsRunning(),
      restarting: false,
      started,
    };
  }
  const scheduled = await scheduleRestart(current.mode);
  return { ...current, restarting: true, scheduled };
}

async function scheduleRestart(mode) {
  if (!(await acquireRestartLock(restartLockPath))) {
    return false;
  }
  const child = spawn(process.execPath, [applyScriptPath, mode], {
    detached: true,
    env: process.env,
    stdio: "ignore",
  });
  child.unref();
  return true;
}

async function browserHasSwitch(name) {
  const commandLines = await execFileText("ps", ["-axo", "command="]);
  const executable = join(appPath, "Contents", "MacOS", "ego lite");
  return commandLines
    .split(/\r?\n/)
    .some(
      (line) =>
        line.trimStart().startsWith(executable) &&
        !line.includes("--user-data-dir=") &&
        line.includes(`--${name}`),
    );
}

async function readAppVersion() {
  if (process.env.EGO_LITE_APP_VERSION) {
    return process.env.EGO_LITE_APP_VERSION;
  }
  try {
    return (
      await execFileText(plutilPath, [
        "-extract",
        "CFBundleShortVersionString",
        "raw",
        join(appPath, "Contents", "Info.plist"),
      ])
    ).trim();
  } catch {
    return "";
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return {};
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

function send(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  process.stdout.write(Buffer.concat([header, payload]));
}
