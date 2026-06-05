import test from "node:test";
import assert from "node:assert/strict";

import {
  newTaskSpace,
  helperContext,
  listTaskSpaces,
  useOrCreateTaskSpace,
  switchTaskSpace
} from "../dist/src/helpers.js";

function withEgo(ego, fn) {
  const previous = globalThis.ego;
  globalThis.ego = ego;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previous === undefined) {
        delete globalThis.ego;
      } else {
        globalThis.ego = previous;
      }
    });
}

test("listTaskSpaces normalizes the current taskSpaces binding shape", async () => {
  await withEgo({
    async listTaskSpaces() {
      return {
        taskSpaces: [
          {
            taskId: "checkout-flow",
            id: 7,
            name: "Checkout flow",
            createdBy: "agent",
            ownership: "agent",
            recentTabTitles: ["Checkout", "Cart"]
          }
        ]
      };
    }
  }, async () => {
    assert.deepEqual(await listTaskSpaces(), [
      {
        taskId: "checkout-flow",
        id: 7,
        name: "Checkout flow",
        createdBy: "agent",
        ownership: "agent",
        recentTabTitles: ["Checkout", "Cart"]
      }
    ]);
  });
});

test("listTaskSpaces rejects legacy taskIds results", async () => {
  await withEgo({
    async listTaskSpaces() {
      return { taskIds: ["checkout-flow", "research-session"] };
    }
  }, async () => {
    await assert.rejects(
      () => listTaskSpaces(),
      /listTaskSpaces expected \{ taskSpaces: \[\.\.\.\] \}/
    );
  });
});

test("listTaskSpaces throws on binding error objects", async () => {
  await withEgo({
    async listTaskSpaces() {
      return { error: "The task is under user control" };
    }
  }, async () => {
    await assert.rejects(
      () => listTaskSpaces(),
      /listTaskSpaces: The task is under user control/
    );
  });
});

test("taskspace helper surface exposes public helpers without claimTaskSpace", () => {
  const context = helperContext();
  assert.equal(typeof context.listTaskSpaces, "function");
  assert.equal(typeof context.switchTaskSpace, "function");
  assert.equal(typeof context.newTaskSpace, "function");
  assert.equal(typeof context.useOrCreateTaskSpace, "function");
  assert.equal(context.claimTaskSpace, undefined);
});

test("switchTaskSpace selects a matching task space", async () => {
  const calls = [];
  await withEgo({
    async listTaskSpaces() {
      return {
        taskSpaces: [
          { taskId: "checkout-flow", id: 7, name: "Checkout flow", ownership: "agent" }
        ]
      };
    },
    useTaskSpace(taskId) {
      calls.push(["useTaskSpace", taskId]);
      return taskId;
    }
  }, async () => {
    assert.deepEqual(await switchTaskSpace(7), {
      taskId: "checkout-flow",
      id: 7,
      name: "Checkout flow",
      ownership: "agent"
    });
  });
  assert.deepEqual(calls, [["useTaskSpace", "checkout-flow"]]);
});

test("switchTaskSpace rejects non-agent-owned task spaces", async () => {
  await withEgo({
    async listTaskSpaces() {
      return {
        taskSpaces: [
          { taskId: "checkout-flow", id: "checkout-flow", name: "checkout-flow", ownership: "user" }
        ]
      };
    },
    useTaskSpace() {}
  }, async () => {
    await assert.rejects(
      () => switchTaskSpace("checkout-flow"),
      /switchTaskSpace requires an agent-owned task space/
    );
  });
});

test("newTaskSpace creates and selects an agent task space", async () => {
  const calls = [];
  await withEgo({
    async createTaskSpace(name) {
      calls.push(["createTaskSpace", name]);
      return { taskId: name, id: name, name, ownership: "agent" };
    },
    useTaskSpace(taskId) {
      calls.push(["useTaskSpace", taskId]);
      return taskId;
    }
  }, async () => {
    assert.deepEqual(await newTaskSpace("checkout-flow"), {
      taskId: "checkout-flow",
      id: "checkout-flow",
      name: "checkout-flow",
      ownership: "agent"
    });
  });
  assert.deepEqual(calls, [
    ["createTaskSpace", "checkout-flow"],
    ["useTaskSpace", "checkout-flow"]
  ]);
});

