import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HostConfig } from "./config.js";
import {
  acquireHostLock,
  inspectHost,
  startManagedDaemon,
  stopHost,
} from "./host-control.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = join(
    tmpdir(),
    `ehc-${process.pid}-${Math.random().toString(16).slice(2, 8)}`,
  );
  await mkdir(dir, { recursive: true });
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function testConfig(dir: string): HostConfig {
  return {
    chromePath: null,
    userDataDir: join(dir, "data", "profile"),
    cdpPort: 19225,
    headless: true,
    hostSocket: join(dir, "run", "host.sock"),
    dataDir: join(dir, "data"),
    runtimeDir: join(dir, "run"),
    seedFromChrome: false,
    noSandbox: false,
  };
}

test("managed daemon exposes consistent run/status/stop state", async () => {
  await withTempDir(async (dir) => {
    const config = testConfig(dir);
    const daemon = await startManagedDaemon({
      config,
      skipChrome: true,
    });
    try {
      const status = await inspectHost(config);
      assert.equal(status.state, "ready");
      assert.equal(status.pid, process.pid);
      assert.equal(status.ownershipVerified, true);
    } finally {
      await daemon.close();
    }

    const stopped = await inspectHost(config);
    assert.equal(stopped.state, "stopped");
    assert.equal((await stopHost(config)).alreadyStopped, true);
    assert.equal((await stopHost(config)).alreadyStopped, true);
  });
});

test("host lock rejects a competing live owner", async () => {
  await withTempDir(async (dir) => {
    const config = testConfig(dir);
    const lock = await acquireHostLock(config);
    try {
      await assert.rejects(
        () => acquireHostLock(config),
        (error: Error & { error_code?: string }) => {
          assert.equal(error.error_code, "EGO_HOST_ALREADY_RUNNING");
          return true;
        },
      );
    } finally {
      await lock.release();
    }
  });
});

test("stop signals only a ready daemon with agreeing ownership records", async () => {
  await withTempDir(async (dir) => {
    const config = testConfig(dir);
    await mkdir(config.runtimeDir, { recursive: true });
    const ownerPid = 4242;
    await writeFile(join(config.runtimeDir, "host.pid"), String(ownerPid));
    await writeFile(
      join(config.runtimeDir, "host.lock"),
      JSON.stringify({
        pid: ownerPid,
        token: "test-owner",
        startedAt: new Date().toISOString(),
      }),
    );

    let ready = true;
    let alive = true;
    let signaled = false;
    const stopped = await stopHost(config, {
      pingSocket: async () => ready,
      isProcessAlive: () => alive,
      signal(pid, value) {
        assert.equal(pid, ownerPid);
        assert.equal(value, "SIGTERM");
        signaled = true;
        ready = false;
        alive = false;
      },
      sleep: async () => {},
      timeoutMs: 2_000,
      pollMs: 10,
    });
    assert.equal(signaled, true);
    assert.equal(stopped.alreadyStopped, false);
    assert.equal(stopped.pid, ownerPid);
    assert.equal((await inspectHost(config)).state, "stopped");
  });
});

test("stop refuses a live PID when the daemon socket is not ready", async () => {
  await withTempDir(async (dir) => {
    const config = testConfig(dir);
    await mkdir(config.runtimeDir, { recursive: true });
    await writeFile(join(config.runtimeDir, "host.pid"), "4242");
    await writeFile(
      join(config.runtimeDir, "host.lock"),
      JSON.stringify({
        pid: 4242,
        token: "stale-owner",
        startedAt: new Date().toISOString(),
      }),
    );

    let signaled = false;
    await assert.rejects(
      () =>
        stopHost(config, {
          pingSocket: async () => false,
          isProcessAlive: () => true,
          signal: () => {
            signaled = true;
          },
        }),
      /not ready|ownership/i,
    );
    assert.equal(signaled, false);
  });
});
