import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as helperExports from "../dist/src/helpers.js";
import {
  claimTaskSpace,
  completeTaskSpace,
  handOffTaskSpace,
  newTaskSpace,
  helperContext,
  listTaskSpaces,
  profiles,
  taskSpace,
  useOrCreateTaskSpace,
  switchTaskSpace,
  takeOverTaskSpace,
  waitForAgentControl,
} from "../dist/src/helpers.js";

const previousStateDir = process.env.EGO_BROWSER_STATE_DIR;
const stateDir = await mkdtemp(join(tmpdir(), "ego-browser-helpers-"));
process.env.EGO_BROWSER_STATE_DIR = stateDir;

test.after(async () => {
  if (previousStateDir === undefined) {
    delete process.env.EGO_BROWSER_STATE_DIR;
  } else {
    process.env.EGO_BROWSER_STATE_DIR = previousStateDir;
  }
  await rm(stateDir, { recursive: true, force: true });
});

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
  await withEgo(
    {
      async listTaskSpaces() {
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "Checkout flow",
              createdBy: "agent",
              ownership: "agent",
              recentTabTitles: ["Checkout", "Cart"],
            },
          ],
        };
      },
    },
    async () => {
      assert.deepEqual(await listTaskSpaces(), [
        {
          taskId: "checkout-flow",
          id: 7,
          name: "Checkout flow",
          createdBy: "agent",
          ownership: "agent",
          recentTabTitles: ["Checkout", "Cart"],
        },
      ]);
    },
  );
});

test("listTaskSpaces preserves claimable user-created space metadata", async () => {
  const userSpace = {
    taskId: "research",
    id: 3,
    name: "research",
    createdBy: "user",
    ownership: "user",
    profileId: "Default",
    profileName: "Work",
    recentTabTitles: ["Project notes", "Reference"],
  };
  await withEgo(
    {
      async listTaskSpaces() {
        return { taskSpaces: [userSpace] };
      },
    },
    async () => {
      assert.deepEqual(await listTaskSpaces(), [userSpace]);
    },
  );
});

test("listTaskSpaces rejects legacy taskIds results", async () => {
  await withEgo(
    {
      async listTaskSpaces() {
        return { taskIds: ["checkout-flow", "research-session"] };
      },
    },
    async () => {
      await assert.rejects(
        () => listTaskSpaces(),
        /listTaskSpaces expected \{ taskSpaces: \[\.\.\.\] \}/,
      );
    },
  );
});

test("listTaskSpaces throws on binding error objects", async () => {
  await withEgo(
    {
      async listTaskSpaces() {
        return { error: "The task is under user control" };
      },
    },
    async () => {
      await assert.rejects(
        () => listTaskSpaces(),
        /listTaskSpaces: The task is under user control/,
      );
    },
  );
});

test("profiles returns the browser profiles exposed by Ego Lite", async () => {
  const expected = [
    { id: "Default", name: "Personal", isDefault: true },
    { id: "Profile 2", name: "Work", isDefault: false },
  ];
  await withEgo(
    {
      async listProfiles() {
        return { profiles: expected };
      },
    },
    async () => {
      assert.deepEqual(await profiles(), expected);
    },
  );
});

test("profiles rejects malformed native results", async () => {
  await withEgo(
    {
      async listProfiles() {
        return { profiles: [{ id: "Default", name: "Personal" }] };
      },
    },
    async () => {
      await assert.rejects(
        () => profiles(),
        /profiles expected entries with id, name, and isDefault/,
      );
    },
  );
});

test("taskspace helper surface exposes public helpers including claimTaskSpace", () => {
  const context = helperContext();
  assert.equal(typeof context.taskSpace, "function");
  assert.equal(typeof context.profiles, "function");
  assert.equal(typeof context.listTaskSpaces, "function");
  assert.equal(typeof context.switchTaskSpace, "function");
  assert.equal(typeof context.newTaskSpace, "function");
  assert.equal(typeof context.useOrCreateTaskSpace, "function");
  assert.equal(typeof context.claimTaskSpace, "function");
  assert.equal(typeof helperExports.openOrReuseTab, "function");
  assert.equal(typeof context.openOrReuseTab, "function");
  assert.equal(typeof helperExports.closeTab, "function");
  assert.equal(typeof context.closeTab, "function");
  assert.equal("newTab" in helperExports, false);
  assert.equal("newTab" in context, false);
  assert.equal("elementEval" in helperExports, false);
  assert.equal("elementEval" in context, false);
});

