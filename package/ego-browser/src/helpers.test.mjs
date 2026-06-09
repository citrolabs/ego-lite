import test from "node:test";
import assert from "node:assert/strict";

import {
  completeTaskSpace,
  handOffTaskSpace,
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
  assert.deepEqual(calls, [["useTaskSpace", 7]]);
});

test("switchTaskSpace rejects non-agent-owned task spaces", async () => {
  await withEgo({
    async listTaskSpaces() {
      return {
        taskSpaces: [
          { taskId: "checkout-flow", id: 7, name: "checkout-flow", ownership: "user" }
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

test("switchTaskSpace awaits useTaskSpace binding errors", async () => {
  await withEgo({
    async listTaskSpaces() {
      return {
        taskSpaces: [
          { taskId: "checkout-flow", id: 7, name: "checkout-flow", ownership: "agent" }
        ]
      };
    },
    async useTaskSpace() {
      return { error: "Task space not selected" };
    }
  }, async () => {
    await assert.rejects(
      () => switchTaskSpace("checkout-flow"),
      /switchTaskSpace: Task space not selected/
    );
  });
});

test("newTaskSpace creates and selects an agent task space", async () => {
  const calls = [];
  await withEgo({
    async createTaskSpace(name) {
      calls.push(["createTaskSpace", name]);
      return { taskId: name, id: 7, name, ownership: "agent" };
    },
    useTaskSpace(taskId) {
      calls.push(["useTaskSpace", taskId]);
      return taskId;
    }
  }, async () => {
    assert.deepEqual(await newTaskSpace("checkout-flow"), {
      taskId: "checkout-flow",
      id: 7,
      name: "checkout-flow",
      ownership: "agent"
    });
  });
  assert.deepEqual(calls, [
    ["createTaskSpace", "checkout-flow"],
    ["useTaskSpace", 7]
  ]);
});

test("newTaskSpace rejects results without a numeric id", async () => {
  const calls = [];
  await withEgo({
    async createTaskSpace(name) {
      calls.push(["createTaskSpace", name]);
      return { taskId: name, id: name, name };
    },
    async listTaskSpaces() {
      calls.push(["listTaskSpaces"]);
      return {
        taskSpaces: [
          { taskId: "checkout-flow", id: 7, name: "checkout-flow", ownership: "agent" }
        ]
      };
    },
    useTaskSpace(id) {
      calls.push(["useTaskSpace", id]);
    }
  }, async () => {
    await assert.rejects(
      () => newTaskSpace("checkout-flow"),
      /newTaskSpace requires a numeric task space id/
    );
  });
  assert.deepEqual(calls, [["createTaskSpace", "checkout-flow"]]);
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
          { taskId: "checkout-flow", id: 7, name: "checkout-flow", ownership: "agent" }
        ]
      };
    },
    useTaskSpace(taskId) {
      calls.push(["useTaskSpace", taskId]);
      return taskId;
    },
    async createTaskSpace(name) {
      calls.push(["createTaskSpace", name]);
      return { taskId: name, id: 8, name, ownership: "agent" };
    },
    async claimTaskSpace(id, name) {
      calls.push(["claimTaskSpace", id, name]);
      return { taskId: name, id, name, ownership: "agent" };
    }
  }, async () => {
    assert.deepEqual(await useOrCreateTaskSpace("checkout-flow"), {
      taskId: "checkout-flow",
      id: 7,
      name: "checkout-flow",
      ownership: "agent"
    });
  });
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["useTaskSpace", 7]
  ]);
});

test("useOrCreateTaskSpace claims existing user-owned spaces", async () => {
  const calls = [];
  await withEgo({
    async listTaskSpaces() {
      calls.push(["listTaskSpaces"]);
      return {
        taskSpaces: [
          { taskId: "checkout-flow", id: 7, name: "checkout-flow", ownership: "user" }
        ]
      };
    },
    async claimTaskSpace(id, name) {
      calls.push(["claimTaskSpace", id, name]);
      return { taskId: name, id, name, ownership: "agent" };
    },
    useTaskSpace(taskId) {
      calls.push(["useTaskSpace", taskId]);
      return taskId;
    }
  }, async () => {
    assert.deepEqual(await useOrCreateTaskSpace("checkout-flow"), {
      taskId: "checkout-flow",
      id: 7,
      name: "checkout-flow",
      ownership: "agent"
    });
  });
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["claimTaskSpace", 7, "checkout-flow"],
    ["useTaskSpace", 7]
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
      return { taskId: name, id: 7, name, ownership: "agent" };
    },
    useTaskSpace(taskId) {
      calls.push(["useTaskSpace", taskId]);
      return taskId;
    }
  }, async () => {
    assert.deepEqual(await useOrCreateTaskSpace("checkout-flow"), {
      taskId: "checkout-flow",
      id: 7,
      name: "checkout-flow",
      ownership: "agent"
    });
  });
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["createTaskSpace", "checkout-flow"],
    ["useTaskSpace", 7]
  ]);
});

