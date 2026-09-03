import test from "node:test";
import assert from "node:assert/strict";

import { PageRefRegistry } from "../dist/src/page-ref-registry.js";

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

test("invalidated Page refs stay stale until an explicit snapshot replaces them", () => {
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

  assert.equal(registry.isInvalidated("page-target", "21"), false);
  assert.equal(
    registry.isInvalidated("page-target", "22"),
    true,
    "an explicit snapshot only revives refs that it advertises",
  );
  assert.equal(registry.forTarget("page-target").get("21").backendNodeId, 42);
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

  assert.equal(registry.forTarget("page-target").get("21").backendNodeId, 42);
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
    { refId: 21, backendNodeId: 42, role: "button", name: "Updated" },
  ]);

  assert.equal(registry.forTarget("page-target").get("21").backendNodeId, 42);
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