test("taskSpace returns the new object model for a resolved space", async () => {
  await withEgo(
    {
      async listTaskSpaces() {
        return {
          taskSpaces: [
            {
              taskId: "research",
              id: 7,
              name: "Research",
              ownership: "agent",
            },
          ],
        };
      },
      async useTaskSpace() {},
    },
    async () => {
      const task = await taskSpace("research");
      assert.equal(task.id, 7);
      assert.equal(task.spaceId, 7);
      assert.equal(task.name, "Research");
      assert.equal(task.ownership, "agent");
      assert.equal(typeof task.newPage, "function");
      assert.equal(task.openPage, undefined);
      assert.equal(typeof task.page, "function");
      assert.equal(typeof task.pages, "function");
      assert.equal(typeof task.tabs, "function");
      assert.equal(task.listPages, undefined);
      assert.equal(typeof task.adopt, "function");
      assert.equal(typeof task.release, "function");
      assert.equal(typeof task.handOff, "function");
      assert.equal(typeof task.finish, "function");
      assert.equal(typeof task.close, "function");
    },
  );
});

test("taskSpace creates a new space with an explicit browser profile", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return { taskSpaces: [] };
      },
      async createTaskSpace(name, profileId) {
        calls.push(["createTaskSpace", name, profileId]);
        return { taskId: name, id: 8, name };
      },
      useTaskSpace(id) {
        calls.push(["useTaskSpace", id]);
        return id;
      },
      async listTabs() {
        calls.push(["listTabs"]);
        return { tabs: [{ targetId: "target-profile-initial" }] };
      },
    },
    async () => {
      const task = await taskSpace("work research", { profileId: "Profile 2" });
      assert.equal(task.spaceId, 8);
      assert.equal(task.name, "work research");
    },
  );
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["createTaskSpace", "work research", "Profile 2"],
    ["useTaskSpace", 8],
    ["listTabs"],
  ]);
});

test("taskSpace manages a newly created space's default tab as p1", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return { taskSpaces: [] };
      },
      async createTaskSpace(name) {
        calls.push(["createTaskSpace", name]);
        return { taskId: name, id: 9, name };
      },
      async useTaskSpace(id) {
        calls.push(["useTaskSpace", id]);
      },
      async listTabs() {
        calls.push(["listTabs"]);
        return {
          tabs: [
            {
              targetId: "target-initial",
              url: "chrome://newtab/",
              title: "New Tab",
              active: true,
            },
          ],
        };
      },
    },
    async () => {
      const task = await taskSpace("fresh research");
      const pages = await task.pages();
      assert.equal(pages.length, 1);
      assert.equal(pages[0].label, "p1");
      assert.equal(pages[0].targetId, "target-initial");
      assert.equal(pages[0].openedBy, "agent");
    },
  );
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["createTaskSpace", "fresh research"],
    ["useTaskSpace", 9],
    ["listTabs"],
    ["useTaskSpace", 9],
    ["listTabs"],
  ]);
});

test("resolving an existing v2 space cannot interrupt fresh p1 discovery", async () => {
  let selectedSpace;
  let releaseFirstInventory;
  let reportFirstInventory;
  const firstInventoryStarted = new Promise((resolve) => {
    reportFirstInventory = resolve;
  });
  const firstInventoryRelease = new Promise((resolve) => {
    releaseFirstInventory = resolve;
  });
  let inventoryCalls = 0;

  await withEgo(
    {
      async listTaskSpaces() {
        return {
          taskSpaces: [
            {
              taskId: "existing",
              id: 12,
              name: "existing",
              ownership: "agent",
            },
          ],
        };
      },
      async createTaskSpace(name) {
        return { taskId: name, id: 11, name };
      },
      async useTaskSpace(id) {
        selectedSpace = id;
      },
      async listTabs() {
        inventoryCalls += 1;
        if (inventoryCalls === 1) {
          reportFirstInventory();
          await firstInventoryRelease;
        }
        return {
          tabs: [
            {
              targetId:
                selectedSpace === 11 ? "target-fresh" : "target-existing",
            },
          ],
        };
      },
    },
    async () => {
      const freshPromise = taskSpace("fresh concurrent");
      await firstInventoryStarted;
      const existing = await taskSpace(12);
      assert.equal(existing.spaceId, 12);
      releaseFirstInventory();

      const fresh = await freshPromise;
      const pages = await fresh.pages();
      assert.deepEqual(
        pages.map((page) => [page.label, page.targetId]),
        [["p1", "target-fresh"]],
      );
    },
  );
});

