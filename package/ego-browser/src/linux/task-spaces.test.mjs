import assert from "node:assert/strict";
import { test } from "node:test";
import { LinuxTaskSpaces } from "../../dist/src/linux/task-spaces.js";

function fixture() {
  const calls = [];
  let nextContext = 0;
  const spaces = new LinuxTaskSpaces(async (method, params) => {
    calls.push({ method, params });
    if (method === "Target.createBrowserContext")
      return { browserContextId: `context-${++nextContext}` };
    return {};
  });
  return { calls, spaces };
}

test("each space creates a distinct real browser context", async () => {
  const { calls, spaces } = fixture();
  const first = await spaces.createTaskSpace("first");
  const second = await spaces.createTaskSpace("second");
  assert.equal(
    calls.filter((c) => c.method === "Target.createBrowserContext").length,
    2,
  );
  assert.notEqual(first.browserContextId, second.browserContextId);
});

test("complete retains the same space for the user", async () => {
  const { spaces } = fixture();
  const task = await spaces.createTaskSpace("keep");
  await spaces.completeTaskSpace(task.id);
  const { taskSpaces } = await spaces.listTaskSpaces();
  assert.equal(taskSpaces.length, 1);
  assert.equal(taskSpaces[0].id, task.id);
  assert.equal(taskSpaces[0].ownership, "user");
});

test("unknown profile is rejected before creating a context", async () => {
  const { calls, spaces } = fixture();
  await assert.rejects(spaces.createTaskSpace("bad", "personal"), {
    error_code: "EGO_PROFILE_NOT_FOUND",
  });
  assert.equal(calls.length, 0);
});
