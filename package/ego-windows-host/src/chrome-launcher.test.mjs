import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { browserEndpoint, ensureBrowser } from "../dist/src/chrome-launcher.js";

const ENDPOINT = {
  webSocketDebuggerUrl: "ws://127.0.0.1:9522/devtools/browser/abc",
  Browser: "Edg/126.0",
};

function fetchAlive() {
  return async () => ({ ok: true, json: async () => ENDPOINT });
}

function fetchDead() {
  return async () => {
    throw new Error("ECONNREFUSED");
  };
}

function fakeSpawn(record) {
  return (command, args, options) => {
    record.command = command;
    record.args = args;
    record.options = options;
    record.calls = (record.calls || 0) + 1;
    return { unref() {} };
  };
}

test("browserEndpoint returns the version info when CDP answers", async () => {
  const info = await browserEndpoint(9522, fetchAlive());
  assert.equal(info.webSocketDebuggerUrl, ENDPOINT.webSocketDebuggerUrl);
});

test("browserEndpoint returns null when nothing listens", async () => {
  assert.equal(await browserEndpoint(9522, fetchDead()), null);
});

test("browserEndpoint returns null when something else listens", async () => {
  const info = await browserEndpoint(9522, async () => ({
    ok: true,
    json: async () => ({ hello: "not cdp" }),
  }));
  assert.equal(info, null);
});

test("ensureBrowser reuses a running browser without spawning", async () => {
  const record = {};
  const result = await ensureBrowser({
    port: 9522,
    userDataDir: join(tmpdir(), "unused"),
    browserPath: () => {
      throw new Error("must not locate a browser when one is running");
    },
    spawnFn: fakeSpawn(record),
    fetchFn: fetchAlive(),
  });
  assert.equal(result.launched, false);
  assert.equal(record.calls, undefined);
});

test("ensureBrowser launches detached with the CDP and profile flags", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ego-host-launch-"));
  try {
    const userDataDir = join(dir, "profile");
    const record = {};
    let alive = false;
    const result = await ensureBrowser({
      port: 9522,
      userDataDir,
      browserPath: () => "C:\\fake\\msedge.exe",
      spawnFn: (command, args, options) => {
        const child = fakeSpawn(record)(command, args, options);
        alive = true;
        return child;
      },
      fetchFn: async (url) => {
        if (!alive) throw new Error("ECONNREFUSED");
        return { ok: true, json: async () => ENDPOINT };
      },
      sleep: async () => {},
    });
    assert.equal(result.launched, true);
    assert.equal(record.command, "C:\\fake\\msedge.exe");
    assert.ok(record.args.includes("--remote-debugging-port=9522"));
    assert.ok(record.args.includes(`--user-data-dir=${userDataDir}`));
    assert.ok(record.args.includes("--no-first-run"));
    assert.equal(record.options.detached, true);
    assert.ok(existsSync(userDataDir), "creates the profile directory");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureBrowser reports a launch that never becomes ready", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ego-host-launch-"));
  try {
    await assert.rejects(
      ensureBrowser({
        port: 9522,
        userDataDir: join(dir, "profile"),
        browserPath: () => "C:\\fake\\msedge.exe",
        spawnFn: fakeSpawn({}),
        fetchFn: fetchDead(),
        sleep: async () => {},
        timeoutMs: 50,
      }),
      /did not expose CDP on port 9522/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
