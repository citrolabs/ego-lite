#!/usr/bin/env node

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import {
  applyModeToLocalState,
  assertGpuMode,
  launchArguments,
} from "./mode-state.mjs";

const mode = assertGpuMode(process.argv[2]);
const appPath = process.env.EGO_LITE_APP_PATH || "/Applications/ego lite.app";
const openPath = process.env.EGO_LITE_OPEN_PATH || "/usr/bin/open";
const osascriptPath =
  process.env.EGO_LITE_OSASCRIPT_PATH || "/usr/bin/osascript";
const pgrepPath = process.env.EGO_LITE_PGREP_PATH || "/usr/bin/pgrep";
const pkillPath = process.env.EGO_LITE_PKILL_PATH || "/usr/bin/pkill";
const userDataDirectory =
  process.env.EGO_LITE_USER_DATA_DIR ||
  join(homedir(), "Library", "Application Support", "Citro Labs", "ego lite");
const localStatePath = join(userDataDirectory, "Local State");
const controllerStatePath = join(userDataDirectory, "gpu_mode.json");
const restartLockPath = join(userDataDirectory, "gpu_mode_restart.lock");
const errorPath = join(userDataDirectory, "gpu_mode_error.log");
let browserLaunched = false;

try {
  await delay(350);
  await quitBrowser();
  await waitForBrowserExit();
  await updateLocalState();
  await writeFile(
    controllerStatePath,
    `${JSON.stringify({ mode, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await launchBrowser();
  browserLaunched = true;
  await unlinkIfPresent(errorPath);
} catch (error) {
  await writeFile(
    errorPath,
    `${new Date().toISOString()} ${error.stack || error.message}\n`,
    { mode: 0o600 },
  );
  if (!browserLaunched) {
    try {
      await launchBrowser();
      browserLaunched = true;
    } catch {}
  }
} finally {
  await unlinkIfPresent(restartLockPath);
}

async function quitBrowser() {
  try {
    await execFilePromise(
      osascriptPath,
      ["-e", 'tell application id "com.citrolabs.ego.lite" to quit'],
      { timeout: 3_000 },
    );
  } catch {}
  await delay(1_000);
  if (await browserIsRunning()) {
    try {
      await execFilePromise(pkillPath, ["-TERM", "-x", "ego lite"]);
    } catch {}
  }
}

async function waitForBrowserExit() {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (!(await browserIsRunning())) {
      return;
    }
    await delay(200);
  }
  throw new Error("ego lite did not exit within 16 seconds");
}

async function browserIsRunning() {
  try {
    await execFilePromise(pgrepPath, ["-x", "ego lite"]);
    return true;
  } catch {
    return false;
  }
}

async function updateLocalState() {
  const current = await readLocalState();
  const next = applyModeToLocalState(current, mode);
  const temporaryPath = join(
    dirname(localStatePath),
    `.Local State.gpu-mode-${process.pid}`,
  );
  await writeFile(temporaryPath, JSON.stringify(next), { mode: 0o600 });
  await rename(temporaryPath, localStatePath);
}

async function launchBrowser() {
  const args = ["-na", appPath];
  const graphicsArguments = launchArguments(mode);
  if (graphicsArguments.length > 0) {
    args.push("--args", ...graphicsArguments);
  }
  await execFilePromise(openPath, args);
}

async function readLocalState() {
  const value = JSON.parse(await readFile(localStatePath, "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ego lite Local State is not a JSON object");
  }
  return value;
}

function execFilePromise(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error) => {
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
