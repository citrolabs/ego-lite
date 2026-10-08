import test from "node:test";
import assert from "node:assert/strict";

import { runMain } from "../dist/src/run.js";

class FakeEgo {
  constructor(taskSpaces = []) {
    this.taskSpaces = taskSpaces.map((space) => ({ ...space }));
    this.calls = [];
    this.selectedId = null;
    this.nextId =
      Math.max(
        0,
        ...this.taskSpaces.map((space) =>
          typeof space.id === "number" ? space.id : 0,
        ),
      ) + 1;
  }

  async listTaskSpaces() {
    this.calls.push(["listTaskSpaces"]);
    return { taskSpaces: this.taskSpaces.map((space) => ({ ...space })) };
  }

  useTaskSpace(id) {
    if (typeof id !== "number") {
      throw new TypeError("useTaskSpace requires numeric id");
    }
    this.calls.push(["useTaskSpace", id]);
    const space = this.taskSpaces.find((candidate) => candidate.id === id);
    if (space && space.ownership === "user") {
      return {
        error: "The task is under user control",
        error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
      };
    }
    this.selectedId = id;
    return id;
  }

  async createTaskSpace(name) {
    this.calls.push(["createTaskSpace", name]);
    if (
      this.taskSpaces.some(
        (space) => space.taskId === name || space.name === name,
      )
    ) {
      return { error: `Task space already exists: ${name}` };
    }
    const created = {
      taskId: name,
      id: this.nextId++,
      name,
      createdBy: "agent",
      ownership: "agent",
      recentTabTitles: [],
    };
    this.taskSpaces.push(created);
    return { ...created };
  }

  async claimTaskSpace(id, name) {
    if (typeof id !== "number") {
      throw new TypeError("claimTaskSpace requires numeric id");
    }
    this.calls.push(["claimTaskSpace", id, name]);
    const space = this.taskSpaces.find((candidate) => candidate.id === id);
    if (!space || space.ownership !== "user") {
      return { error: `Task space not found: ${id}` };
    }
    if (name !== undefined) {
      space.name = name;
      space.taskId = name;
    }
    space.createdBy = "agent";
    space.ownership = "agent";
    return { ...space };
  }

  async listTabs() {
    this.calls.push(["listTabs"]);
    return { tabs: [] };
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
    },
  };
}

function firstJsonLine(output) {
  return JSON.parse(output.trim().split(/\r?\n/)[0]);
}

