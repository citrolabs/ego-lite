import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin", "ego-browser.mjs");

// Its own profile and state dir, so `npm test` never stops the browser an agent
// session is currently driving.
const SANDBOX = await mkdtemp(join(tmpdir(), "ego-exit-test-"));
const TEST_ENV = {
  XDG_STATE_HOME: join(SANDBOX, "state"),
  EGO_LINUX_PROFILE: join(SANDBOX, "profile"),
};
const PREFERENCES = join(SANDBOX, "profile", "Default", "Preferences");
const BROWSER_STATE = join(SANDBOX, "state", "ego-lite-linux", "browser.json");

function runCli(args, { stdin = null, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, ...TEST_ENV },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out after ${timeout}ms\n${stdout}\n${stderr}`));
    }, timeout);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`exit ${code}\n${stdout}\n${stderr}`));
      else resolve(stdout);
    });
    if (stdin === null) child.stdin.end();
    else child.stdin.end(stdin);
  });
}

/**
 * Chrome stamps exit_type "Crashed" while it runs and rewrites it to "Normal"
 * only on a graceful exit, so this is the same signal that decides whether the
 * next launch greets the user with "Restore pages?".
 */
async function readExitType() {
  try {
    return JSON.parse(await readFile(PREFERENCES, "utf8")).profile?.exit_type ?? null;
  } catch {
    return null;
  }
}

async function waitForExitType(want, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let seen = null;
  while (Date.now() < deadline) {
    seen = await readExitType();
    if (seen === want) return seen;
    await new Promise((r) => setTimeout(r, 200));
  }
  return seen;
}

after(async () => {
  try {
    const state = JSON.parse(await readFile(BROWSER_STATE, "utf8"));
    if (state.pid) process.kill(state.pid, "SIGTERM");
  } catch {
    // nothing running
  }
  await new Promise((r) => setTimeout(r, 1000));
  await rm(SANDBOX, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
});

describe("stopping the backing browser", () => {
  it("exits cleanly, so the next launch offers no crash restore", async () => {
    await runCli(["--headless"], { stdin: 'console.log("tabs=" + (await browser.listTabs()).length)' });
    // Chrome writes Preferences a beat after start, so this is the precondition
    // the real assertion below depends on, not a race of its own.
    assert.equal(
      await waitForExitType("Crashed", 20000),
      "Crashed",
      "Chrome marks a running profile as Crashed",
    );

    await runCli(["--stop"]);

    assert.equal(
      await waitForExitType("Normal"),
      "Normal",
      "a SIGTERMed Chrome leaves exit_type Crashed, which is what triggers the Restore pages bubble",
    );
  });
});