test("useOrCreateTaskSpace resolves string names before numeric id strings", async () => {
  const calls = [];
  await withEgo({
    async listTaskSpaces() {
      calls.push(["listTaskSpaces"]);
      return {
        taskSpaces: [
          { taskId: "plain-seven", id: 7, name: "plain-seven", ownership: "agent" },
          { taskId: "7", id: 8, name: "7", ownership: "agent" }
        ]
      };
    },
    useTaskSpace(id) {
      calls.push(["useTaskSpace", id]);
      return id;
    }
  }, async () => {
    assert.deepEqual(await useOrCreateTaskSpace("7"), {
      taskId: "7",
      id: 8,
      name: "7",
      ownership: "agent"
    });
  });
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["useTaskSpace", 8]
  ]);
});

test("useOrCreateTaskSpace rejects missing numeric ids instead of creating", async () => {
  const calls = [];
  await withEgo({
    async listTaskSpaces() {
      calls.push(["listTaskSpaces"]);
      return { taskSpaces: [] };
    },
    async createTaskSpace(name) {
      calls.push(["createTaskSpace", name]);
      return { taskId: String(name), id: 7, name: String(name), ownership: "agent" };
    }
  }, async () => {
    await assert.rejects(
      () => useOrCreateTaskSpace(7),
      /task space not found: 7/
    );
  });
  assert.deepEqual(calls, [["listTaskSpaces"]]);
});

test("completeTaskSpace selects by numeric id before completing", async () => {
  const calls = [];
  await withEgo({
    async listTaskSpaces() {
      calls.push(["listTaskSpaces"]);
      return {
        taskSpaces: [
          { taskId: "checkout-flow", id: 7, name: "checkout-flow", ownership: "agent" }
        ]
      };
    },
    useTaskSpace(id) {
      calls.push(["useTaskSpace", id]);
      return id;
    },
    async completeTaskSpace() {
      calls.push(["completeTaskSpace"]);
      return "7 task space completed.";
    }
  }, async () => {
    await completeTaskSpace("checkout-flow", { keep: true });
  });
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["useTaskSpace", 7],
    ["completeTaskSpace"]
  ]);
});

test("completeTaskSpace waits for async useTaskSpace before completing", async () => {
  const calls = [];
  await withEgo({
    async listTaskSpaces() {
      calls.push(["listTaskSpaces"]);
      return {
        taskSpaces: [
          { taskId: "checkout-flow", id: 7, name: "checkout-flow", ownership: "agent" }
        ]
      };
    },
    async useTaskSpace(id) {
      calls.push(["useTaskSpace:start", id]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      calls.push(["useTaskSpace:end", id]);
    },
    async completeTaskSpace() {
      calls.push(["completeTaskSpace"]);
      return "7 task space completed.";
    }
  }, async () => {
    await completeTaskSpace("checkout-flow", { keep: true });
  });
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["useTaskSpace:start", 7],
    ["useTaskSpace:end", 7],
    ["completeTaskSpace"]
  ]);
});

test("completeTaskSpace claims user-owned spaces before closing", async () => {
  const calls = [];
  await withEgo({
    async listTaskSpaces() {
      calls.push(["listTaskSpaces"]);
      return {
        taskSpaces: [
          { taskId: "checkout-flow", id: 7, name: "checkout-flow", ownership: "user" }
        ]
      };
    },
    async claimTaskSpace(id, name) {
      calls.push(["claimTaskSpace", id, name]);
      return { taskId: name, id, name, ownership: "agent" };
    },
    async useTaskSpace(id) {
      calls.push(["useTaskSpace", id]);
      return id;
    },
    async closeTaskSpace() {
      calls.push(["closeTaskSpace"]);
      return "7 task space closed.";
    }
  }, async () => {
    await completeTaskSpace("checkout-flow", { keep: false });
  });
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["claimTaskSpace", 7, "checkout-flow"],
    ["useTaskSpace", 7],
    ["closeTaskSpace"]
  ]);
});

test("completeTaskSpace keep true is a no-op for user-owned spaces", async () => {
  const calls = [];
  await withEgo({
    async listTaskSpaces() {
      calls.push(["listTaskSpaces"]);
      return {
        taskSpaces: [
          { taskId: "checkout-flow", id: 7, name: "checkout-flow", ownership: "user" }
        ]
      };
    },
    async completeTaskSpace() {
      calls.push(["completeTaskSpace"]);
    }
  }, async () => {
    await completeTaskSpace("checkout-flow", { keep: true });
  });
  assert.deepEqual(calls, [
    ["listTaskSpaces"]
  ]);
});

test("handOffTaskSpace is a no-op for user-owned spaces", async () => {
  const calls = [];
  await withEgo({
    async listTaskSpaces() {
      calls.push(["listTaskSpaces"]);
      return {
        taskSpaces: [
          { taskId: "checkout-flow", id: 7, name: "checkout-flow", ownership: "user" }
        ]
      };
    },
    async handOffTaskSpace() {
      calls.push(["handOffTaskSpace"]);
    }
  }, async () => {
    await handOffTaskSpace("checkout-flow");
  });
  assert.deepEqual(calls, [
    ["listTaskSpaces"]
  ]);
});

test("useOrCreateTaskSpace rejects unknown ownership", async () => {
  await withEgo({
    async listTaskSpaces() {
      return {
        taskSpaces: [
          { taskId: "checkout-flow", id: 7, name: "checkout-flow", ownership: "shared" }
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
