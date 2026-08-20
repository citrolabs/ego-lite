import test from "node:test";
import assert from "node:assert/strict";

import { CdpConnection } from "../dist/src/cdp-connection.js";

class FakeSocket {
  constructor() {
    this.sent = [];
    this.listeners = new Map();
  }
  addEventListener(type, listener, options = {}) {
    const wrapped = options.once
      ? (event) => {
          this.removeListener(type, wrapped);
          listener(event);
        }
      : listener;
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(wrapped);
  }
  removeListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type, event = {}) {
    for (const listener of [...(this.listeners.get(type) || [])]) {
      listener(event);
    }
  }
  send(payload) {
    this.sent.push(JSON.parse(payload));
  }
  close() {
    this.emit("close");
  }
}

async function openWithFake() {
  const socket = new FakeSocket();
  const promise = CdpConnection.open("ws://fake", () => socket);
  socket.emit("open");
  const connection = await promise;
  return { connection, socket };
}

test("open rejects when the socket errors before opening", async () => {
  const socket = new FakeSocket();
  const promise = CdpConnection.open("ws://fake", () => socket);
  socket.emit("error");
  await assert.rejects(promise, /failed to open/);
});

test("request resolves with the matching response result", async () => {
  const { connection, socket } = await openWithFake();
  const promise = connection.request("Target.getTargets");
  const sent = socket.sent[0];
  assert.equal(sent.method, "Target.getTargets");
  socket.emit("message", {
    data: JSON.stringify({ id: sent.id, result: { targetInfos: [1] } }),
  });
  assert.deepEqual(await promise, { targetInfos: [1] });
});

test("request rejects on a CDP error response", async () => {
  const { connection, socket } = await openWithFake();
  const promise = connection.request("Bad.method");
  socket.emit("message", {
    data: JSON.stringify({
      id: socket.sent[0].id,
      error: { message: "'Bad.method' wasn't found" },
    }),
  });
  await assert.rejects(promise, /wasn't found/);
});

test("request attaches the sessionId when given", async () => {
  const { connection, socket } = await openWithFake();
  const promise = connection.request("Page.enable", {}, "sess-9");
  assert.equal(socket.sent[0].sessionId, "sess-9");
  socket.emit("message", {
    data: JSON.stringify({ id: socket.sent[0].id, result: {} }),
  });
  await promise;
});

test("request times out when no response arrives", async () => {
  const { connection } = await openWithFake();
  await assert.rejects(
    connection.request("Slow.method", {}, undefined, 20),
    /timed out: Slow\.method/,
  );
});

test("pending requests reject when the socket closes", async () => {
  const { connection, socket } = await openWithFake();
  const promise = connection.request("Target.getTargets");
  socket.close();
  await assert.rejects(promise, /socket closed/);
});

test("onMessage subscribers see every raw message and can unsubscribe", async () => {
  const { connection, socket } = await openWithFake();
  const seen = [];
  const unsubscribe = connection.onMessage((raw) => seen.push(raw));
  socket.emit("message", { data: '{"method":"Page.loadEventFired"}' });
  unsubscribe();
  socket.emit("message", { data: '{"method":"Page.frameNavigated"}' });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /loadEventFired/);
});

test("sendRaw forwards payloads verbatim", async () => {
  const { connection, socket } = await openWithFake();
  connection.sendRaw('{"id":1,"method":"Runtime.evaluate"}');
  assert.deepEqual(socket.sent[0], { id: 1, method: "Runtime.evaluate" });
});