test("taskSpace closes a new space when its default tab is ambiguous", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return { taskSpaces: [] };
      },
      async createTaskSpace(name) {
        calls.push(["createTaskSpace", name]);
        return { taskId: name, id: 10, name };
      },
      async useTaskSpace(id) {
        calls.push(["useTaskSpace", id]);
      },
      async closeTaskSpace() {
        calls.push(["closeTaskSpace"]);
      },
      async listTabs() {
        calls.push(["listTabs"]);
        return {
          tabs: [{ targetId: "target-a" }, { targetId: "target-b" }],
        };
      },
    },
    async () => {
      await assert.rejects(
        () => taskSpace("ambiguous runtime"),
        /new task space expected one default tab, found 2/,
      );
    },
  );
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["createTaskSpace", "ambiguous runtime"],
    ["useTaskSpace", 10],
    ["listTabs"],
    ["useTaskSpace", 10],
    ["closeTaskSpace"],
  ]);
});

test("taskSpace does not reuse an existing name when a profile is explicit", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return {
          taskSpaces: [
            {
              taskId: "work research",
              id: 7,
              name: "work research",
              ownership: "agent",
            },
          ],
        };
      },
      async createTaskSpace(name, profileId) {
        calls.push(["createTaskSpace", name, profileId]);
        return { taskId: name, id: 8, name };
      },
      useTaskSpace(id) {
        calls.push(["useTaskSpace", id]);
        return id;
      },
    },
    async () => {
      await assert.rejects(
        () => taskSpace("work research", { profileId: "Profile 2" }),
        /profileId only applies when creating a new task space.*already exists/,
      );
    },
  );
  assert.deepEqual(calls, [["listTaskSpaces"]]);
});

test("taskSpace rejects profile selection when resuming a numeric space id", async () => {
  await withEgo(
    {
      async listTaskSpaces() {
        throw new Error("must not inspect spaces");
      },
    },
    async () => {
      await assert.rejects(
        () => taskSpace(7, { profileId: "Profile 2" }),
        /profileId can only be used with a new task-space name/,
      );
    },
  );
});

test("taskSpace rejects empty profile ids before calling Ego Lite", async () => {
  await withEgo(
    {
      async listTaskSpaces() {
        throw new Error("must not inspect spaces");
      },
    },
    async () => {
      await assert.rejects(
        () => taskSpace("work research", { profileId: "" }),
        /taskSpace profileId must be a non-empty string/,
      );
    },
  );
});

test("switchTaskSpace selects a matching task space", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "Checkout flow",
              ownership: "agent",
            },
          ],
        };
      },
      useTaskSpace(taskId) {
        calls.push(["useTaskSpace", taskId]);
        return taskId;
      },
    },
    async () => {
      assert.deepEqual(await switchTaskSpace(7), {
        taskId: "checkout-flow",
        id: 7,
        name: "Checkout flow",
        ownership: "agent",
      });
    },
  );
  assert.deepEqual(calls, [["useTaskSpace", 7]]);
});

test("switchTaskSpace rejects non-agent-owned task spaces", async () => {
  await withEgo(
    {
      async listTaskSpaces() {
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "user",
            },
          ],
        };
      },
      useTaskSpace() {},
    },
    async () => {
      await assert.rejects(
        () => switchTaskSpace("checkout-flow"),
        /switchTaskSpace requires an agent-owned task space/,
      );
    },
  );
});

test("switchTaskSpace awaits useTaskSpace binding errors", async () => {
  await withEgo(
    {
      async listTaskSpaces() {
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "agent",
            },
          ],
        };
      },
      async useTaskSpace() {
        return { error: "Task space not selected" };
      },
    },
    async () => {
      await assert.rejects(
        () => switchTaskSpace("checkout-flow"),
        /switchTaskSpace: Task space not selected/,
      );
    },
  );
});