test("newTaskSpace throws on binding error objects", async () => {
  await withEgo({
    async createTaskSpace() {
      return { error: "Task space already exists: checkout-flow" };
    },
    useTaskSpace() {}
  }, async () => {
    await assert.rejects(
      () => newTaskSpace("checkout-flow"),
      /newTaskSpace: Task space already exists: checkout-flow/
    );
  });
});

test("useOrCreateTaskSpace reuses existing agent-owned spaces", async () => {
  const calls = [];
  await withEgo({
    async listTaskSpaces() {
      calls.push(["listTaskSpaces"]);
      return {
        taskSpaces: [
          { taskId: "checkout-flow", id: "checkout-flow", name: "checkout-flow", ownership: "agent" }
        ]
      };
    },
    useTaskSpace(taskId) {
      calls.push(["useTaskSpace", taskId]);
      return taskId;
    },
    async createTaskSpace(name) {
      calls.push(["createTaskSpace", name]);
      return { taskId: name, id: name, name, ownership: "agent" };
    },
    async claimTaskSpace(name) {
      calls.push(["claimTaskSpace", name]);
      return { taskId: name, id: name, name, ownership: "agent" };
    }
  }, async () => {
    assert.deepEqual(await useOrCreateTaskSpace("checkout-flow"), {
      taskId: "checkout-flow",
      id: "checkout-flow",
      name: "checkout-flow",
      ownership: "agent"
    });
  });
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["useTaskSpace", "checkout-flow"]
  ]);
});

test("useOrCreateTaskSpace claims existing user-owned spaces", async () => {
  const calls = [];
  await withEgo({
    async listTaskSpaces() {
      calls.push(["listTaskSpaces"]);
      return {
        taskSpaces: [
          { taskId: "checkout-flow", id: "checkout-flow", name: "checkout-flow", ownership: "user" }
        ]
      };
    },
    async claimTaskSpace(name) {
      calls.push(["claimTaskSpace", name]);
      return { taskId: name, id: name, name, ownership: "agent" };
    },
    useTaskSpace(taskId) {
      calls.push(["useTaskSpace", taskId]);
      return taskId;
    }
  }, async () => {
    assert.deepEqual(await useOrCreateTaskSpace("checkout-flow"), {
      taskId: "checkout-flow",
      id: "checkout-flow",
      name: "checkout-flow",
      ownership: "agent"
    });
  });
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["claimTaskSpace", "checkout-flow"],
    ["useTaskSpace", "checkout-flow"]
  ]);
});

test("useOrCreateTaskSpace creates missing spaces", async () => {
  const calls = [];
  await withEgo({
    async listTaskSpaces() {
      calls.push(["listTaskSpaces"]);
      return { taskSpaces: [] };
    },
    async createTaskSpace(name) {
      calls.push(["createTaskSpace", name]);
      return { taskId: name, id: name, name, ownership: "agent" };
    },
    useTaskSpace(taskId) {
      calls.push(["useTaskSpace", taskId]);
      return taskId;
    }
  }, async () => {
    assert.deepEqual(await useOrCreateTaskSpace("checkout-flow"), {
      taskId: "checkout-flow",
      id: "checkout-flow",
      name: "checkout-flow",
      ownership: "agent"
    });
  });
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["createTaskSpace", "checkout-flow"],
    ["useTaskSpace", "checkout-flow"]
  ]);
});

test("useOrCreateTaskSpace rejects unknown ownership", async () => {
  await withEgo({
    async listTaskSpaces() {
      return {
        taskSpaces: [
          { taskId: "checkout-flow", id: "checkout-flow", name: "checkout-flow", ownership: "shared" }
        ]
      };
    }
  }, async () => {
    await assert.rejects(
      () => useOrCreateTaskSpace("checkout-flow"),
      /ownership "shared"/
    );
  });
});
