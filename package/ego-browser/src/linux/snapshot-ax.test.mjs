import assert from "node:assert/strict";
import { test } from "node:test";
import { LinuxSnapshot } from "../../dist/src/linux/snapshot-ax.js";
const nodes = [
  {
    nodeId: "root",
    backendDOMNodeId: 1,
    role: { value: "RootWebArea" },
    childIds: ["button", "text"],
  },
  {
    nodeId: "button",
    backendDOMNodeId: 2,
    role: { value: "button" },
    name: { value: "Continue" },
  },
  {
    nodeId: "text",
    backendDOMNodeId: 3,
    role: { value: "StaticText" },
    name: { value: "offscreen" },
  },
];
function fixture() {
  let id;
  return new LinuxSnapshot(async (method, params) => {
    if (method === "Accessibility.getFullAXTree") return { nodes };
    if (method === "Page.getFrameTree")
      return { frameTree: { frame: { id: "main" } } };
    if (method === "DOM.resolveNode") {
      id = params.backendNodeId;
      return { object: { objectId: String(id) } };
    }
    if (method === "Runtime.callFunctionOn")
      return { result: { value: { visible: id !== 3, loc: "css:#continue" } } };
    return {};
  });
}
test("snapshot emits parseable refs and zero means unlimited", async () => {
  const result = await fixture().snapshot({ maxResultLength: 0 });
  assert.match(result.content, /button "Continue" \[ref=2\]/);
  assert.equal(result.refs.length, 3);
  assert.equal(result.refs[1].frameId, undefined);
  assert.equal(result.refs[1].frameProvenance, "page");
});
test("viewport, interactive and subtree filters affect output", async () => {
  assert.doesNotMatch(
    (await fixture().snapshot({ scope: "only_within_viewport" })).content,
    /offscreen/,
  );
  assert.equal(
    (await fixture().snapshot({ interactiveOnly: true })).refs.length,
    1,
  );
  assert.equal(
    (await fixture().snapshot({ scope: "subtree", root: 2 })).refs[0]
      .backendNodeId,
    2,
  );
  await assert.rejects(fixture().snapshot({ scope: "subtree", root: 99 }), {
    error_code: "EGO_SNAPSHOT_FAILED",
  });
});
test("truncation does not emit refs absent from content", async () => {
  const result = await fixture().snapshot({ maxResultLength: 25 });
  assert.ok(result.content.length <= 25);
  for (const ref of result.refs)
    assert.ok(result.content.includes(`[ref=${ref.backendNodeId}]`));
});
test("snapshot failures reject with a stable code", async () => {
  await assert.rejects(
    new LinuxSnapshot(async () => {
      throw new Error("CDP broke");
    }).snapshot(),
    { error_code: "EGO_SNAPSHOT_FAILED" },
  );
});