test("taskspace e2e creates and selects a missing task space", async () => {
  const ego = new FakeEgo();
  const result = await runTaskspaceScript(
    ego,
    `
    const task = await useOrCreateTaskSpace("checkout-flow");
    cliLog(JSON.stringify({ task, selected: ego.selectedId }));
  `,
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(firstJsonLine(result.stdout), {
    task: {
      taskId: "checkout-flow",
      id: 1,
      name: "checkout-flow",
      createdBy: "agent",
      ownership: "agent",
      recentTabTitles: [],
    },
    selected: 1,
  });
  assert.deepEqual(ego.calls, [
    ["listTaskSpaces"],
    ["createTaskSpace", "checkout-flow"],
    ["useTaskSpace", 1],
  ]);
});

test("taskspace e2e reuses an existing agent-owned task space", async () => {
  const ego = new FakeEgo([
    {
      taskId: "checkout-flow",
      id: 7,
      name: "Checkout flow",
      createdBy: "agent",
      ownership: "agent",
    },
  ]);
  const result = await runTaskspaceScript(
    ego,
    `
    const task = await useOrCreateTaskSpace(7);
    cliLog(JSON.stringify({ task, selected: ego.selectedId }));
  `,
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(firstJsonLine(result.stdout), {
    task: {
      taskId: "checkout-flow",
      id: 7,
      name: "Checkout flow",
      createdBy: "agent",
      ownership: "agent",
    },
    selected: 7,
  });
  assert.deepEqual(ego.calls, [["listTaskSpaces"], ["useTaskSpace", 7]]);
});

test("taskspace e2e claims and selects an existing user-owned task space", async () => {
  const ego = new FakeEgo([
    {
      taskId: "checkout-flow",
      id: 7,
      name: "checkout-flow",
      createdBy: "user",
      ownership: "user",
    },
  ]);
  const result = await runTaskspaceScript(
    ego,
    `
    const task = await claimTaskSpace("checkout-flow");
    cliLog(JSON.stringify({ task, selected: ego.selectedId }));
  `,
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(firstJsonLine(result.stdout), {
    task: {
      taskId: "checkout-flow",
      id: 7,
      name: "checkout-flow",
      createdBy: "agent",
      ownership: "agent",
    },
    selected: 7,
  });
  assert.deepEqual(ego.calls, [
    ["listTaskSpaces"],
    ["claimTaskSpace", 7, "checkout-flow"],
    ["useTaskSpace", 7],
    ["useTaskSpace", 7],
    ["listTabs"],
  ]);
});

test("taskspace e2e useOrCreateTaskSpace selects user-owned spaces without claiming and surfaces the owned user-control guidance", async () => {
  const ego = new FakeEgo([
    {
      taskId: "checkout-flow",
      id: 7,
      name: "checkout-flow",
      createdBy: "user",
      ownership: "user",
    },
  ]);

  // Native rejects with error_code EGO_TASK_SPACE_USER_IN_CONTROL, so the agent
  // sees ego-browser's owned guidance block, not the raw native text.
  await assert.rejects(
    () =>
      runTaskspaceScript(ego, `await useOrCreateTaskSpace("checkout-flow")`),
    /has taken control of this task space/,
  );
  assert.deepEqual(ego.calls, [["listTaskSpaces"], ["useTaskSpace", 7]]);
});

test("taskspace e2e exposes newTaskSpace and claimTaskSpace as helpers", async () => {
  const ego = new FakeEgo();
  const result = await runTaskspaceScript(
    ego,
    `
    cliLog(JSON.stringify({
      newType: typeof newTaskSpace,
      switchType: typeof switchTaskSpace,
      claimType: typeof claimTaskSpace,
      rawClaimType: typeof ego.claimTaskSpace
    }));
  `,
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(firstJsonLine(result.stdout), {
    newType: "function",
    switchType: "function",
    claimType: "function",
    rawClaimType: "function",
  });
});

test("cli e2e exposes the unified helperContext surface (help present, internals hidden)", async () => {
  const ego = new FakeEgo();
  const result = await runTaskspaceScript(
    ego,
    `
    cliLog(JSON.stringify({
      helpType: typeof help,
      publicHelp: help("TaskSpace.newPage"),
      legacyHint: help("click"),
      newTabType: typeof newTab,
      helperContextType: typeof helperContext,
      loadAgentHelpersType: typeof loadAgentHelpers
    }));
  `,
  );

  assert.equal(result.exitCode, 0);
  const lines = result.stdout.trim().split(/\r?\n/);
  assert.deepEqual(lines.slice(0, -1), [
    "TaskSpace.newPage",
    "",
    "Create and durably label a blank Page.",
    "",
    "await task.newPage()",
    'Legacy helper hidden from default help: click. Use help("legacy", "click").',
  ]);
  assert.deepEqual(JSON.parse(lines.at(-1)), {
    helpType: "function",
    publicHelp:
      "TaskSpace.newPage\n\nCreate and durably label a blank Page.\n\nawait task.newPage()",
    legacyHint:
      'Legacy helper hidden from default help: click. Use help("legacy", "click").',
    newTabType: "undefined",
    helperContextType: "undefined",
    loadAgentHelpersType: "undefined",
  });
});

test("taskspace e2e rejects explicit use of a user-owned task space", async () => {
  const ego = new FakeEgo([
    {
      taskId: "checkout-flow",
      id: 7,
      name: "checkout-flow",
      createdBy: "user",
      ownership: "user",
    },
  ]);

  await assert.rejects(
    () => runTaskspaceScript(ego, `await switchTaskSpace("checkout-flow")`),
    /switchTaskSpace requires an agent-owned task space/,
  );
  assert.deepEqual(ego.calls, [["listTaskSpaces"]]);
});

test("taskspace e2e rejects unknown task space ownership", async () => {
  const ego = new FakeEgo([
    {
      taskId: "checkout-flow",
      id: 7,
      name: "checkout-flow",
      ownership: "shared",
    },
  ]);

  await assert.rejects(
    () =>
      runTaskspaceScript(ego, `await useOrCreateTaskSpace("checkout-flow")`),
    /ownership "shared"/,
  );
  assert.deepEqual(ego.calls, [["listTaskSpaces"]]);
});

test("taskspace e2e surfaces newTaskSpace binding errors", async () => {
  const ego = new FakeEgo([
    {
      taskId: "checkout-flow",
      id: 7,
      name: "checkout-flow",
      ownership: "agent",
    },
  ]);

  await assert.rejects(
    () => runTaskspaceScript(ego, `await newTaskSpace("checkout-flow")`),
    /newTaskSpace: Task space already exists: checkout-flow/,
  );
  assert.deepEqual(ego.calls, [["createTaskSpace", "checkout-flow"]]);
});
