import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same isolation the other suites use: point the module's paths at a sandbox
// before importing it, so this never reaps a browser a real session is driving.
const SANDBOX = await mkdtemp(join(tmpdir(), "ego-reap-test-"));
process.env.XDG_STATE_HOME = join(SANDBOX, "state");
process.env.EGO_LINUX_PROFILE = join(SANDBOX, "profile");

// Imported after that assignment on purpose: paths.mjs resolves its directories
// at import time.
const { reapOrphanedBrowsers } = await import("../src/chrome.mjs");

// A stand-in for Chrome: it only has to sit still and carry the argv the reaper
// reads back out of /proc. Spawning the real browser would make the outcome
// depend on a working Chrome install.
const STANDIN = join(SANDBOX, "standin.mjs");

const spawned = [];

/** Spawn a stand-in carrying `args`, and wait until /proc has its cmdline. */
async function standIn(...args) {
  const child = spawn(process.execPath, [STANDIN, ...args], { stdio: "ignore" });
  spawned.push(child);
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return child;
}

function alive(child) {
  try {
    process.kill(child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Settle for `ms` so a delivered SIGTERM has actually landed. */
const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  await mkdir(SANDBOX, { recursive: true });
  await writeFile(STANDIN, "setTimeout(() => {}, 60_000);\n");
});

after(async () => {
  for (const child of spawned) child.kill("SIGKILL");
  await rm(SANDBOX, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(
    () => {},
  );
});

describe("reapOrphanedBrowsers", () => {
  it("terminates an ego browser whose profile directory is gone", async () => {
    const gone = join(SANDBOX, "deleted-profile");

    // The reaper is machine-global: it signals any browser carrying our class
    // whose profile is gone, whoever started it. The suites run in parallel and
    // several of them launch a browser, which runs this same reaper — and to it
    // our stand-in is a textbook orphan, so it can be signalled out from under
    // this test between the spawn and the measurement. That is the reaper
    // working, not failing, and it left nothing for ours to count.
    //
    // Re-arm and measure again rather than serialise the whole suite for it
    // (`--test-concurrency=1` costs ~17s a run). A stand-in that is still alive
    // and still unsignalled is a real failure and asserts on the spot, so this
    // can never turn a broken reaper green.
    for (let attempt = 0; ; attempt += 1) {
      const orphan = await standIn("--class=ego-lite-linux", `--user-data-dir=${gone}`);

      const reaped = await reapOrphanedBrowsers();
      await settle();

      if (reaped === 0 && !alive(orphan) && attempt < 5) continue; // stolen; retry

      assert.equal(reaped, 1, "exactly the one orphan is signalled");
      assert.equal(alive(orphan), false, "the orphan is gone");
      return;
    }
  });

  it("leaves a browser whose profile directory still exists", async () => {
    const live = join(SANDBOX, "live-profile");
    await mkdir(live, { recursive: true });
    const browser = await standIn("--class=ego-lite-linux", `--user-data-dir=${live}`);

    const reaped = await reapOrphanedBrowsers();
    await settle();

    assert.equal(reaped, 0, "a reachable profile is not an orphan");
    assert.equal(alive(browser), true, "the browser survives");
  });

  it("ignores renderers and non-ego processes with a missing profile", async () => {
    const gone = join(SANDBOX, "also-deleted");
    // Renderers inherit --user-data-dir; killing the browser takes them along,
    // so signalling them individually would race that teardown.
    const renderer = await standIn(
      "--class=ego-lite-linux",
      "--type=renderer",
      `--user-data-dir=${gone}`,
    );
    // Some other Chrome on this machine is not ours to touch.
    const foreign = await standIn(`--user-data-dir=${gone}`);

    const reaped = await reapOrphanedBrowsers();
    await settle();

    assert.equal(reaped, 0, "neither is a reap candidate");
    assert.equal(alive(renderer), true, "the renderer survives");
    assert.equal(alive(foreign), true, "the foreign browser survives");
  });
});