test("newTaskSpace creates and selects an agent task space", async () => {
  const calls = [];
  await withEgo(
    {
      async createTaskSpace(name) {
        calls.push(["createTaskSpace", name]);
        // Ego Lite's create result may omit ownership even though creation by
        // this API always produces an Agent-owned space.
        return { taskId: name, id: 7, name };
      },
      useTaskSpace(taskId) {
        calls.push(["useTaskSpace", taskId]);
        return taskId;
      },
    },
    async () => {
      assert.deepEqual(await newTaskSpace("checkout-flow"), {
        taskId: "checkout-flow",
        id: 7,
        name: "checkout-flow",
        ownership: "agent",
      });
    },
  );
  assert.deepEqual(calls, [
    ["createTaskSpace", "checkout-flow"],
    ["useTaskSpace", 7],
  ]);
});

test("newTaskSpace rejects results without a numeric id", async () => {
  const calls = [];
  await withEgo(
    {
      async createTaskSpace(name) {
        calls.push(["createTaskSpace", name]);
        return { taskId: name, id: name, name };
      },
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "agent",
            },
          ],
        };
      },
      useTaskSpace(id) {
        calls.push(["useTaskSpace", id]);
      },
    },
    async () => {
      await assert.rejects(
        () => newTaskSpace("checkout-flow"),
        /newTaskSpace requires a numeric task space id/,
      );
    },
  );
  assert.deepEqual(calls, [["createTaskSpace", "checkout-flow"]]);
});

test("newTaskSpace throws on binding error objects", async () => {
  await withEgo(
    {
      async createTaskSpace() {
        return { error: "Task space already exists: checkout-flow" };
      },
      useTaskSpace() {},
    },
    async () => {
      await assert.rejects(
        () => newTaskSpace("checkout-flow"),
        /newTaskSpace: Task space already exists: checkout-flow/,
      );
    },
  );
});

test("useOrCreateTaskSpace reuses existing agent-owned spaces", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "agent",
            },
          ],
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
      },
    },
    async () => {
      assert.deepEqual(await useOrCreateTaskSpace("checkout-flow"), {
        taskId: "checkout-flow",
        id: 7,
        name: "checkout-flow",
        ownership: "agent",
      });
    },
  );
  assert.deepEqual(calls, [["listTaskSpaces"], ["useTaskSpace", 7]]);
});

test("useOrCreateTaskSpace selects user-owned spaces without claiming and surfaces the owned user-control guidance", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "user",
            },
          ],
        };
      },
      async claimTaskSpace(id, name) {
        calls.push(["claimTaskSpace", id, name]);
        return { taskId: name, id, name, ownership: "agent" };
      },
      useTaskSpace(taskId) {
        calls.push(["useTaskSpace", taskId]);
        // Native attaches the stable code; resolveEgoError overrides the live
        // text with ego-browser's owned EGO_TASK_SPACE_USER_IN_CONTROL guidance.
        return {
          error: "The task is under user control",
          error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
        };
      },
    },
    async () => {
      await assert.rejects(
        () => useOrCreateTaskSpace("checkout-flow"),
        /useOrCreateTaskSpace: The user has taken control of this task space/,
      );
    },
  );
  assert.deepEqual(calls, [["listTaskSpaces"], ["useTaskSpace", 7]]);
});

test("claimTaskSpace returns a TaskSpace after claiming and selecting", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "user",
            },
          ],
        };
      },
      async claimTaskSpace(id, name) {
        calls.push(["claimTaskSpace", id, name]);
        return { taskId: name, id, name };
      },
      useTaskSpace(taskId) {
        calls.push(["useTaskSpace", taskId]);
        return taskId;
      },
      async listTabs() {
        calls.push(["listTabs"]);
        return { tabs: [] };
      },
    },
    async () => {
      const task = await claimTaskSpace("checkout-flow");
      assert.deepEqual(JSON.parse(JSON.stringify(task)), {
        taskId: "checkout-flow",
        id: 7,
        name: "checkout-flow",
        ownership: "agent",
      });
      assert.equal(task.spaceId, 7);
      assert.equal(typeof task.newPage, "function");
    },
  );
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["claimTaskSpace", 7, "checkout-flow"],
    ["useTaskSpace", 7],
    ["useTaskSpace", 7],
    ["listTabs"],
  ]);
});

test("takeOverTaskSpace returns a TaskSpace when a space is specified", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "agentDelegatedToUser",
            },
          ],
        };
      },
      async useTaskSpace(id) {
        calls.push(["useTaskSpace", id]);
      },
      async takeOverTaskSpace() {
        calls.push(["takeOverTaskSpace"]);
      },
      async listTabs() {
        calls.push(["listTabs"]);
        return { tabs: [] };
      },
    },
    async () => {
      const task = await takeOverTaskSpace(7);
      assert.equal(task.spaceId, 7);
      assert.equal(task.ownership, "agent");
      assert.equal(typeof task.newPage, "function");
    },
  );
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["useTaskSpace", 7],
    ["takeOverTaskSpace"],
    ["useTaskSpace", 7],
    ["listTabs"],
  ]);
});

