import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaskSpaceRegistry } from "../dist/src/task-spaces.js";

async function withRegistry(run) {
  const dir = await mkdtemp(join(tmpdir(), "ego-host-spaces-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("create assigns increasing numeric ids and agent ownership", async () => {
  await withRegistry((dir) => {
    const registry = new TaskSpaceRegistry(dir);
    const first = registry.create("research");
    const second = registry.create("checkout");
    assert.equal(first.id, 1);
    assert.equal(second.id, 2);
    assert.equal(first.ownership, "agent");
    assert.equal(registry.list().length, 2);
  });
});

test("select tracks the current space; unknown ids return null", async () => {
  await withRegistry((dir) => {
    const registry = new TaskSpaceRegistry(dir);
    const space = registry.create("research");
    assert.equal(registry.current(), null);
    assert.equal(registry.select(space.id).id, space.id);
    assert.equal(registry.current().name, "research");
    assert.equal(registry.select(99), null);
  });
});

test("ownership transitions cover handoff, takeover, and claim", async () => {
  await withRegistry((dir) => {
    const registry = new TaskSpaceRegistry(dir);
    const space = registry.create("research");
    registry.setOwnership(space.id, "agentDelegatedToUser");
    assert.equal(registry.get(space.id).ownership, "agentDelegatedToUser");
    registry.setOwnership(space.id, "agent");
    assert.equal(registry.get(space.id).ownership, "agent");
    assert.equal(registry.setOwnership(99, "agent"), null);
  });
});

test("target tracking keeps membership and the active tab consistent", async () => {
  await withRegistry((dir) => {
    const registry = new TaskSpaceRegistry(dir);
    const space = registry.create("research");
    registry.select(space.id);
    registry.trackTarget("tab-1");
    registry.trackTarget("tab-2");
    registry.trackTarget("tab-2");
    assert.deepEqual(registry.current().targetIds, ["tab-1", "tab-2"]);
    registry.setActive("tab-1");
    assert.equal(registry.current().activeTargetId, "tab-1");
    registry.untrackTarget("tab-1");
    assert.deepEqual(registry.current().targetIds, ["tab-2"]);
    assert.equal(registry.current().activeTargetId, "tab-2");
  });
});

test("setActive ignores targets that are not part of the space", async () => {
  await withRegistry((dir) => {
    const registry = new TaskSpaceRegistry(dir);
    const space = registry.create("research");
    registry.select(space.id);
    registry.trackTarget("tab-1");
    registry.setActive("someone-elses-tab");
    assert.equal(registry.current().activeTargetId, null);
  });
});

test("pruneTargets drops tabs the browser no longer reports", async () => {
  await withRegistry((dir) => {
    const registry = new TaskSpaceRegistry(dir);
    const space = registry.create("research");
    registry.select(space.id);
    registry.trackTarget("tab-1");
    registry.trackTarget("tab-2");
    registry.setActive("tab-1");
    registry.pruneTargets(["tab-2"]);
    assert.deepEqual(registry.current().targetIds, ["tab-2"]);
    assert.equal(registry.current().activeTargetId, "tab-2");
  });
});

test("state persists across registry instances", async () => {
  await withRegistry((dir) => {
    const first = new TaskSpaceRegistry(dir);
    const space = first.create("research");
    first.select(space.id);
    first.trackTarget("tab-1");

    const second = new TaskSpaceRegistry(dir);
    assert.equal(second.current().name, "research");
    assert.deepEqual(second.current().targetIds, ["tab-1"]);
    const another = second.create("checkout");
    assert.equal(another.id, 2, "id counter persists too");
  });
});

test("remove clears the current selection when it was selected", async () => {
  await withRegistry((dir) => {
    const registry = new TaskSpaceRegistry(dir);
    const space = registry.create("research");
    registry.select(space.id);
    registry.remove(space.id);
    assert.equal(registry.current(), null);
    assert.equal(registry.list().length, 0);
  });
});
