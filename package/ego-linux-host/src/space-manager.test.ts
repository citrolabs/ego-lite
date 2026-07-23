import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SpaceManager } from "./space-manager.js";

test("bootstraps user space id 1", () => {
  const sm = new SpaceManager();
  const user = sm.list().find((s) => s.id === 1);
  assert.equal(user?.ownership, "user");
  assert.equal(user?.name, "user");
});

test("createAgentSpace assigns tabs independently", () => {
  const sm = new SpaceManager();
  const a = sm.createAgentSpace("job-a");
  const b = sm.createAgentSpace("job-b");
  sm.use(a.id);
  sm.assignTarget("t1");
  sm.use(b.id);
  sm.assignTarget("t2");
  sm.use(a.id);
  assert.deepEqual(sm.targetsForSelected(), ["t1"]);
  sm.use(b.id);
  assert.deepEqual(sm.targetsForSelected(), ["t2"]);
});

test("use on user space selects but marks user control for page ops", () => {
  const sm = new SpaceManager();
  const result = sm.use(1);
  assert.equal(result.ok, true);
  assert.equal(sm.selected()?.ownership, "user");
  assert.equal(sm.isPageControlBlocked(), true);
});

test("handOff then takeOver", () => {
  const sm = new SpaceManager();
  const a = sm.createAgentSpace("x");
  sm.use(a.id);
  sm.handOff();
  assert.equal(sm.selected()?.ownership, "agentDelegatedToUser");
  assert.equal(sm.isPageControlBlocked(), true);
  sm.takeOver();
  assert.equal(sm.selected()?.ownership, "agent");
  assert.equal(sm.isPageControlBlocked(), false);
});

test("claim moves user space to agent", () => {
  const sm = new SpaceManager();
  sm.claim(1);
  assert.equal(sm.list().find((s) => s.id === 1)?.ownership, "agent");
});

test("use missing space returns not found", () => {
  const sm = new SpaceManager();
  const result = sm.use(999);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error_code, "EGO_TASK_SPACE_NOT_FOUND");
  }
});

test("isPageControlBlocked false only for agent ownership", () => {
  const sm = new SpaceManager();
  const a = sm.createAgentSpace("agent-job");
  sm.use(a.id);
  assert.equal(sm.selected()?.ownership, "agent");
  assert.equal(sm.isPageControlBlocked(), false);
});

test("listPublic strips targetIds", () => {
  const sm = new SpaceManager();
  const a = sm.createAgentSpace("pub");
  sm.use(a.id);
  sm.assignTarget("t-pub");
  const pub = sm.listPublic().find((s) => s.id === a.id);
  assert.ok(pub);
  assert.equal("targetIds" in (pub as object), false);
  assert.equal(pub?.name, "pub");
  const internal = sm.list().find((s) => s.id === a.id);
  assert.deepEqual(internal?.targetIds, ["t-pub"]);
});

test("assignTarget moves tab between spaces", () => {
  const sm = new SpaceManager();
  const a = sm.createAgentSpace("a");
  const b = sm.createAgentSpace("b");
  sm.assignTarget("shared", a.id);
  assert.equal(sm.spaceIdForTarget("shared"), a.id);
  sm.assignTarget("shared", b.id);
  assert.equal(sm.spaceIdForTarget("shared"), b.id);
  assert.equal(sm.list().find((s) => s.id === a.id)?.targetIds.includes("shared"), false);
});

test("adoptOrphanTargets puts unknowns on user space", () => {
  const sm = new SpaceManager();
  const a = sm.createAgentSpace("known");
  sm.assignTarget("known-t", a.id);
  sm.adoptOrphanTargets(["known-t", "orphan-1", "orphan-2"]);
  assert.equal(sm.spaceIdForTarget("known-t"), a.id);
  assert.equal(sm.spaceIdForTarget("orphan-1"), 1);
  assert.equal(sm.spaceIdForTarget("orphan-2"), 1);
});

test("closeSelected returns targetIds and removes agent space", () => {
  const sm = new SpaceManager();
  const a = sm.createAgentSpace("to-close");
  sm.use(a.id);
  sm.assignTarget("c1");
  sm.assignTarget("c2");
  const closed = sm.closeSelected();
  assert.deepEqual(closed.sort(), ["c1", "c2"]);
  assert.equal(sm.list().find((s) => s.id === a.id), undefined);
  assert.equal(sm.selected(), null);
});

test("completeKeep transfers selected agent space to user ownership", () => {
  const sm = new SpaceManager();
  const a = sm.createAgentSpace("done-keep");
  sm.use(a.id);
  sm.assignTarget("keep-tab");
  sm.completeKeep();
  const space = sm.list().find((s) => s.id === a.id);
  assert.equal(space?.ownership, "user");
  assert.deepEqual(space?.targetIds, ["keep-tab"]);
});

test("claim selects space and can rename", () => {
  const sm = new SpaceManager();
  const claimed = sm.claim(1, "claimed-user");
  assert.equal(claimed.ownership, "agent");
  assert.equal(claimed.name, "claimed-user");
  assert.equal(sm.selected()?.id, 1);
  assert.equal(sm.isPageControlBlocked(), false);
});

test("persist save/load round-trips spaces and selection", async () => {
  const dir = join(tmpdir(), `ego-space-mgr-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "spaces.json");
  try {
    const sm = new SpaceManager(path);
    const a = sm.createAgentSpace("persisted");
    sm.use(a.id);
    sm.assignTarget("pt1");
    sm.handOff();
    await sm.save();

    const raw = JSON.parse(await readFile(path, "utf8"));
    assert.equal(typeof raw.nextId, "number");
    assert.equal(raw.selectedId, a.id);
    assert.ok(Array.isArray(raw.spaces));

    const sm2 = new SpaceManager(path);
    await sm2.load();
    assert.equal(sm2.selected()?.id, a.id);
    assert.equal(sm2.selected()?.ownership, "agentDelegatedToUser");
    assert.deepEqual(sm2.targetsForSelected(), ["pt1"]);
    assert.ok(sm2.list().find((s) => s.id === 1));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("load missing file keeps bootstrap user space", async () => {
  const path = join(
    tmpdir(),
    `ego-space-missing-${process.pid}-${Date.now()}.json`,
  );
  const sm = new SpaceManager(path);
  await sm.load();
  assert.equal(sm.list().find((s) => s.id === 1)?.name, "user");
});

test("load recovers corrupt file to bootstrap", async () => {
  const dir = join(tmpdir(), `ego-space-bad-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "spaces.json");
  try {
    await writeFile(path, "not-json{{{", "utf8");
    const sm = new SpaceManager(path);
    await sm.load();
    assert.equal(sm.list().find((s) => s.id === 1)?.ownership, "user");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