test("takeOverTaskSpace does not invent a user boundary when Agent already controls the space", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "agent",
            },
          ],
        };
      },
      async useTaskSpace(id) {
        calls.push(["useTaskSpace", id]);
      },
      async takeOverTaskSpace() {
        calls.push(["takeOverTaskSpace"]);
      },
      async listTabs() {
        calls.push(["listTabs"]);
        return { tabs: [] };
      },
    },
    async () => {
      const task = await takeOverTaskSpace(7);
      assert.equal(task.userPage(), undefined);
    },
  );
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["useTaskSpace", 7],
    ["takeOverTaskSpace"],
  ]);
});

test("claimTaskSpace throws on an unknown task space", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return { taskSpaces: [] };
      },
      async claimTaskSpace(id, name) {
        calls.push(["claimTaskSpace", id, name]);
        return { taskId: name, id, name, ownership: "agent" };
      },
    },
    async () => {
      await assert.rejects(
        () => claimTaskSpace("checkout-flow"),
        /task space not found: checkout-flow/,
      );
    },
  );
  assert.deepEqual(calls, [["listTaskSpaces"]]);
});

test("useOrCreateTaskSpace creates missing spaces", async () => {
  const calls = [];
  await withEgo(
    {
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
      },
    },
    async () => {
      assert.deepEqual(await useOrCreateTaskSpace("checkout-flow"), {
        taskId: "checkout-flow",
        id: 7,
        name: "checkout-flow",
        ownership: "agent",
      });
    },
  );
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["createTaskSpace", "checkout-flow"],
    ["useTaskSpace", 7],
  ]);
});

test("useOrCreateTaskSpace resolves string names before numeric id strings", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return {
          taskSpaces: [
            {
              taskId: "plain-seven",
              id: 7,
              name: "plain-seven",
              ownership: "agent",
            },
            { taskId: "7", id: 8, name: "7", ownership: "agent" },
          ],
        };
      },
      useTaskSpace(id) {
        calls.push(["useTaskSpace", id]);
        return id;
      },
    },
    async () => {
      assert.deepEqual(await useOrCreateTaskSpace("7"), {
        taskId: "7",
        id: 8,
        name: "7",
        ownership: "agent",
      });
    },
  );
  assert.deepEqual(calls, [["listTaskSpaces"], ["useTaskSpace", 8]]);
});

test("useOrCreateTaskSpace rejects missing numeric ids instead of creating", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return { taskSpaces: [] };
      },
      async createTaskSpace(name) {
        calls.push(["createTaskSpace", name]);
        return {
          taskId: String(name),
          id: 7,
          name: String(name),
          ownership: "agent",
        };
      },
    },
    async () => {
      await assert.rejects(
        () => useOrCreateTaskSpace(7),
        /task space not found: 7/,
      );
    },
  );
  assert.deepEqual(calls, [["listTaskSpaces"]]);
});

test("completeTaskSpace selects by numeric id before completing", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "agent",
            },
          ],
        };
      },
      useTaskSpace(id) {
        calls.push(["useTaskSpace", id]);
        return id;
      },
      async completeTaskSpace() {
        calls.push(["completeTaskSpace"]);
        return "7 task space completed.";
      },
    },
    async () => {
      await completeTaskSpace("checkout-flow", { keep: true });
    },
  );
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["useTaskSpace", 7],
    ["completeTaskSpace"],
  ]);
});

test("completeTaskSpace waits for async useTaskSpace before completing", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "agent",
            },
          ],
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
      },
    },
    async () => {
      await completeTaskSpace("checkout-flow", { keep: true });
    },
  );
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["useTaskSpace:start", 7],
    ["useTaskSpace:end", 7],
    ["completeTaskSpace"],
  ]);
});

test("completeTaskSpace claims user-owned spaces before closing", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "user",
            },
          ],
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
      },
    },
    async () => {
      const result = await completeTaskSpace("checkout-flow", { keep: false });
      assert.deepEqual(result, { done: true });
    },
  );
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["claimTaskSpace", 7, "checkout-flow"],
    ["useTaskSpace", 7],
    ["closeTaskSpace"],
  ]);
});

