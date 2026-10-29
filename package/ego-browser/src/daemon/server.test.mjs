import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { daemonStatus, request } from "../../dist/src/daemon/client.js";
import { daemonPaths } from "../../dist/src/daemon/paths.js";
import { RESULT_MARKER } from "../../dist/src/daemon/program.js";
import { PROTOCOL_VERSION } from "../../dist/src/daemon/protocol.js";
import { ReplConnection } from "../../dist/src/daemon/repl-connection.js";
import { Daemon } from "../../dist/src/daemon/server.js";

function fakeConnect() {
  return async () => {
    const data = [];
    const exit = [];
    const transport = {
      pid: 4242,
      write(input) {
        const id = /@@EGO-RUN:([^:"]+):/.exec(input)?.[1];
        if (!id) return;
        const value = /return \(([^)]*)\)/.exec(input)?.[1] ?? null;
        setTimeout(() => {
          for (const l of data)
            l(
              `${RESULT_MARKER}${id}:${JSON.stringify({ ok: true, value, logs: "log line\n", ms: 2 })}\nrepl> `,
            );
        }, 2);
      },
      kill() {
        for (const l of exit) l({ exitCode: 137 });
      },
      onData: (l) => data.push(l),
      onExit: (l) => exit.push(l),
    };
    setTimeout(
      () => data.forEach((l) => l("ego-browser nodejs REPL.\r\nrepl> ")),
      1,
    );
    return new ReplConnection(transport);
  };
}

async function startDaemon() {
  const stateDir = mkdtempSync(join(tmpdir(), "ego-run-test-"));
  // Keep the socket path short: macOS limits it to 104 bytes.
  const paths = daemonPaths({ EGO_RUN_STATE_DIR: stateDir });
  const daemon = new Daemon({
    paths,
    bin: "ego-browser",
    watchVersion: false,
    sessions: { connect: fakeConnect() },
  });
  await daemon.start();
  return { daemon, paths, stateDir };
}

test("exec round-trips through the socket with token and protocol checks", async (t) => {
  const { daemon, paths, stateDir } = await startDaemon();
  t.after(async () => {
    await daemon.stop();
    rmSync(stateDir, { recursive: true, force: true });
  });
  const status = await daemonStatus(paths);
  assert.equal(status.ok, true);
  assert.equal(status.protocol, PROTOCOL_VERSION);
  assert.equal(status.pid, process.pid);

  const response = await request(paths, {
    cmd: "exec",
    session: "demo",
    program: '"hello"',
  });
  assert.equal(response.ok, true);
  assert.equal(response.value, '"hello"');
  assert.equal(response.logs, "log line\n");
  assert.equal(response.session.fresh, true);
  assert.equal(response.session.pid, 4242);
  assert.match(response.id, /^req-\d+-\d+$/);

  const list = await request(paths, { cmd: "session.list" });
  assert.equal(list.sessions.length, 1);
  assert.equal(list.sessions[0].session, "demo");

  const token = readFileSync(paths.tokenFile, "utf8").trim();
  assert.ok(token.length >= 32);
  const net = await import("node:net");
  const rawReply = (body) =>
    new Promise((resolve) => {
      const socket = net.connect(paths.endpoint);
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(`${JSON.stringify(body)}\n`));
      socket.on("data", (chunk) => {
        buffer += chunk;
      });
      socket.on("end", () => resolve(JSON.parse(buffer)));
    });
  const badToken = await rawReply({
    v: PROTOCOL_VERSION,
    token: "nope",
    cmd: "status",
  });
  assert.equal(badToken.error.code, "EGO_RUN_UNAUTHORIZED");
  const badVersion = await rawReply({
    v: PROTOCOL_VERSION + 1,
    token,
    cmd: "status",
  });
  assert.equal(badVersion.error.code, "EGO_RUN_VERSION_MISMATCH");
  const garbage = await rawReply("not an object");
  assert.equal(garbage.error.code, "EGO_RUN_BAD_REQUEST");

  const closed = await request(paths, {
    cmd: "session.close",
    session: "demo",
  });
  assert.equal(closed.closed, 1);
  assert.equal(
    (await request(paths, { cmd: "session.list" })).sessions.length,
    0,
  );
});

test("a daemon refuses to start while another live process holds the lock", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ego-run-test-"));
  const paths = daemonPaths({ EGO_RUN_STATE_DIR: stateDir });
  // The test runner's parent is alive and is not this process.
  writeFileSync(paths.lockFile, `${process.ppid}\n`);
  const daemon = new Daemon({
    paths,
    bin: "ego-browser",
    watchVersion: false,
    sessions: { connect: fakeConnect() },
  });
  await assert.rejects(daemon.start(), /already running \(pid \d+\)/);
  // A stale lock from a dead process is taken over.
  writeFileSync(paths.lockFile, "999999999\n");
  await daemon.start();
  await daemon.stop();
  rmSync(stateDir, { recursive: true, force: true });
});

test("a live socket is not unlinked when the lock file is missing", async (t) => {
  if (process.platform === "win32")
    return t.skip("named pipes cannot be stale");
  const stateDir = mkdtempSync(join(tmpdir(), "ego-run-test-"));
  const paths = daemonPaths({ EGO_RUN_STATE_DIR: stateDir });
  const options = {
    paths,
    bin: "ego-browser",
    watchVersion: false,
    sessions: { connect: fakeConnect() },
  };
  const live = new Daemon(options);
  await live.start();
  rmSync(paths.lockFile); // a lost lock must not make the socket look stale
  const second = new Daemon(options);
  await assert.rejects(second.start(), /already listening/);
  assert.equal(
    existsSync(paths.lockFile),
    false,
    "the refused daemon left the lock file as it found it",
  );
  // The live daemon still answers on its socket.
  assert.equal((await request(paths, { cmd: "status" })).pid, process.pid);
  await live.stop();
  rmSync(stateDir, { recursive: true, force: true });
});

test("the client reports a missing daemon as DAEMON_UNAVAILABLE", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ego-run-test-"));
  const paths = daemonPaths({ EGO_RUN_STATE_DIR: stateDir });
  await assert.rejects(
    request(paths, { cmd: "status" }),
    (error) => error.code === "EGO_RUN_DAEMON_UNAVAILABLE",
  );
  assert.equal(await daemonStatus(paths), null);
  rmSync(stateDir, { recursive: true, force: true });
});
