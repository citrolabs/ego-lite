import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Uses the actual Linux host, socket client, polyfill and browser runtime;
// only Chrome is replaced. No real browser or repository writes.
test("late events and errors from one task do not interrupt another task", async () => {
  const moduleUrl = (name) =>
    new URL("../../dist/src/" + name, import.meta.url);
  const root = await mkdtemp(join(tmpdir(), "ego-transport-review-"));
  process.env.EGO_LINUX_STATE_DIR = root;
  process.env.EGO_BROWSER_STATE_DIR = join(root, "page-state");
  process.env.EGO_LINUX = "1";
  delete process.env.EGO_LINUX_PORT;
  const { LinuxHost } = await import(moduleUrl("linux/host.js"));
  const { hostDirectory } = await import(moduleUrl("linux/client.js"));
  const { installEgoLinux, closeLinuxClient } = await import(
    moduleUrl("linux/index.js")
  );
  const {
    browserCdp,
    ensureSession,
    invalidateSession,
    disposeBrowserRuntime,
  } = await import(moduleUrl("browser-runtime.js"));

  let sequence = 0;
  const targets = [];
  const held = new Map();
  const started = new Map();
  const calls = [];
  const bridge = {
    async call(method, params = {}, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === "Target.createBrowserContext")
        return { browserContextId: `ctx-${++sequence}` };
      if (method === "Target.createTarget") {
        const target = {
          targetId: `tab-${++sequence}`,
          type: "page",
          browserContextId: params.browserContextId,
        };
        targets.push(target);
        return { targetId: target.targetId };
      }
      if (method === "Target.getTargets") return { targetInfos: targets };
      if (method === "Target.attachToTarget")
        return { sessionId: `session-${++sequence}` };
      if (
        method === "Runtime.evaluate" &&
        params.expression?.startsWith("hold-")
      ) {
        return new Promise((resolve) => {
          held.set(params.expression, resolve);
          started.get(params.expression)?.();
        });
      }
      return {};
    },
  };
  const host = new LinuxHost({ headless: false, bridge });
  const sockets = new Set();
  const directory = hostDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    const client = host.add(socket);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const request = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        host.enqueue(client, request).then(
          (result) =>
            socket.write(JSON.stringify({ id: request.id, result }) + "\n"),
          (error) =>
            socket.write(
              JSON.stringify({
                id: request.id,
                error: {
                  message: error.message,
                  code: error.code,
                  error_code:
                    error.error_code ??
                    (request.method === "cdp"
                      ? undefined
                      : "EGO_OPERATION_FAILED"),
                },
              }) + "\n",
            ),
        );
      }
    });
  });
  await new Promise((resolve) =>
    server.listen(join(directory, "host.sock"), resolve),
  );
  const waitStarted = (expression) =>
    new Promise((resolve) => started.set(expression, resolve));
  try {
    await installEgoLinux();
    const a = await ego.createTaskSpace("a");
    const b = await ego.createTaskSpace("b");
    ego.useTaskSpace(a.id);
    const sessionA = await ensureSession(targets[0].targetId);
    ego.useTaskSpace(b.id);
    invalidateSession();
    const sessionB = await ensureSession(targets[1].targetId);
    let began = waitStarted("hold-b-event");
    const pendingB = browserCdp(
      "Runtime.evaluate",
      { expression: "hold-b-event" },
      sessionB,
    );
    await began;
    bridge.onEvent({
      method: "Target.attachedToTarget",
      sessionId: sessionA,
      params: {
        sessionId: "late-a-iframe",
        targetInfo: {
          targetId: "a-frame",
          type: "iframe",
          browserContextId: a.browserContextId,
        },
        waitingForDebugger: false,
      },
    });
    // Let the real Unix-socket client consume the tagged event before completing B.
    await new Promise((resolve) => setTimeout(resolve, 20));
    held.get("hold-b-event")({ result: { value: 42 } });
    assert.equal((await pendingB).result.result.value, 42);
    assert.equal(
      calls.some((call) => call.sessionId === "late-a-iframe"),
      false,
    );

    ego.useTaskSpace(a.id);
    began = waitStarted("hold-a-error");
    const pendingA = browserCdp(
      "Runtime.evaluate",
      { expression: "hold-a-error" },
      sessionA,
    );
    const rejectedA = assert.rejects(pendingA, /manual_takeover/);
    await began;
    ego.useTaskSpace(b.id);
    began = waitStarted("hold-b-error");
    const otherB = browserCdp(
      "Runtime.evaluate",
      { expression: "hold-b-error" },
      sessionB,
    );
    await began;
    host.spaces.handOffTaskSpace(a.id);
    held.get("hold-a-error")({ result: { value: 1 } });
    await rejectedA;
    held.get("hold-b-error")({ result: { value: 43 } });
    assert.equal((await otherB).result.result.value, 43);
  } finally {
    for (const release of held.values()) release({});
    disposeBrowserRuntime();
    await closeLinuxClient();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
