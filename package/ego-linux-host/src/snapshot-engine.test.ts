import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createCdpBridge } from "./cdp-bridge.js";
import { axTreeToSnapshot, snapshotPage } from "./snapshot-engine.js";

/** Minimal injectable transport: records sends and auto-replies. */
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

function manyAxNodes(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    nodeId: String(i + 1),
    ignored: false,
    role: { value: "button" },
    name: { value: `Btn${i}` },
    backendDOMNodeId: 1000 + i,
  }));
}

test("axTreeToSnapshot emits refs with backendNodeId", async () => {
  const ax = JSON.parse(
    await readFile(
      new URL("./fixtures/ax-tree-minimal.json", import.meta.url),
      "utf8",
    ),
  );
  const snap = axTreeToSnapshot(ax.nodes, { includeActionMarks: true });
  assert.ok(snap.content.length > 0);
  assert.ok(snap.refs.length > 0);
  assert.equal(typeof snap.refs[0].backendNodeId, "number");
  assert.match(snap.content, /@1/);
});

test("maxResultLength truncates content", () => {
  const snap = axTreeToSnapshot(manyAxNodes(20), { maxResultLength: 1 });
  assert.ok(snap.content.length <= 1);
});

test("axTreeToSnapshot skips ignored and empty generic nodes", async () => {
  const ax = JSON.parse(
    await readFile(
      new URL("./fixtures/ax-tree-minimal.json", import.meta.url),
      "utf8",
    ),
  );
  const snap = axTreeToSnapshot(ax.nodes, { includeActionMarks: true });
  const backendIds = snap.refs.map((r) => r.backendNodeId);
  assert.ok(!backendIds.includes(50), "ignored node skipped");
  assert.ok(!backendIds.includes(60), "empty generic skipped");
  assert.ok(backendIds.includes(20), "button kept");
  assert.ok(backendIds.includes(70), "StaticText kept");
});

test("includeActionMarks false omits @N marks but still returns refs", async () => {
  const ax = JSON.parse(
    await readFile(
      new URL("./fixtures/ax-tree-minimal.json", import.meta.url),
      "utf8",
    ),
  );
  const snap = axTreeToSnapshot(ax.nodes, { includeActionMarks: false });
  assert.ok(snap.refs.length > 0);
  assert.doesNotMatch(snap.content, /@\d+/);
  assert.match(snap.content, /button/);
});

test("content line format includes role and quoted name", async () => {
  const ax = JSON.parse(
    await readFile(
      new URL("./fixtures/ax-tree-minimal.json", import.meta.url),
      "utf8",
    ),
  );
  const snap = axTreeToSnapshot(ax.nodes, { includeActionMarks: true });
  assert.match(snap.content, /@\d+ button "Submit"/);
  assert.match(snap.content, /@\d+ link "Home"/);
  assert.match(snap.content, /@\d+ textbox "Email"/);
});

test("refs allocate sequential ids starting at 1", async () => {
  const ax = JSON.parse(
    await readFile(
      new URL("./fixtures/ax-tree-minimal.json", import.meta.url),
      "utf8",
    ),
  );
  const snap = axTreeToSnapshot(ax.nodes, { includeActionMarks: true });
  assert.equal(snap.refs[0].id, 1);
  for (let i = 0; i < snap.refs.length; i++) {
    assert.equal(snap.refs[i].id, i + 1);
    assert.equal(typeof snap.refs[i].backendNodeId, "number");
    assert.ok(snap.refs[i].role);
  }
});

test("snapshotPage enables AX, fetches tree, returns snapshot", async () => {
  const ax = JSON.parse(
    await readFile(
      new URL("./fixtures/ax-tree-minimal.json", import.meta.url),
      "utf8",
    ),
  );
  const transport = mockTransport();
  transport.autoReply((msg) => {
    if (msg.method === "Accessibility.enable") {
      return { id: msg.id, result: {} };
    }
    if (msg.method === "Accessibility.getFullAXTree") {
      return { id: msg.id, result: { nodes: ax.nodes } };
    }
    return { id: msg.id, result: {} };
  });
  const cdp = createCdpBridge(transport);
  const snap = await snapshotPage(cdp, "sess-1", { includeActionMarks: true });
  assert.ok(snap.refs.length > 0);
  assert.match(snap.content, /@1/);
  const methods = transport.sent.map((t) => JSON.parse(t).method);
  assert.ok(methods.includes("Accessibility.enable"));
  assert.ok(methods.includes("Accessibility.getFullAXTree"));
  const treeCall = transport.sent
    .map((t) => JSON.parse(t))
    .find((m) => m.method === "Accessibility.getFullAXTree");
  assert.equal(treeCall.sessionId, "sess-1");
});

test("snapshotPage throws EGO_SNAPSHOT_FAILED on CDP failure", async () => {
  const transport = mockTransport();
  transport.autoReply((msg) => ({
    id: msg.id,
    error: { code: -32000, message: "AX boom" },
  }));
  const cdp = createCdpBridge(transport);
  await assert.rejects(
    () => snapshotPage(cdp, "sess-x"),
    (err: any) => {
      assert.equal(err.error_code, "EGO_SNAPSHOT_FAILED");
      assert.match(String(err.message), /AX boom|snapshot|Accessibility/i);
      return true;
    },
  );
});
