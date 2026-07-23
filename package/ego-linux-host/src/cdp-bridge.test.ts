import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import {
  createCdpSession,
  createCdpBridge,
  connectCdp,
} from "./cdp-bridge.js";

/** Minimal injectable transport: records sends and delivers replies via onMessage. */
function mockTransport() {
  let handler: ((text: string) => void) | undefined;
  const sent: string[] = [];
  const transport = {
    sent,
    send(text: string) {
      sent.push(text);
    },
    onMessage(cb: (text: string) => void) {
      handler = cb;
    },
    deliver(obj: object) {
      assert.ok(handler, "onMessage must be registered");
      handler!(JSON.stringify(obj));
    },
    /** Auto-reply to each send with result (or custom builder). */
    autoReply(resultOrBuilder: object | ((msg: any) => object)) {
      const prevSend = transport.send.bind(transport);
      transport.send = (text: string) => {
        prevSend(text);
        const msg = JSON.parse(text);
        const reply =
          typeof resultOrBuilder === "function"
            ? resultOrBuilder(msg)
            : { id: msg.id, result: resultOrBuilder };
        queueMicrotask(() => transport.deliver(reply));
      };
    },
  };
  return transport;
}

/** Minimal RFC6455 text-frame WebSocket server on an HTTP server upgrade. */
function attachMinimalWsServer(
  httpServer: ReturnType<typeof createServer>,
  onText: (text: string, reply: (text: string) => void) => void,
) {
  const onUpgrade = (
    req: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ) => {
    if (!req.url?.startsWith("/devtools/browser/")) {
      socket.destroy();
      return;
    }
    const key = req.headers["sec-websocket-key"];
    if (!key || typeof key !== "string") {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        "\r\n",
    );

    let buf = head?.length ? Buffer.from(head) : Buffer.alloc(0);

    const sendText = (text: string) => {
      const payload = Buffer.from(text, "utf8");
      let header: Buffer;
      if (payload.length < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x81;
        header[1] = payload.length;
      } else if (payload.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(payload.length, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
      }
      socket.write(Buffer.concat([header, payload]));
    };

    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        const maskLen = masked ? 4 : 0;
        if (buf.length < off + maskLen + len) return;
        let payload = buf.subarray(off + maskLen, off + maskLen + len);
        if (masked) {
          const mask = buf.subarray(off, off + 4);
          payload = Buffer.from(payload);
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        }
        buf = buf.subarray(off + maskLen + len);
        if (opcode === 0x8) {
          socket.end();
          return;
        }
        if (opcode === 0x1) {
          onText(payload.toString("utf8"), sendText);
        }
      }
    });
  };

  httpServer.on("upgrade", onUpgrade);
  return () => httpServer.off("upgrade", onUpgrade);
}

test("createCdpSession resolves matching id", async () => {
  let handler: ((text: string) => void) | undefined;
  const transport = {
    send(text: string) {
      const msg = JSON.parse(text);
      handler!(JSON.stringify({ id: msg.id, result: { ok: true } }));
    },
    onMessage(cb: (text: string) => void) {
      handler = cb;
    },
  };
  const session = createCdpSession(transport);
  const result = await session.send("Foo.bar");
  assert.deepEqual(result, { ok: true });
});

test("createCdpSession increments ids and correlates concurrent sends", async () => {
  const t = mockTransport();
  const session = createCdpSession(t);

  const p1 = session.send("A.one");
  const p2 = session.send("B.two");

  assert.equal(t.sent.length, 2);
  const m1 = JSON.parse(t.sent[0]);
  const m2 = JSON.parse(t.sent[1]);
  assert.equal(m1.id, 1);
  assert.equal(m2.id, 2);
  assert.equal(m1.method, "A.one");
  assert.equal(m2.method, "B.two");

  // Resolve out of order
  t.deliver({ id: 2, result: { second: true } });
  t.deliver({ id: 1, result: { first: true } });

  assert.deepEqual(await p2, { second: true });
  assert.deepEqual(await p1, { first: true });
});

test("createCdpSession includes params and sessionId when provided", async () => {
  const t = mockTransport();
  t.autoReply({});
  const session = createCdpSession(t);
  await session.send("Runtime.evaluate", { expression: "1" }, "sess-9");
  const msg = JSON.parse(t.sent[0]);
  assert.equal(msg.method, "Runtime.evaluate");
  assert.deepEqual(msg.params, { expression: "1" });
  assert.equal(msg.sessionId, "sess-9");
});

test("createCdpSession rejects CDP error responses", async () => {
  const t = mockTransport();
  t.autoReply((msg) => ({
    id: msg.id,
    error: { code: -32000, message: "Target closed" },
  }));
  const session = createCdpSession(t);
  await assert.rejects(
    () => session.send("Page.navigate"),
    (err: Error & { error_code?: string }) => {
      assert.match(err.message, /Target closed/);
      assert.equal(err.error_code, "EGO_CDP_SEND_FAILED");
      return true;
    },
  );
});

test("createCdpSession times out pending requests", async () => {
  const t = mockTransport();
  const session = createCdpSession(t, { timeoutMs: 30 });
  await assert.rejects(
    () => session.send("Slow.method"),
    (err: Error & { error_code?: string }) => {
      assert.match(err.message, /timeout/i);
      assert.match(err.message, /Slow\.method/);
      assert.equal(err.error_code, "EGO_CDP_SEND_FAILED");
      return true;
    },
  );
});

