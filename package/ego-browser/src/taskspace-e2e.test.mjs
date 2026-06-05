import test from "node:test";
import assert from "node:assert/strict";

import { runMain } from "../dist/src/run.js";

class FakeEgo {
  constructor(taskSpaces = []) {
    this.taskSpaces = taskSpaces.map((space) => ({ ...space }));
    this.calls = [];
    this.selectedTaskId = null;
  }

  async listTaskSpaces() {
    this.calls.push(["listTaskSpaces"]);
    return { taskSpaces: this.taskSpaces.map((space) => ({ ...space })) };
  }

  useTaskSpace(taskId) {
    this.calls.push(["useTaskSpace", taskId]);
    this.selectedTaskId = taskId;
    return taskId;
  }

  async createTaskSpace(name) {
    this.calls.push(["createTaskSpace", name]);
    if (this.taskSpaces.some((space) => space.taskId === name || space.id === name || space.name === name)) {
      return { error: `Task space already exists: ${name}` };
    }
    const created = { taskId: name, id: name, name, createdBy: "agent", ownership: "agent", recentTabTitles: [] };
    this.taskSpaces.push(created);
    return { ...created };
  }

  async claimTaskSpace(name) {
    this.calls.push(["claimTaskSpace", name]);
    const space = this.taskSpaces.find((candidate) => (
      candidate.taskId === name || candidate.id === name || candidate.name === name
    ));
    if (!space || space.ownership !== "user") {
      return { error: `Task space not found: ${name}` };
    }
    space.createdBy = "agent";
    space.ownership = "agent";
    return { ...space };
  }
}

async function runTaskspaceScript(ego, code) {
  const previous = globalThis.ego;
  globalThis.ego = ego;
  const stdout = captureStream();
  const stderr = captureStream();
  try {
    const exitCode = await runMain({
      argv: [],
      stdinText: code,
      stdout,
      stderr,
      services: { printUpdateBanner() {} }
    });
    return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
  } finally {
    if (previous === undefined) {
      delete globalThis.ego;
    } else {
      globalThis.ego = previous;
    }
  }
}

function captureStream() {
  const chunks = [];
  return {
    write(chunk) {
      chunks.push(String(chunk));
    },
    text() {
      return chunks.join("");
    }
  };
}

function firstJsonLine(output) {
  return JSON.parse(output.trim().split(/\r?\n/)[0]);
}

test("taskspace e2e creates and selects a missing task space", async () => {
  const ego = new FakeEgo();
  const result = await runTaskspaceScript(ego, `
    const task = await useOrCreateTaskSpace("checkout-flow");
    cliLog(JSON.stringify({ task, selected: ego.selectedTaskId }));
  `);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(firstJsonLine(result.stdout), {
    task: {
      taskId: "checkout-flow",
      id: "checkout-flow",
      name: "checkout-flow",
      createdBy: "agent",
      ownership: "agent",
      recentTabTitles: []
    },
    selected: "checkout-flow"
  });
  assert.deepEqual(ego.calls, [
    ["listTaskSpaces"],
    ["createTaskSpace", "checkout-flow"],
    ["useTaskSpace", "checkout-flow"]
  ]);
});

test("taskspace e2e reuses an existing agent-owned task space", async () => {
  const ego = new FakeEgo([
    { taskId: "checkout-flow", id: 7, name: "Checkout flow", createdBy: "agent", ownership: "agent" }
  ]);
  const result = await runTaskspaceScript(ego, `
    const task = await useOrCreateTaskSpace(7);
    cliLog(JSON.stringify({ task, selected: ego.selectedTaskId }));
  `);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(firstJsonLine(result.stdout), {
    task: { taskId: "checkout-flow", id: 7, name: "Checkout flow", createdBy: "agent", ownership: "agent" },
    selected: "checkout-flow"
  });
  assert.deepEqual(ego.calls, [
    ["listTaskSpaces"],
    ["useTaskSpace", "checkout-flow"]
  ]);
});

test("taskspace e2e claims and selects an existing user-owned task space", async () => {
  const ego = new FakeEgo([
    { taskId: "checkout-flow", id: "checkout-flow", name: "checkout-flow", createdBy: "user", ownership: "user" }
  ]);
  const result = await runTaskspaceScript(ego, `
    const task = await useOrCreateTaskSpace("checkout-flow");
    cliLog(JSON.stringify({ task, selected: ego.selectedTaskId }));
  `);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(firstJsonLine(result.stdout), {
    task: { taskId: "checkout-flow", id: "checkout-flow", name: "checkout-flow", createdBy: "agent", ownership: "agent" },
    selected: "checkout-flow"
  });
  assert.deepEqual(ego.calls, [
    ["listTaskSpaces"],
    ["claimTaskSpace", "checkout-flow"],
    ["useTaskSpace", "checkout-flow"]
  ]);
});

test("taskspace e2e exposes newTaskSpace but not claimTaskSpace as a helper", async () => {
  const ego = new FakeEgo();
  const result = await runTaskspaceScript(ego, `
    cliLog(JSON.stringify({
      newType: typeof newTaskSpace,
      switchType: typeof switchTaskSpace,
      claimType: typeof claimTaskSpace,
      rawClaimType: typeof ego.claimTaskSpace
    }));
  `);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(firstJsonLine(result.stdout), {
    newType: "function",
    switchType: "function",
    claimType: "undefined",
    rawClaimType: "function"
  });
});

test("taskspace e2e rejects explicit use of a user-owned task space", async () => {
  const ego = new FakeEgo([
    { taskId: "checkout-flow", id: "checkout-flow", name: "checkout-flow", createdBy: "user", ownership: "user" }
  ]);

  await assert.rejects(
    () => runTaskspaceScript(ego, `await switchTaskSpace("checkout-flow")`),
    /switchTaskSpace requires an agent-owned task space/
  );
  assert.deepEqual(ego.calls, [["listTaskSpaces"]]);
});

test("taskspace e2e rejects unknown task space ownership", async () => {
  const ego = new FakeEgo([
    { taskId: "checkout-flow", id: "checkout-flow", name: "checkout-flow", ownership: "shared" }
  ]);

  await assert.rejects(
    () => runTaskspaceScript(ego, `await useOrCreateTaskSpace("checkout-flow")`),
    /ownership "shared"/
  );
  assert.deepEqual(ego.calls, [["listTaskSpaces"]]);
});

test("taskspace e2e surfaces newTaskSpace binding errors", async () => {
  const ego = new FakeEgo([
    { taskId: "checkout-flow", id: "checkout-flow", name: "checkout-flow", ownership: "agent" }
  ]);

  await assert.rejects(
    () => runTaskspaceScript(ego, `await newTaskSpace("checkout-flow")`),
    /newTaskSpace: Task space already exists: checkout-flow/
  );
  assert.deepEqual(ego.calls, [["createTaskSpace", "checkout-flow"]]);
});
