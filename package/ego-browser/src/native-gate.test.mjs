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
