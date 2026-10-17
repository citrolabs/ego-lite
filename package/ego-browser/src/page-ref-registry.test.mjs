import test from "node:test";
import assert from "node:assert/strict";

import {
  PageRefRegistry,
  validatePageRefState,
} from "../dist/src/page-ref-registry.js";

test("equal backend ids in different frames retain distinct public refs", () => {
  const registry = new PageRefRegistry();
  registry.replace("page", [
    { refId: 1, backendNodeId: 42, frameId: "first" },
    { refId: 2, backendNodeId: 42, frameId: "second" },
  ]);
  const subtree = [
    { refId: 1, backendNodeId: 42, frameId: "second", name: "Renamed" },
  ];
  registry.merge("page", subtree);
  assert.equal(subtree[0].refId, 2);
  assert.equal(registry.forTarget("page").get("1").frameId, "first");
  assert.equal(registry.forTarget("page").get("2").name, "Renamed");
});

test("full snapshots expire omitted refs and never recycle them after restoring state", () => {
  const registry = new PageRefRegistry();
  registry.replace("page", [{ refId: 1, backendNodeId: 42 }]);
  registry.replace("page", []);
  const restored = new PageRefRegistry();
  restored.restore("page", registry.exportState("page"));
  const replacement = [{ refId: 1, backendNodeId: 43 }];
  restored.merge("page", replacement);
  assert.equal(restored.isInvalidated("page", "1"), true);
  assert.equal(replacement[0].refId, 2);
});

test("persisted refs reject duplicate ids and counters that would reuse a published id", () => {
  const ref = { refId: "1", backendNodeId: 42, active: true };
  for (const state of [
    { nextRef: 1, refs: [ref] },
    { nextRef: 2, refs: [ref, { ...ref, backendNodeId: 43 }] },
    { nextRef: 2, refs: [{ ...ref, backendNodeId: 0 }] },
  ])
    assert.throws(
      () => validatePageRefState(state),
      /Invalid persisted Page refs/,
    );
});

test("partial snapshots allocate a new public ref when native ids collide", () => {
  const registry = new PageRefRegistry();
  registry.replace("page-target", [
    { refId: 1, backendNodeId: 35, role: "iframe" },
    { refId: 2, backendNodeId: 36, role: "iframe" },
  ]);
  const subtree = [
    { refId: 1, backendNodeId: 35, role: "iframe" },
    { refId: 2, backendNodeId: 43, role: "button", frameId: "first-frame" },
  ];

  registry.merge("page-target", subtree);

  assert.equal(registry.forTarget("page-target").get("2").backendNodeId, 36);
  assert.notEqual(String(subtree[1].refId), "2");
  assert.equal(
    registry.forTarget("page-target").get(String(subtree[1].refId))
      .backendNodeId,
    43,
  );
});

test("the same node keeps its public ref when native snapshot numbering changes", () => {
  const registry = new PageRefRegistry();
  registry.replace("page-target", [
    { refId: 1, backendNodeId: 35, role: "iframe" },
    { refId: 2, backendNodeId: 36, role: "iframe" },
  ]);
  const subtree = [{ refId: 1, backendNodeId: 36, role: "iframe" }];

  registry.merge("page-target", subtree);

  assert.equal(String(subtree[0].refId), "2");
  assert.equal(registry.forTarget("page-target").get("1").backendNodeId, 35);
});

test("Page refs preserve native frame provenance and an explicit ref id", () => {
  const refs = new PageRefRegistry().replace("page-target", [
    {
      refId: 901,
      backendNodeId: 21,
      frameId: "frame-target",
      frameProvenance: "frame",
      role: "button",
      name: "Run iframe action",
    },
  ]);

  assert.deepEqual(refs.get("901"), {
    backendNodeId: 21,
    role: "button",
    name: "Run iframe action",
    nth: undefined,
    frameId: "frame-target",
    frameProvenance: "frame",
  });
  assert.equal(
    refs.get("21"),
    undefined,
    "a renderer-local backend node id must not replace the printed ref id",
  );
});

test("an explicit snapshot gives a replacement node a new ref and keeps old refs stale", () => {
  const registry = new PageRefRegistry();
  registry.replace("page-target", [
    { refId: 21, backendNodeId: 21, role: "button", name: "Old action" },
    { refId: 22, backendNodeId: 22, role: "button", name: "Removed action" },
  ]);

  registry.invalidate("page-target");

  assert.equal(registry.forTarget("page-target").get("21"), undefined);
  assert.equal(registry.isInvalidated("page-target", "21"), true);

  registry.replace("page-target", [
    { refId: 21, backendNodeId: 42, role: "button", name: "New action" },
  ]);

  assert.equal(registry.isInvalidated("page-target", "21"), true);
  assert.equal(
    registry.isInvalidated("page-target", "22"),
    true,
    "an explicit snapshot only revives refs that it advertises",
  );
  assert.equal(registry.forTarget("page-target").get("21"), undefined);
  assert.equal(registry.forTarget("page-target").get("23").backendNodeId, 42);
});

test("partial snapshots merge refs without invalidating omitted targets", () => {
  const registry = new PageRefRegistry();
  registry.replace("page-target", [
    { refId: 21, backendNodeId: 21, role: "button", name: "First" },
    { refId: 22, backendNodeId: 22, role: "button", name: "Second" },
  ]);

  registry.merge("page-target", [
    { refId: 21, backendNodeId: 42, role: "button", name: "Updated" },
  ]);

  assert.equal(registry.forTarget("page-target").get("21").backendNodeId, 21);
  assert.equal(registry.forTarget("page-target").get("23").backendNodeId, 42);
  assert.equal(registry.forTarget("page-target").get("22").backendNodeId, 22);
  assert.equal(registry.isInvalidated("page-target", "22"), false);
});

test("partial snapshots revive only the invalidated refs they advertise", () => {
  const registry = new PageRefRegistry();
  registry.replace("page-target", [
    { refId: 21, backendNodeId: 21, role: "button", name: "First" },
    { refId: 22, backendNodeId: 22, role: "button", name: "Second" },
  ]);
  registry.invalidate("page-target");

  registry.merge("page-target", [
    { refId: 99, backendNodeId: 21, role: "button", name: "Updated" },
  ]);

  assert.equal(registry.forTarget("page-target").get("21").backendNodeId, 21);
  assert.equal(registry.isInvalidated("page-target", "21"), false);
  assert.equal(registry.forTarget("page-target").get("22"), undefined);
  assert.equal(registry.isInvalidated("page-target", "22"), true);
});

test("stale ref tombstones stay bounded for long-lived pages", () => {
  const registry = new PageRefRegistry();
  registry.replace(
    "page-target",
    Array.from({ length: 10_001 }, (_, index) => ({
      refId: index + 1,
      backendNodeId: index + 1,
      role: "button",
      name: `Action ${index + 1}`,
    })),
  );

  registry.invalidate("page-target");

  assert.equal(registry.isInvalidated("page-target", "1"), false);
  assert.equal(registry.isInvalidated("page-target", "10001"), true);
});
