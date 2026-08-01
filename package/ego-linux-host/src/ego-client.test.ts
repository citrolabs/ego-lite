import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  connectHost,
  installEgoClient,
  pingSocket,
  type HostConnection,
} from "./ego-client.js";
import { startDaemon } from "./host-daemon.js";
import { acquireHostLock } from "./host-control.js";
import type { HostConfig } from "./config.js";
import {
  stripNodejsSubcommand,
  resolveHarnessPath,
  parseCliFlags,
  CLI_HELP,
  unlinkStaleSocket,
  ensureHost,
} from "./cli.js";

function mockConn(handler?: {
  request?: (method: string, params?: any) => Promise<any>;
  events?: Array<(event: string, params?: any) => void>;
}): HostConnection & { emit: (event: string, params?: any) => void; calls: any[] } {
  const calls: any[] = [];
  const listeners = new Set<(event: string, params?: any) => void>();
  return {
    calls,
    async request(method, params) {
      calls.push([method, params]);
      if (handler?.request) return handler.request(method, params);
      if (method === "ego.listTabs") return { tabs: [] };
      return {};
    },
    onEvent(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    close() {},
    emit(event, params) {
      for (const fn of listeners) fn(event, params);
    },
  };
}

test("installEgoClient listTabs proxies to RPC", async () => {
  const conn = mockConn();
  installEgoClient(conn);
  const result = await (globalThis as any).ego.listTabs();
  assert.deepEqual(result, { tabs: [] });
  assert.deepEqual(conn.calls[0][0], "ego.listTabs");
});

test("installEgoClient maps createTab(url) and createTaskSpace(name)", async () => {
  const conn = mockConn({
    async request(method, params) {
      if (method === "ego.createTab") return { targetId: "t1" };
      if (method === "ego.createTaskSpace") return { id: 2, name: params?.name };
      return {};
    },
  });
  installEgoClient(conn);
  const ego = (globalThis as any).ego;
  assert.deepEqual(await ego.createTab("https://example.com"), {
    targetId: "t1",
  });
  assert.deepEqual(conn.calls[0], [
    "ego.createTab",
    { url: "https://example.com" },
  ]);
  await ego.createTaskSpace("agent-job");
  assert.deepEqual(conn.calls[1], [
    "ego.createTaskSpace",
    { name: "agent-job" },
  ]);
});

test("installEgoClient maps useTaskSpace and claimTaskSpace args", async () => {
  const conn = mockConn({
    async request(method, params) {
      return { method, params };
    },
  });
  installEgoClient(conn);
  const ego = (globalThis as any).ego;
  await ego.useTaskSpace(3);
  assert.deepEqual(conn.calls[0], ["ego.useTaskSpace", { id: 3 }]);
  await ego.claimTaskSpace(4, "mine");
  assert.deepEqual(conn.calls[1], [
    "ego.claimTaskSpace",
    { id: 4, name: "mine" },
  ]);
});

test("installEgoClient sendCDPMessage proxies payload; events wire callbacks", async () => {
  const conn = mockConn({
    async request(method, params) {
      if (method === "ego.sendCDPMessage") return { ok: true, params };
      return {};
    },
  });
  installEgoClient(conn);
  const ego = (globalThis as any).ego;
  const messages: string[] = [];
  const errors: any[] = [];
  ego.onCDPMessage = (payload: string) => messages.push(payload);
  ego.onSendCDPMessageError = (message: string, code?: string) =>
    errors.push([message, code]);

  await ego.sendCDPMessage('{"id":1,"method":"Page.enable"}');
  assert.equal(conn.calls[0][0], "ego.sendCDPMessage");
  assert.deepEqual(conn.calls[0][1], {
    payload: '{"id":1,"method":"Page.enable"}',
  });

  conn.emit("cdp.message", { payload: '{"id":1,"result":{}}' });
  assert.deepEqual(messages, ['{"id":1,"result":{}}']);

  conn.emit("cdp.sendError", {
    message: "user control",
    error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
  });
  assert.deepEqual(errors, [
    ["user control", "EGO_TASK_SPACE_USER_IN_CONTROL"],
  ]);
});

test("installEgoClient exposes no-op optional APIs", async () => {
  const conn = mockConn();
  installEgoClient(conn);
  const ego = (globalThis as any).ego;
  assert.equal(typeof ego.animationHighlightMouseToPosition, "function");
  assert.equal(typeof ego.setAgentTaskState, "function");
  await ego.animationHighlightMouseToPosition(1, 2);
  await ego.setAgentTaskState("working");
});

test("installEgoClient snapshot and space lifecycle methods", async () => {
  const conn = mockConn({
    async request(method, params) {
      return { method, params };
    },
  });
  installEgoClient(conn);
  const ego = (globalThis as any).ego;
  await ego.snapshot({ maxResultLength: 1 });
  await ego.listTaskSpaces();
  await ego.completeTaskSpace();
  await ego.closeTaskSpace();
  await ego.handOffTaskSpace();
  await ego.takeOverTaskSpace();
  assert.deepEqual(
    conn.calls.map((c) => c[0]),
    [
      "ego.snapshot",
      "ego.listTaskSpaces",
      "ego.completeTaskSpace",
      "ego.closeTaskSpace",
      "ego.handOffTaskSpace",
      "ego.takeOverTaskSpace",
    ],
  );
  assert.deepEqual(conn.calls[0][1], { maxResultLength: 1 });
});

test("stripNodejsSubcommand strips leading nodejs only", () => {
  assert.deepEqual(stripNodejsSubcommand(["nodejs"]), []);
  assert.deepEqual(stripNodejsSubcommand(["nodejs", "--doctor"]), ["--doctor"]);
  assert.deepEqual(stripNodejsSubcommand(["--help"]), ["--help"]);
  assert.deepEqual(stripNodejsSubcommand([]), []);
});

test("parseCliFlags detects help/doctor/reload", () => {
  assert.deepEqual(parseCliFlags(["--help"]), {
    help: true,
    doctor: false,
    reload: false,
    remaining: [],
  });
  assert.deepEqual(parseCliFlags(["-h"]), {
    help: true,
    doctor: false,
    reload: false,
    remaining: [],
  });
  assert.deepEqual(parseCliFlags(["nodejs", "--doctor"]), {
    help: false,
    doctor: true,
    reload: false,
    remaining: [],
  });
  assert.deepEqual(parseCliFlags(["--reload"]), {
    help: false,
    doctor: false,
    reload: true,
    remaining: [],
  });
  assert.deepEqual(parseCliFlags(["nodejs"]), {
    help: false,
    doctor: false,
    reload: false,
    remaining: [],
  });
});

test("CLI_HELP mentions doctor and reload", () => {
  assert.match(CLI_HELP, /--doctor/);
  assert.match(CLI_HELP, /--reload/);
  assert.match(CLI_HELP, /ego-browser/);
});

test("resolveHarnessPath prefers EGO_HARNESS_PATH", () => {
  const path = resolveHarnessPath(
    { EGO_HARNESS_PATH: "/tmp/custom-harness.js" },
    "/nonexistent-package-root",
  );
  assert.equal(path, "/tmp/custom-harness.js");
});

test("connectHost ping + installEgoClient against daemon", async () => {
  const dir = join(
    tmpdir(),
    `ego-client-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  try {
    const config: HostConfig = {
      chromePath: null,
      userDataDir: join(dir, "profile"),
      cdpPort: 19223,
      headless: true,
      hostSocket: join(dir, "host.sock"),
      dataDir: dir,
      runtimeDir: dir,
      seedFromChrome: false,
      noSandbox: false,
    };
    assert.equal(await pingSocket(config.hostSocket), false);
    const daemon = await startDaemon({
      config,
      skipChrome: true,
      writePid: false,
    });
    try {
      assert.equal(await pingSocket(daemon.socketPath), true);
      const conn = await connectHost(daemon.socketPath);
      try {
        installEgoClient(conn);
        const spaces = await (globalThis as any).ego.listTaskSpaces();
        assert.ok(Array.isArray(spaces.taskSpaces));
        const created = await (globalThis as any).ego.createTaskSpace(
          "cli-client",
        );
        assert.equal(created.name, "cli-client");
      } finally {
        conn.close();
      }
    } finally {
      await daemon.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unlinkStaleSocket removes leftover socket file", async () => {
  const dir = join(
    tmpdir(),
    `ego-stale-sock-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  const sockPath = join(dir, "host.sock");
  try {
    // Leftover path after a dead daemon (plain file is enough for recovery).
    await writeFile(sockPath, "");
    assert.equal(existsSync(sockPath), true);
    assert.equal(await pingSocket(sockPath), false);

    assert.equal(await unlinkStaleSocket(sockPath), true);
    assert.equal(existsSync(sockPath), false);
    assert.equal(await unlinkStaleSocket(sockPath), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureHost unlinks stale socket before failing on missing daemon", async () => {
  const dir = join(
    tmpdir(),
    `ego-ensure-stale-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  const sockPath = join(dir, "host.sock");
  try {
    await writeFile(sockPath, "");
    assert.equal(existsSync(sockPath), true);

    const config: HostConfig = {
      chromePath: null,
      userDataDir: join(dir, "profile"),
      cdpPort: 19224,
      headless: true,
      hostSocket: sockPath,
      dataDir: dir,
      runtimeDir: dir,
      seedFromChrome: false,
      noSandbox: false,
    };

    await assert.rejects(
      () =>
        ensureHost(config, {
          packageRoot: join(dir, "no-such-package"),
          timeoutMs: 200,
        }),
      /daemon entry not found/,
    );
    assert.equal(
      existsSync(sockPath),
      false,
      "stale socket should be unlinked before spawn attempt",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureHost never unlinks a socket owned by a live starting daemon", async () => {
  const dir = join(tmpdir(), `ehl-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const sockPath = join(dir, "host.sock");
  const config: HostConfig = {
    chromePath: null,
    userDataDir: join(dir, "profile"),
    cdpPort: 19226,
    headless: true,
    hostSocket: sockPath,
    dataDir: join(dir, "data"),
    runtimeDir: dir,
    seedFromChrome: false,
    noSandbox: false,
  };
  const lock = await acquireHostLock(config);
  try {
    await writeFile(sockPath, "");
    await assert.rejects(
      () =>
        ensureHost(config, {
          packageRoot: join(dir, "no-such-package"),
          timeoutMs: 30,
          pollMs: 5,
        }),
      /did not become ready/,
    );
    assert.equal(existsSync(sockPath), true);
  } finally {
    await lock.release();
    await rm(dir, { recursive: true, force: true });
  }
});
