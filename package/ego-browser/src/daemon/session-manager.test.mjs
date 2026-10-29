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
      if (program && typeof program === "object" && program.delayMs) {
        setTimeout(
          () =>
            this.emit(
              `${RESULT_MARKER}${id}:${JSON.stringify({ ok: true, value: id, logs: "", ms: program.delayMs })}\nrepl> `,
            ),
          program.delayMs,
        );
        return;
      }
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
  setTimeout(() => {
    if (behavior.startup === "silent") return; // alive, never enters the REPL
    if (behavior.startup === "exit") {
      transport.emit("ego-browser: cannot connect to the browser\r\n");
      transport.emitExit(1);
      return;
    }
    transport.emit("ego-browser nodejs REPL. Type .exit to quit\r\nrepl> ");
  }, 2);
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

test("closing a busy session fails its queued programs instead of reopening a REPL", async () => {
  const { sessions, transports } = manager({
    behavior: { program: (cell, id) => (id === "req-1" ? "hang" : null) },
  });
  const running = sessions.exec(
    {
      cmd: "exec",
      session: "s",
      program: "await new Promise(() => {})",
      timeoutMs: 5000,
    },
    "req-1",
  );
  const queued = sessions.exec(
    { cmd: "exec", session: "s", program: "2" },
    "req-2",
  );
  // Let req-1 open its REPL and start running before closing the session.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sessions.list()[0].queued, 1);
  assert.equal(sessions.close("s"), true);
  await assert.rejects(
    running,
    (error) => error.code === "EGO_RUN_SESSION_LOST",
  );
  await assert.rejects(
    queued,
    (error) =>
      error.code === "EGO_RUN_SESSION_LOST" &&
      /closed while this program was queued/.test(error.message),
  );
  assert.equal(
    transports.length,
    1,
    "the queued program did not reopen a REPL",
  );
  assert.equal(transports[0].killed, true);
  assert.equal(sessions.has("s"), false);
  // The id is free again: a later call starts a brand-new session.
  const next = await sessions.exec(
    { cmd: "exec", session: "s", program: "3" },
    "req-3",
  );
  assert.equal(next.session.fresh, true);
  assert.equal(transports.length, 2);
});

test("queue time counts against the deadline and a late program never starts", async () => {
  const { sessions, transports } = manager({
    behavior: {
      program: (cell, id) => (id === "req-1" ? { delayMs: 1300 } : null),
    },
  });
  const first = sessions.exec(
    { cmd: "exec", session: "s", program: "1", timeoutMs: 5000 },
    "req-1",
  );
  await assert.rejects(
    sessions.exec(
      { cmd: "exec", session: "s", program: "2", timeoutMs: 1000 },
      "req-2",
    ),
    (error) =>
      error.code === "EGO_RUN_DEADLINE" && /did not start/.test(error.message),
  );
  assert.equal((await first).ok, true);
  assert.equal(transports[0].cells.length, 1, "req-2 was never sent");
  assert.equal(transports[0].killed, false, "the session is intact");
  const next = await sessions.exec(
    { cmd: "exec", session: "s", program: "3" },
    "req-3",
  );
  assert.equal(next.session.fresh, false);
});

test("a program whose client disconnected while queued is skipped", async () => {
  const { sessions, transports } = manager({
    behavior: {
      program: (cell, id) => (id === "req-1" ? { delayMs: 100 } : null),
    },
  });
  const gone = new AbortController();
  const first = sessions.exec(
    { cmd: "exec", session: "s", program: "1" },
    "req-1",
  );
  const queued = sessions.exec(
    { cmd: "exec", session: "s", program: "2" },
    "req-2",
    { signal: gone.signal },
  );
  gone.abort();
  await assert.rejects(queued, (error) =>
    /client disconnected/.test(error.message),
  );
  assert.equal((await first).ok, true);
  assert.equal(
    transports[0].cells.length,
    1,
    "the orphaned program was not sent",
  );
  assert.equal(transports[0].killed, false);
});

test("a live REPL that never prints its banner is killed, not leaked", async () => {
  const { sessions, transports } = manager({
    behavior: { startup: "silent" },
    manager: { bannerTimeoutMs: 200 },
  });
  await assert.rejects(
    sessions.exec({ cmd: "exec", session: "s", program: "1" }, "req-1"),
    (error) =>
      error.code === "EGO_RUN_SESSION_START_FAILED" &&
      /did not enter the REPL within 200 ms/.test(error.message),
  );
  assert.equal(transports.length, 1);
  assert.equal(transports[0].killed, true, "the silent process was killed");
});

test("a REPL that exits before its banner fails startup promptly", async () => {
  const { sessions } = manager({ behavior: { startup: "exit" } });
  const started = Date.now();
  await assert.rejects(
    sessions.exec({ cmd: "exec", session: "s", program: "1" }, "req-1"),
    (error) =>
      error.code === "EGO_RUN_SESSION_START_FAILED" &&
      /exited before entering the REPL \(code 1\)/.test(error.message) &&
      /cannot connect/.test(error.message),
  );
  assert.ok(
    Date.now() - started < 2000,
    "startup failure must not wait out the 20 s banner timeout",
  );
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
