import assert from "node:assert/strict";
import { test } from "node:test";

import { RESULT_MARKER, extractResult } from "../../dist/src/daemon/program.js";
import { ReplConnection } from "../../dist/src/daemon/repl-connection.js";
import { SessionManager } from "../../dist/src/daemon/session-manager.js";

let nextPid = 100;

/**
 * A fake REPL: evaluates the wrapped cell with a tiny interpreter that answers
 * by request id. `behavior` decides what each program does.
 */
function fakeTransport(behavior = {}) {
  const listeners = { data: [], exit: [] };
  const transport = {
    pid: nextPid++,
    killed: false,
    cells: [],
    write(data) {
      const match = /^\.cell\n([\s\S]*)\n\.end\n$/.exec(data);
      if (!match) return;
      const cell = match[1];
      this.cells.push(cell);
      const id = /@@EGO-RUN:([^:"]+):/.exec(cell)[1];
      const program = behavior.program ? behavior.program(cell, id) : null;
      if (program === "hang") return;
      if (program === "exit") {
        setTimeout(() => this.emitExit(1), 5);
        return;
      }
      const envelope = program ?? { ok: true, value: id, logs: "", ms: 1 };
      setTimeout(
        () =>
          this.emit(
            `${RESULT_MARKER}${id}:${JSON.stringify(envelope)}\nrepl> `,
          ),
        5,
      );
    },
    kill() {
      this.killed = true;
      this.emitExit(137);
    },
    onData(listener) {
      listeners.data.push(listener);
    },
    onExit(listener) {
      listeners.exit.push(listener);
    },
    emit(chunk) {
      for (const listener of listeners.data) listener(chunk);
    },
    emitExit(exitCode) {
      for (const listener of listeners.exit) listener({ exitCode });
    },
  };
  setTimeout(
    () =>
      transport.emit("ego-browser nodejs REPL. Type .exit to quit\r\nrepl> "),
    2,
  );
  return transport;
}

function manager(options = {}) {
  const transports = [];
  const connect = async (spawnOptions) => {
    const transport = fakeTransport(options.behavior);
    transport.spawnOptions = spawnOptions;
    transports.push(transport);
    return new ReplConnection(transport);
  };
  const log = [];
  const sessions = new SessionManager({
    bin: "ego-browser",
    spillDir: "/tmp/spill",
    connect,
    log: (line) => log.push(line),
    ...options.manager,
  });
  return { sessions, transports, log };
}

test("programs on one session share a REPL and run in order", async () => {
  const { sessions, transports } = manager();
  const first = sessions.exec(
    { cmd: "exec", session: "order-flow", program: "1" },
    "req-1",
  );
  const second = sessions.exec(
    { cmd: "exec", session: "order-flow", program: "2" },
    "req-2",
  );
  const [a, b] = await Promise.all([first, second]);
  assert.equal(transports.length, 1, "one REPL for the session");
  assert.deepEqual([a.value, b.value], ["req-1", "req-2"]);
  assert.equal(a.session.fresh, true);
  assert.equal(b.session.fresh, false);
  assert.equal(b.session.evaluations, 2);
  assert.ok(b.queueMs >= 0);
  assert.equal(a.persistent, true);
});

test("different sessions get their own REPLs and the sdk path is fixed per session", async () => {
  const { sessions, transports } = manager();
  await sessions.exec({
    cmd: "exec",
    session: "a",
    program: "1",
    sdkPath: "/sdk/index.js",
  });
  await sessions.exec({ cmd: "exec", session: "b", program: "1" });
  assert.equal(transports.length, 2);
  assert.deepEqual(transports[0].spawnOptions.nodejsArgs, [
    "--sdk-path",
    "/sdk/index.js",
  ]);
  assert.deepEqual(transports[1].spawnOptions.nodejsArgs, []);
  await assert.rejects(
    sessions.exec({ cmd: "exec", session: "a", program: "1" }),
    (error) => error.code === "EGO_RUN_SESSION_SDK_MISMATCH",
  );
});

test("a deadline result discards the REPL and the next program gets a fresh context", async () => {
  const { sessions, transports } = manager({
    behavior: {
      program: (cell, id) =>
        id === "req-1"
          ? {
              ok: false,
              error: {
                name: "Error",
                message: "late",
                code: "EGO_RUN_DEADLINE",
              },
              logs: "",
              ms: 60000,
            }
          : null,
    },
  });
  const late = await sessions.exec(
    { cmd: "exec", session: "s", program: "1" },
    "req-1",
  );
  assert.equal(late.ok, false);
  assert.equal(transports[0].killed, true, "the stuck REPL is killed");
  const next = await sessions.exec(
    { cmd: "exec", session: "s", program: "2" },
    "req-2",
  );
  assert.equal(next.ok, true);
  assert.equal(next.session.fresh, true);
  assert.equal(next.session.rebuiltReason, "deadline exceeded");
  assert.equal(transports.length, 2);
  assert.equal(sessions.list()[0].rebuilt, 1);
});

test("a hung REPL is reported and rebuilt on the next call", async () => {
  const { sessions, transports } = manager({
    behavior: { program: (cell, id) => (id === "req-1" ? "hang" : null) },
  });
  await assert.rejects(
    sessions.exec(
      { cmd: "exec", session: "s", program: "while(true){}", timeoutMs: 1000 },
      "req-1",
    ),
    (error) => error.code === "EGO_RUN_HUNG",
  );
  assert.equal(transports[0].killed, true);
  const next = await sessions.exec(
    { cmd: "exec", session: "s", program: "2" },
    "req-2",
  );
  assert.equal(next.session.rebuiltReason, "program hung");
});

test("a REPL that exits mid-program surfaces SESSION_LOST", async () => {
  const { sessions } = manager({
    behavior: { program: (cell, id) => (id === "req-1" ? "exit" : null) },
  });
  await assert.rejects(
    sessions.exec({ cmd: "exec", session: "s", program: "1" }, "req-1"),
    (error) => error.code === "EGO_RUN_SESSION_LOST",
  );
  const next = await sessions.exec(
    { cmd: "exec", session: "s", program: "2" },
    "req-2",
  );
  assert.equal(next.session.fresh, true);
});

test("syntax errors never open a REPL", async () => {
  const { sessions, transports } = manager();
  await assert.rejects(
    sessions.exec({ cmd: "exec", session: "s", program: "const = ;" }),
    (error) => error.code === "EGO_RUN_PROGRAM_SYNTAX",
  );
  assert.equal(transports.length, 0);
  assert.equal(sessions.size, 0);
});

test("invalid session ids are rejected", async () => {
  const { sessions } = manager();
  for (const bad of ["", "Order Flow", "-x", "a".repeat(65), "spaces here"]) {
    await assert.rejects(
      sessions.exec({ cmd: "exec", session: bad, program: "1" }),
      /invalid session id/,
    );
  }
});

test("the least recently used idle session is evicted at the limit", async () => {
  let now = 0;
  const { sessions } = manager({ manager: { maxSessions: 2, now: () => now } });
  await sessions.exec({ cmd: "exec", session: "old", program: "1" });
  now = 10;
  await sessions.exec({ cmd: "exec", session: "newer", program: "1" });
  now = 20;
  await sessions.exec({ cmd: "exec", session: "third", program: "1" });
  assert.deepEqual(
    sessions
      .list()
      .map((s) => s.session)
      .sort(),
    ["newer", "third"],
  );
});

test("sweep closes idle sessions, reset keeps the id but drops the context", async () => {
  let now = 0;
  const { sessions, transports } = manager({
    manager: { idleMs: 1000, now: () => now },
  });
  await sessions.exec({ cmd: "exec", session: "s", program: "1" });
  assert.equal(sessions.reset("s"), true);
  assert.equal(transports[0].killed, true);
  const next = await sessions.exec({ cmd: "exec", session: "s", program: "2" });
  assert.equal(next.session.rebuiltReason, "reset");
  now = 5000;
  assert.equal(sessions.sweep(), 1);
  assert.equal(sessions.size, 0);
});

test("newId derives a slug from the prefix", () => {
  const { sessions } = manager();
  assert.match(sessions.newId("Order Flow!"), /^order-flow-[0-9a-f]{6}$/);
  assert.match(sessions.newId(), /^session-[0-9a-f]{6}$/);
});

test("extractResult helper is what the fake relies on", () => {
  assert.ok(
    extractResult(`${RESULT_MARKER}x:{"ok":true,"logs":"","ms":0}\n`, "x"),
  );
});
