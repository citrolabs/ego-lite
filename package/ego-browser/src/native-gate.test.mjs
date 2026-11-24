import test from "node:test";
import assert from "node:assert/strict";

import { NativeOperationGate } from "../dist/src/native-gate.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function turn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("NativeOperationGate holds the selected space for the full operation", async () => {
  const firstMayFinish = deferred();
  const log = [];
  let selectedSpace = null;
  let activeOperations = 0;
  let maxActiveOperations = 0;
  const gate = new NativeOperationGate({
    async selectSpace(spaceId) {
      selectedSpace = spaceId;
      log.push(`select:${spaceId}`);
    },
    async ensureSession() {
      throw new Error("not used");
    },
  });

  const first = gate.withSpace(1, async ({ spaceId }) => {
    activeOperations += 1;
    maxActiveOperations = Math.max(maxActiveOperations, activeOperations);
    log.push(`start:${spaceId}`);
    assert.equal(selectedSpace, 1);
    await firstMayFinish.promise;
    assert.equal(
      selectedSpace,
      1,
      "space must not change while work is pending",
    );
    log.push(`end:${spaceId}`);
    activeOperations -= 1;
    return "first";
  });
  const second = gate.withSpace(2, async ({ spaceId }) => {
    activeOperations += 1;
    maxActiveOperations = Math.max(maxActiveOperations, activeOperations);
    log.push(`start:${spaceId}`);
    assert.equal(selectedSpace, 2);
    log.push(`end:${spaceId}`);
    activeOperations -= 1;
    return "second";
  });

  await turn();
  assert.deepEqual(log, ["select:1", "start:1"]);
  firstMayFinish.resolve();

  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.equal(maxActiveOperations, 1);
  assert.deepEqual(log, [
    "select:1",
    "start:1",
    "end:1",
    "select:2",
    "start:2",
    "end:2",
  ]);
});

test("NativeOperationGate releases the queue after an operation fails", async () => {
  const selected = [];
  const gate = new NativeOperationGate({
    async selectSpace(spaceId) {
      selected.push(spaceId);
    },
    async ensureSession() {
      throw new Error("not used");
    },
  });

  const failed = gate.withSpace(1, async () => {
    throw new Error("operation failed");
  });
  const recovered = gate.withSpace(2, async () => "recovered");

  await assert.rejects(failed, /operation failed/);
  assert.equal(await recovered, "recovered");
  assert.deepEqual(selected, [1, 2]);
});

test("NativeOperationGate resolves an explicit page session inside the space lock", async () => {
  const log = [];
  let selectedSpace = null;
  const gate = new NativeOperationGate({
    async selectSpace(spaceId) {
      selectedSpace = spaceId;
      log.push(`select:${spaceId}`);
    },
    async ensureSession(targetId) {
      assert.equal(
        selectedSpace,
        7,
        "session attach must run after space selection",
      );
      log.push(`attach:${targetId}`);
      return "session-a";
    },
  });

  const result = await gate.withPage(
    { spaceId: 7, targetId: "target-a" },
    async (page) => {
      log.push(`run:${page.sessionId}`);
      return page;
    },
  );

  assert.deepEqual(result, {
    spaceId: 7,
    targetId: "target-a",
    sessionId: "session-a",
  });
  assert.deepEqual(log, ["select:7", "attach:target-a", "run:session-a"]);
});

test("NativeOperationGate reuses same-space ownership for nested operations", async () => {
  const log = [];
  const gate = new NativeOperationGate({
    async selectSpace(spaceId) {
      log.push(`select:${spaceId}`);
    },
    async ensureSession(targetId) {
      log.push(`attach:${targetId}`);
      return `session:${targetId}`;
    },
  });

  const result = await gate.withSpace(7, () =>
    gate.withPage({ spaceId: 7, targetId: "target-a" }, ({ sessionId }) => {
      log.push(`run:${sessionId}`);
      return "nested";
    }),
  );

  assert.equal(result, "nested");
  assert.deepEqual(log, [
    "select:7",
    "attach:target-a",
    "run:session:target-a",
  ]);
});

test("NativeOperationGate rejects nested selection of another space", async () => {
  const gate = new NativeOperationGate({
    async selectSpace() {},
    async ensureSession() {
      throw new Error("not used");
    },
  });

  await assert.rejects(
    () => gate.withSpace(7, () => gate.withSpace(8, async () => undefined)),
    /cannot select space 8 while space 7 is active/,
  );
  assert.equal(await gate.withSpace(9, async () => "recovered"), "recovered");
});

test("NativeOperationGate forwards the withPage session budget to ensureSession", async () => {
  const budgets = [];
  const gate = new NativeOperationGate({
    async selectSpace() {},
    async ensureSession(targetId, timeoutMs) {
      budgets.push(timeoutMs);
      return `session:${targetId}`;
    },
  });

  await gate.withPage({ spaceId: 7, targetId: "target-a" }, () => "a");
  await gate.withPage({ spaceId: 7, targetId: "target-a" }, () => "b", {
    sessionTimeoutMs: 1_234,
  });

  assert.deepEqual(budgets, [undefined, 1_234]);
});