test("completeTaskSpace keep true skips user-owned spaces and reports it", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "user",
            },
          ],
        };
      },
      async completeTaskSpace() {
        calls.push(["completeTaskSpace"]);
      },
    },
    async () => {
      const result = await completeTaskSpace("checkout-flow", { keep: true });
      assert.deepEqual(result, { done: false, skipped: "user-owned" });
    },
  );
  assert.deepEqual(calls, [["listTaskSpaces"]]);
});

test("handOffTaskSpace skips user-owned spaces and reports it", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "user",
            },
          ],
        };
      },
      async handOffTaskSpace() {
        calls.push(["handOffTaskSpace"]);
      },
    },
    async () => {
      const result = await handOffTaskSpace("checkout-flow");
      assert.deepEqual(result, { done: false, skipped: "user-owned" });
    },
  );
  assert.deepEqual(calls, [["listTaskSpaces"]]);
});

test("handOffTaskSpace reports done for agent-owned spaces", async () => {
  const calls = [];
  await withEgo(
    {
      async listTaskSpaces() {
        calls.push(["listTaskSpaces"]);
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "agent",
            },
          ],
        };
      },
      async useTaskSpace(id) {
        calls.push(["useTaskSpace", id]);
        return id;
      },
      async handOffTaskSpace() {
        calls.push(["handOffTaskSpace"]);
      },
    },
    async () => {
      const result = await handOffTaskSpace("checkout-flow");
      assert.deepEqual(result, { done: true });
    },
  );
  assert.deepEqual(calls, [
    ["listTaskSpaces"],
    ["useTaskSpace", 7],
    ["handOffTaskSpace"],
  ]);
});

test("useOrCreateTaskSpace rejects unknown ownership", async () => {
  await withEgo(
    {
      async listTaskSpaces() {
        return {
          taskSpaces: [
            {
              taskId: "checkout-flow",
              id: 7,
              name: "checkout-flow",
              ownership: "shared",
            },
          ],
        };
      },
    },
    async () => {
      await assert.rejects(
        () => useOrCreateTaskSpace("checkout-flow"),
        /ownership "shared"/,
      );
    },
  );
});

// The probe in waitForAgentControl keys on ego.snapshot()'s rejection carrying
// error_code === EGO_TASK_SPACE_USER_IN_CONTROL (the documented contract), not on
// message wording. These tests pin that contract so a runtime that stops setting
// the code surfaces as a failing test rather than a silent regression.
function taskSpaceEgo(snapshot) {
  return {
    async listTaskSpaces() {
      return {
        taskSpaces: [{ taskId: "t", id: 1, name: "t", ownership: "agent" }],
      };
    },
    async useTaskSpace() {
      return 1;
    },
    snapshot,
  };
}

test("waitForAgentControl retries while snapshot reports user control", async () => {
  const restore = helperExports.__testing.setOverrides({
    sleep: () => Promise.resolve(),
  });
  let calls = 0;
  try {
    await withEgo(
      taskSpaceEgo(async () => {
        calls += 1;
        if (calls < 3) {
          throw Object.assign(new Error("anything at all"), {
            error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
          });
        }
        return { content: "" };
      }),
      async () => {
        await waitForAgentControl("t", { interval: 0, timeout: 5 });
      },
    );
  } finally {
    restore();
  }
  assert.equal(calls, 3);
});

test("waitForAgentControl retries when snapshot resolves a user-control error", async () => {
  const restore = helperExports.__testing.setOverrides({
    sleep: () => Promise.resolve(),
  });
  let calls = 0;
  try {
    await withEgo(
      taskSpaceEgo(async () => {
        calls += 1;
        if (calls < 3) {
          return {
            error: "manual_takeover",
            error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
          };
        }
        return { content: "" };
      }),
      async () => {
        await waitForAgentControl("t", { interval: 0, timeout: 5 });
      },
    );
  } finally {
    restore();
  }
  assert.equal(calls, 3);
});

test("waitForAgentControl propagates non-user-control snapshot errors", async () => {
  await withEgo(
    taskSpaceEgo(async () => {
      throw Object.assign(new Error("snapshot failed"), {
        error_code: "EGO_SNAPSHOT_FAILED",
      });
    }),
    async () => {
      await assert.rejects(
        () => waitForAgentControl("t", { interval: 0, timeout: 5 }),
        /snapshot failed/,
      );
    },
  );
});
