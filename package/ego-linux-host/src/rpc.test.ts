import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeLine,
  encodeRequest,
  encodeResponse,
  encodeEvent,
  decodeLine,
  isRpcRequest,
  isRpcResponse,
  isRpcEvent,
  LineBuffer,
  type RpcRequest,
  type RpcResponse,
  type RpcEvent,
} from "./rpc.js";

test("encodeRequest emits NDJSON with trailing newline", () => {
  const line = encodeRequest({ id: 1, method: "ping" });
  assert.equal(line.endsWith("\n"), true);
  assert.equal(line, '{"id":1,"method":"ping"}\n');
});

test("encodeResponse and encodeEvent round-trip via decodeLine", () => {
  const res: RpcResponse = { id: 2, result: { ok: true } };
  const decodedRes = decodeLine(encodeResponse(res).trimEnd());
  assert.deepEqual(decodedRes, res);
  assert.equal(isRpcResponse(decodedRes), true);

  const ev: RpcEvent = {
    event: "cdp.message",
    params: { payload: '{"id":1}' },
  };
  const decodedEv = decodeLine(encodeEvent(ev).trimEnd());
  assert.deepEqual(decodedEv, ev);
  assert.equal(isRpcEvent(decodedEv), true);
});

test("decodeLine classifies request with method and id", () => {
  const req: RpcRequest = {
    id: 7,
    method: "ego.listTabs",
    params: {},
  };
  const msg = decodeLine(JSON.stringify(req));
  assert.equal(isRpcRequest(msg), true);
  if (isRpcRequest(msg)) {
    assert.equal(msg.method, "ego.listTabs");
    assert.equal(msg.id, 7);
  }
});

test("decodeLine classifies error response", () => {
  const line = JSON.stringify({
    id: 3,
    error: { code: "EGO_OPERATION_FAILED", message: "nope" },
  });
  const msg = decodeLine(line);
  assert.equal(isRpcResponse(msg), true);
  if (isRpcResponse(msg)) {
    assert.equal(msg.error?.code, "EGO_OPERATION_FAILED");
  }
});

test("decodeLine rejects empty and invalid JSON", () => {
  assert.throws(() => decodeLine(""), /empty/);
  assert.throws(() => decodeLine("not-json"), /invalid RPC JSON/);
  assert.throws(() => decodeLine("[]"), /JSON object/);
});

test("encodeLine is shared by helpers", () => {
  assert.equal(encodeLine({ a: 1 }), '{"a":1}\n');
});

test("LineBuffer splits chunks across boundaries", () => {
  const buf = new LineBuffer();
  assert.deepEqual(buf.push('{"id":1,"method":"ping"}'), []);
  assert.deepEqual(buf.push("\n{\"id\":2,"), ['{"id":1,"method":"ping"}']);
  assert.deepEqual(buf.push('"method":"doctor"}\n'), [
    '{"id":2,"method":"doctor"}',
  ]);
  assert.equal(buf.pending(), "");
});

test("LineBuffer skips empty lines and accepts CRLF", () => {
  const buf = new LineBuffer();
  const lines = buf.push('{"id":1,"method":"ping"}\r\n\n{"event":"x"}\n');
  assert.deepEqual(lines, ['{"id":1,"method":"ping"}', '{"event":"x"}']);
});

test("type guards reject wrong shapes", () => {
  assert.equal(isRpcRequest({ event: "x" }), false);
  assert.equal(isRpcEvent({ id: 1, method: "ping" }), false);
  assert.equal(isRpcResponse({ id: 1, method: "ping" }), false);
  assert.equal(isRpcResponse({ id: 1, result: true }), true);
});
