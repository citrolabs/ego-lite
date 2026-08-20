import test from "node:test";
import assert from "node:assert/strict";
import { startHealthServer } from "./health-server.js";

test("health server distinguishes liveness from browser readiness", async () => {
  let ready = false;
  const server = await startHealthServer({
    host: "127.0.0.1",
    port: 0,
    isReady: async () => ready,
  });
  try {
    const live = await fetch(`http://127.0.0.1:${server.port}/livez`);
    assert.equal(live.status, 200);

    const notReady = await fetch(`http://127.0.0.1:${server.port}/readyz`);
    assert.equal(notReady.status, 503);

    ready = true;
    const becameReady = await fetch(`http://127.0.0.1:${server.port}/readyz`);
    assert.equal(becameReady.status, 200);

    const missing = await fetch(`http://127.0.0.1:${server.port}/rpc`);
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
  }
});
