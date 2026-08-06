import test from "node:test";
import assert from "node:assert/strict";

import { renderAxTree } from "../dist/src/ax-snapshot.js";

function node(nodeId, role, name, extra = {}) {
  return {
    nodeId,
    role: { value: role },
    name: { value: name },
    ...extra,
  };
}

const PAGE = [
  node("1", "RootWebArea", "Example Domain", {
    backendDOMNodeId: 10,
    childIds: ["2", "3", "6"],
  }),
  node("2", "heading", "Example Domain", {
    backendDOMNodeId: 11,
    childIds: ["4"],
  }),
  node("3", "link", "More information...", {
    backendDOMNodeId: 12,
    childIds: ["5"],
  }),
  node("4", "StaticText", "Example Domain", { childIds: [] }),
  node("5", "StaticText", "More information...", { childIds: [] }),
  node("6", "generic", "", { backendDOMNodeId: 13, childIds: ["7"] }),
  node("7", "button", "Accept", { backendDOMNodeId: 14, childIds: [] }),
];

test("renders roles, names, and @backendNodeId marks", () => {
  const { content, refs } = renderAxTree(PAGE);
  assert.match(content, /RootWebArea "Example Domain"/);
  assert.match(content, /heading "Example Domain" \[@11\]/);
  assert.match(content, /link "More information\.\.\." \[@12\]/);
  assert.match(content, /button "Accept" \[@14\]/);
  assert.deepEqual(refs, [
    { backendNodeId: 11, role: "heading", name: "Example Domain" },
    { backendNodeId: 12, role: "link", name: "More information..." },
    { backendNodeId: 14, role: "button", name: "Accept" },
  ]);
});

test("skips generic wrappers but keeps their children", () => {
  const { content } = renderAxTree(PAGE);
  assert.doesNotMatch(content, /generic/);
  assert.match(content, /button "Accept"/);
});

test("drops StaticText that repeats its ancestor's name", () => {
  const { content } = renderAxTree(PAGE);
  const textLines = content
    .split("\n")
    .filter((line) => line.includes("- text:"));
  assert.equal(textLines.length, 0, "both texts repeat their parents' names");
});

test("keeps StaticText that adds information", () => {
  const { content } = renderAxTree([
    node("1", "RootWebArea", "Page", { backendDOMNodeId: 1, childIds: ["2"] }),
    node("2", "paragraph", "", { backendDOMNodeId: 2, childIds: ["3"] }),
    node("3", "StaticText", "This domain is for use in examples.", {
      childIds: [],
    }),
  ]);
  assert.match(content, /- text: "This domain is for use in examples\."/);
});

test("promotes children of ignored nodes", () => {
  const { content, refs } = renderAxTree([
    node("1", "RootWebArea", "Page", { backendDOMNodeId: 1, childIds: ["2"] }),
    { nodeId: "2", ignored: true, childIds: ["3"] },
    node("3", "button", "Buried", { backendDOMNodeId: 3, childIds: [] }),
  ]);
  assert.match(content, /button "Buried" \[@3\]/);
  assert.equal(refs.length, 1);
});

test("indentation follows rendered depth, not raw tree depth", () => {
  const { content } = renderAxTree(PAGE);
  const lines = content.split("\n");
  assert.match(lines[0], /^- RootWebArea/);
  assert.match(lines[1], /^ {2}- heading/);
  const button = lines.find((line) => line.includes("button"));
  assert.match(button, /^ {2}- button/, "generic wrapper adds no depth");
});

test("maxResultLength truncates the content but never the refs", () => {
  const { content, refs } = renderAxTree(PAGE, { maxResultLength: 1 });
  assert.equal(content.length, 1);
  assert.equal(refs.length, 3);
});

test("an empty tree renders empty content", () => {
  const { content, refs } = renderAxTree([]);
  assert.equal(content, "");
  assert.deepEqual(refs, []);
});