function recordingGate(log) {
  return new NativeOperationGate({
    async selectSpace(spaceId) {
      log.push(`select:${spaceId}`);
    },
    async ensureSession(targetId) {
      return `session:${targetId}`;
    },
  });
}

/** Start an operation that logs its start and waits until released. */
function held(gate, log, name, spaceId, mode, page) {
  const release = deferred();
  const operation = async () => {
    log.push(`start:${name}`);
    await release.promise;
    log.push(`end:${name}`);
    return name;
  };
  const done = page
    ? gate.withPage({ spaceId, targetId: page }, operation, { mode })
    : gate.withSpace(spaceId, operation, { mode });
  return { done, release: release.resolve };
}

test("shared operations in one space run together and select it once", async () => {
  const log = [];
  const gate = recordingGate(log);
  const a = held(gate, log, "a", 1, "shared", "t-a");
  const b = held(gate, log, "b", 1, "shared", "t-b");
  const c = held(gate, log, "c", 1, "shared");
  await turn();
  await turn();
  assert.equal(log[0], "select:1");
  assert.deepEqual(log.slice(1).sort(), ["start:a", "start:b", "start:c"]);
  a.release();
  b.release();
  c.release();
  assert.deepEqual(await Promise.all([a.done, b.done, c.done]), [
    "a",
    "b",
    "c",
  ]);
});

test("switching spaces waits for every shared holder, and later shared work waits its turn", async () => {
  const log = [];
  const gate = recordingGate(log);
  const a = held(gate, log, "a", 1, "shared");
  const b = held(gate, log, "b", 1, "shared");
  await turn();
  const other = held(gate, log, "other", 2, "shared");
  // Same space as the current lease, but queued behind the switch.
  const late = held(gate, log, "late", 1, "shared");
  await turn();
  assert.deepEqual(log, ["select:1", "start:a", "start:b"]);

  a.release();
  await a.done;
  await turn();
  assert.equal(log.includes("start:other"), false, "b still holds space 1");

  b.release();
  await b.done;
  await turn();
  assert.deepEqual(log.slice(-2), ["select:2", "start:other"]);
  assert.equal(log.includes("start:late"), false);

  other.release();
  await other.done;
  await turn();
  assert.deepEqual(log.slice(-2), ["select:1", "start:late"]);
  late.release();
  await late.done;
});

test("an exclusive operation waits for shared work and holds the space alone", async () => {
  const log = [];
  const gate = recordingGate(log);
  const read = held(gate, log, "read", 1, "shared", "t-a");
  await turn();
  const input = held(gate, log, "input", 1, "exclusive", "t-b");
  const laterRead = held(gate, log, "laterRead", 1, "shared", "t-c");
  await turn();
  assert.deepEqual(log, ["select:1", "start:read"]);

  read.release();
  await read.done;
  await turn();
  await turn();
  assert.deepEqual(log.slice(-2), ["select:1", "start:input"]);
  assert.equal(log.includes("start:laterRead"), false);

  input.release();
  await input.done;
  await turn();
  await turn();
  assert.equal(log.at(-1), "start:laterRead");
  laterRead.release();
  await laterRead.done;
});

test("operations on the same Page run one at a time even when shared", async () => {
  const log = [];
  const gate = recordingGate(log);
  const first = held(gate, log, "first", 1, "shared", "t-a");
  const second = held(gate, log, "second", 1, "shared", "t-a");
  const elsewhere = held(gate, log, "elsewhere", 1, "shared", "t-b");
  await turn();
  await turn();
  assert.deepEqual(log, ["select:1", "start:first", "start:elsewhere"]);

  first.release();
  await first.done;
  await turn();
  await turn();
  assert.equal(log.at(-1), "start:second");
  second.release();
  elsewhere.release();
  await Promise.all([second.done, elsewhere.done]);
});

test("a queued operation that aborts never selects its space", async () => {
  const log = [];
  const gate = recordingGate(log);
  const busy = held(gate, log, "busy", 1, "exclusive");
  await turn();
  const controller = new AbortController();
  const queued = gate.withSpace(
    2,
    async () => {
      log.push("start:queued");
    },
    { mode: "shared", signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(queued, { name: "AbortError" });

  busy.release();
  await busy.done;
  await turn();
  assert.deepEqual(log, ["select:1", "start:busy", "end:busy"]);
});

test("nested Page work inside a shared operation does not wait for itself", async () => {
  const log = [];
  const gate = recordingGate(log);
  const result = await gate.withPage(
    { spaceId: 1, targetId: "t-a" },
    () =>
      gate.withPage(
        { spaceId: 1, targetId: "t-a" },
        ({ sessionId }) => sessionId,
        { mode: "exclusive" },
      ),
    { mode: "shared" },
  );
  assert.equal(result, "session:t-a");
  assert.deepEqual(log, ["select:1"]);
});
