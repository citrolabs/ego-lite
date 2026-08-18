import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { connectLinuxBridge } from "../../dist/src/linux/bridge.js";

describe("linux bridge", () => {
  let httpServer = null;
  let wss = null;
  let connections = [];
  const PORT = 19223;

  afterEach(async () => {
    for (const c of connections) c.close();
    connections.length = 0;
    wss?.close();
    wss = null;
    if (httpServer) {
      await new Promise((resolve) => httpServer.close(() => resolve()));
      httpServer = null;
    }
  });

  it("connects to a DevTools-like WebSocket target", async () => {
    httpServer = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify([
          {
            webSocketDebuggerUrl: `ws://127.0.0.1:${PORT + 1}/devtools/page/1`,
          },
        ]),
      );
    });

    await new Promise((resolve) => httpServer.listen(PORT, resolve));

    let received = "";
    wss = new WebSocketServer({ port: PORT + 1, host: "127.0.0.1" });
    wss.on("connection", (ws) => {
      connections.push(ws);
      ws.on("message", (data) => {
        received += data.toString();
      });
    });

    const bridge = await connectLinuxBridge({ port: PORT });
    bridge.send("hello");

    // Give the message time to arrive
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(received.includes("hello"));
    bridge.close();
  });

  it("throws when no page target is available", async () => {
    httpServer = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("[]");
    });

    await new Promise((resolve) => httpServer.listen(PORT, resolve));

    await assert.rejects(
      () => connectLinuxBridge({ port: PORT, timeoutMs: 500 }),
      /No page target found/,
    );
  });

  it("throws when ws connection times out", async () => {
    httpServer = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify([
          {
            webSocketDebuggerUrl: `ws://127.0.0.1:${PORT + 99}/devtools/page/1`,
          },
        ]),
      );
    });

    await new Promise((resolve) => httpServer.listen(PORT, resolve));

    await assert.rejects(
      () => connectLinuxBridge({ port: PORT, timeoutMs: 100 }),
      /timed out|ECONNREFUSED/,
    );
  });
});