test("createCdpSession routes events (no id) to onEvent listeners", async () => {
  const t = mockTransport();
  const session = createCdpSession(t);
  const events: any[] = [];
  const unsub = session.onEvent((msg) => events.push(msg));

  t.deliver({ method: "Target.targetCreated", params: { targetId: "t1" } });
  t.deliver({ method: "Page.loadEventFired", params: {}, sessionId: "s1" });

  assert.equal(events.length, 2);
  assert.equal(events[0].method, "Target.targetCreated");
  assert.equal(events[1].sessionId, "s1");

  unsub();
  t.deliver({ method: "Inspector.detached", params: {} });
  assert.equal(events.length, 2, "unsubscribed handler must not receive more");
});

test("createCdpSession handleIncoming is public for direct injection", async () => {
  const t = mockTransport();
  const session = createCdpSession(t);
  const p = session.send("X.y");
  const msg = JSON.parse(t.sent[0]);
  session.handleIncoming(JSON.stringify({ id: msg.id, result: { direct: 1 } }));
  assert.deepEqual(await p, { direct: 1 });
});

test("createCdpBridge listPageTargets filters type===page", async () => {
  const t = mockTransport();
  t.autoReply((msg) => {
    assert.equal(msg.method, "Target.getTargets");
    return {
      id: msg.id,
      result: {
        targetInfos: [
          {
            targetId: "p1",
            type: "page",
            title: "Hello",
            url: "https://example.com",
          },
          {
            targetId: "s1",
            type: "service_worker",
            title: "",
            url: "https://example.com/sw.js",
          },
          {
            targetId: "p2",
            type: "page",
            title: "Other",
            url: "about:blank",
          },
        ],
      },
    };
  });
  const bridge = createCdpBridge(t);
  const pages = await bridge.listPageTargets();
  assert.deepEqual(pages, [
    {
      targetId: "p1",
      title: "Hello",
      url: "https://example.com",
      type: "page",
    },
    { targetId: "p2", title: "Other", url: "about:blank", type: "page" },
  ]);
});

test("createCdpBridge createTarget returns targetId", async () => {
  const t = mockTransport();
  t.autoReply((msg) => {
    assert.equal(msg.method, "Target.createTarget");
    assert.deepEqual(msg.params, { url: "https://ego.test/" });
    return { id: msg.id, result: { targetId: "new-tab-1" } };
  });
  const bridge = createCdpBridge(t);
  const id = await bridge.createTarget("https://ego.test/");
  assert.equal(id, "new-tab-1");
});

test("createCdpBridge attach returns sessionId with flatten", async () => {
  const t = mockTransport();
  t.autoReply((msg) => {
    assert.equal(msg.method, "Target.attachToTarget");
    assert.deepEqual(msg.params, { targetId: "tid-7", flatten: true });
    return { id: msg.id, result: { sessionId: "session-abc" } };
  });
  const bridge = createCdpBridge(t);
  const sessionId = await bridge.attach("tid-7");
  assert.equal(sessionId, "session-abc");
});

test("createCdpBridge sendRaw emits JSON without waiting", () => {
  const t = mockTransport();
  const bridge = createCdpBridge(t);
  bridge.sendRaw({ id: 99, method: "Foo", params: {} });
  assert.equal(t.sent.length, 1);
  assert.deepEqual(JSON.parse(t.sent[0]), {
    id: 99,
    method: "Foo",
    params: {},
  });
});

test("connectCdp opens WebSocket from /json/version and rounds trips", async () => {
  const httpServer = createServer((req, res) => {
    if (req.url === "/json/version") {
      const host = req.headers.host || "127.0.0.1";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          Browser: "Fake/1.0",
          "Protocol-Version": "1.3",
          webSocketDebuggerUrl: `ws://${host}/devtools/browser/fake`,
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const addr = httpServer.address();
  assert.ok(addr && typeof addr === "object");
  const port = addr.port;

  const detach = attachMinimalWsServer(httpServer, (text, reply) => {
    try {
      const msg = JSON.parse(text);
      if (msg.method === "Target.getTargets") {
        reply(
          JSON.stringify({
            id: msg.id,
            result: {
              targetInfos: [
                {
                  targetId: "live-1",
                  type: "page",
                  title: "Live",
                  url: "about:blank",
                },
              ],
            },
          }),
        );
      } else {
        reply(JSON.stringify({ id: msg.id, result: { echo: msg.method } }));
      }
    } catch {
      /* ignore non-JSON */
    }
  });

  try {
    const bridge = await connectCdp(port);
    try {
      const result = await bridge.send("Runtime.evaluate", {
        expression: "1+1",
      });
      assert.deepEqual(result, { echo: "Runtime.evaluate" });
      const pages = await bridge.listPageTargets();
      assert.equal(pages.length, 1);
      assert.equal(pages[0].targetId, "live-1");
    } finally {
      await bridge.close();
    }
  } finally {
    detach();
    await new Promise<void>((resolve, reject) =>
      httpServer.close((err) => (err ? reject(err) : resolve())),
    );
  }
});

test("connectCdp throws EGO_CDP_CHANNEL_UNAVAILABLE when port closed", async () => {
  await assert.rejects(
    () => connectCdp(1),
    (err: Error & { error_code?: string }) => {
      assert.equal(err.error_code, "EGO_CDP_CHANNEL_UNAVAILABLE");
      return true;
    },
  );
});
