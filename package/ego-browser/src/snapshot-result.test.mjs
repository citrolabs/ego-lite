import test from "node:test";
import assert from "node:assert/strict";

import {
  compactSnapshotContent,
  compactSnapshotResult,
  preparePageSnapshotResult,
  sanitizeSnapshotLocators,
  validateSnapshotLocator,
} from "../dist/src/snapshot-result.js";

test("snapshot compaction removes only redundant text and containers", () => {
  const content = [
    "root",
    "  container",
    "  container",
    "    container",
    "      button [ref=1, loc=unstable]",
    '        text "Save"',
    "  container",
    '    text "A"',
    '    text "B"',
    "  text",
    '  text " "',
    '  text "​"',
    '  container "Section"',
    '    text "Title"',
    "  container [ref=2, loc=ambiguous]",
    "  button [ref=3, loc=css:#confirm]",
    "  button [ref=5, loc=css:[loc=unstable]]",
    "  anchor [ref=6, loc=unstable, url=https://example.com/item]",
    '  text "literal [ref=9, loc=unstable]"',
    "  image",
    "  svg_root",
    "  canvas",
    "  iframe [ref=4, loc=unstable]",
    "    root",
    "  list",
    "    list_item",
    "  table",
    "    table_row",
    "      table_cell",
  ].join("\n");

  const compact = [
    "root",
    "  button [ref=1]",
    '    text "Save"',
    "  container",
    '    text "A"',
    '    text "B"',
    '  container "Section"',
    '    text "Title"',
    "  container [ref=2]",
    "  button [ref=3, loc=css:#confirm]",
    "  button [ref=5, loc=css:[loc=unstable]]",
    "  anchor [ref=6, url=https://example.com/item]",
    '  text "literal [ref=9, loc=unstable]"',
    "  image",
    "  svg_root",
    "  canvas",
    "  iframe [ref=4]",
    "    root",
    "  list",
    "    list_item",
    "  table",
    "    table_row",
    "      table_cell",
  ].join("\n");

  assert.equal(compactSnapshotContent(content), compact);
  assert.equal(compactSnapshotContent(compact), compact);
  assert.equal(
    compactSnapshotContent("snapshot unavailable"),
    "snapshot unavailable",
  );
});

test("snapshot compaction omits unusable locator statuses from refs", () => {
  const result = {
    content: [
      "root",
      "  button [ref=1, loc=unstable]",
      "  button [ref=2, loc=ambiguous]",
      "  button [ref=3, loc=css:#save]",
    ].join("\n"),
    refs: [
      { refId: 1, backendNodeId: 1, loc: "unstable" },
      { refId: 2, backendNodeId: 2, loc: "ambiguous" },
      { refId: 3, backendNodeId: 3, loc: "css:#save" },
    ],
  };

  compactSnapshotResult(result);

  assert.equal(
    result.content,
    [
      "root",
      "  button [ref=1]",
      "  button [ref=2]",
      "  button [ref=3, loc=css:#save]",
    ].join("\n"),
  );
  assert.equal(result.refs[0].loc, undefined);
  assert.equal(result.refs[1].loc, undefined);
  assert.equal(result.refs[2].loc, "css:#save");
});

test("snapshot locator validation batches DOM queries and object cleanup", async () => {
  const calls = [];
  const services = {
    async cdp(method, params, sessionId) {
      calls.push([method, params, sessionId]);
      if (method === "Runtime.evaluate" && params.returnByValue) {
        return { result: { value: [1, 1] } };
      }
      if (method === "Runtime.evaluate") {
        return { result: { objectId: "locator-batch" } };
      }
      if (method === "Runtime.getProperties") {
        return {
          result: [
            { name: "0", value: { objectId: "node:10" } },
            { name: "1", value: { objectId: "node:11" } },
          ],
        };
      }
      if (method === "DOM.describeNode") {
        return {
          node: {
            backendNodeId: Number(params.objectId.slice("node:".length)),
          },
        };
      }
      if (method === "Runtime.releaseObjectGroup") return {};
      throw new Error(`unexpected CDP method: ${method}`);
    },
  };
  const result = {
    content: [
      "button A [ref=10, loc=css:#a]",
      "button B [ref=11, loc=css:#b]",
    ].join("\n"),
    refs: [
      { backendNodeId: 10, loc: "css:#a" },
      { backendNodeId: 11, loc: "css:#b" },
    ],
  };

  await preparePageSnapshotResult(services, "session:page", new Map(), result);

  assert.equal(result.refs[0].loc, "css:#a");
  assert.equal(result.refs[1].loc, "css:#b");
  assert.equal(
    calls.filter(([method]) => method === "Runtime.evaluate").length,
    2,
  );
  assert.equal(
    calls.filter(([method]) => method === "Runtime.getProperties").length,
    1,
  );
  assert.equal(
    calls.filter(([method]) => method === "DOM.describeNode").length,
    2,
  );
  assert.equal(
    calls.filter(([method]) => method === "Runtime.releaseObjectGroup").length,
    1,
  );
  assert.equal(
    calls.some(([method]) => method === "Runtime.releaseObject"),
    false,
  );
});

test("DOM locator validation keeps healthy contexts when one count fails", async () => {
  const cdp = {
    async sendRaw(method, params, sessionId) {
      if (sessionId === "session:detached") {
        throw new Error("frame detached");
      }
      if (method === "Runtime.evaluate" && params.returnByValue) {
        return { result: { value: [1] } };
      }
      if (method === "Runtime.evaluate") {
        return { result: { objectId: "locator-batch" } };
      }
      if (method === "Runtime.getProperties") {
        return {
          result: [{ name: "0", value: { objectId: "node:10" } }],
        };
      }
      if (method === "DOM.describeNode") {
        return { node: { backendNodeId: 10 } };
      }
      if (method === "Runtime.releaseObjectGroup") return {};
      throw new Error(`unexpected CDP method: ${method}`);
    },
  };

  assert.equal(
    await validateSnapshotLocator(
      cdp,
      "session:page",
      new Map([["frame-detached", "session:detached"]]),
      { backendNodeId: 10, loc: "css:#save" },
    ),
    true,
  );
});

test("DOM locator validation keeps the Page when an iframe world disappears", async () => {
  const cdp = {
    async sendRaw(method, params) {
      if (method === "Page.createIsolatedWorld") {
        throw new Error("frame detached");
      }
      if (method === "Runtime.evaluate" && params.returnByValue) {
        return { result: { value: [1] } };
      }
      if (method === "Runtime.evaluate") {
        return { result: { objectId: "locator-batch" } };
      }
      if (method === "Runtime.getProperties") {
        return {
          result: [{ name: "0", value: { objectId: "node:10" } }],
        };
      }
      if (method === "DOM.describeNode") {
        return { node: { backendNodeId: 10 } };
      }
      if (method === "Runtime.releaseObjectGroup") return {};
      throw new Error(`unexpected CDP method: ${method}`);
    },
  };

  assert.equal(
    await validateSnapshotLocator(
      cdp,
      "session:page",
      new Map([["frame-detached", "session:page"]]),
      { backendNodeId: 10, loc: "css:#save" },
    ),
    true,
  );
});

test("role locator validation keeps healthy trees when one frame detaches", async () => {
  const cdp = {
    async sendRaw(method, _params, sessionId) {
      assert.equal(method, "Accessibility.getFullAXTree");
      if (sessionId === "session:detached") {
        throw new Error("frame detached");
      }
      return {
        nodes: [
          {
            backendDOMNodeId: 10,
            ignored: false,
            role: { value: "button" },
            name: { value: "Save" },
          },
        ],
      };
    },
  };

  assert.equal(
    await validateSnapshotLocator(
      cdp,
      "session:page",
      new Map([["frame-detached", "session:detached"]]),
      {
        backendNodeId: 10,
        loc: 'role:button[name="Save"]',
      },
    ),
    true,
  );
});

test("invalid native snapshot locators are hidden without removing their refs", async () => {
  const result = {
    content: [
      'textfield "Prompt" [ref=10, loc=css:#prompt, url=https://example.com/prompt]',
      'text "literal ref=10, loc=css:#prompt"',
      'button "Save" [ref=11, loc=role:button[name="Save"]]',
    ].join("\n"),
    refs: [
      {
        backendNodeId: 10,
        role: "textfield",
        name: "Prompt",
        loc: "css:#prompt",
      },
      {
        backendNodeId: 11,
        role: "button",
        name: "Save",
        loc: 'role:button[name="Save"]',
      },
    ],
  };

  await sanitizeSnapshotLocators(
    result,
    async (ref) => ref.backendNodeId === 11,
  );

  assert.equal(
    result.content,
    [
      'textfield "Prompt" [ref=10, url=https://example.com/prompt]',
      'text "literal ref=10, loc=css:#prompt"',
      'button "Save" [ref=11, loc=role:button[name="Save"]]',
    ].join("\n"),
  );
  assert.equal(result.refs[0].loc, undefined);
  assert.equal(result.refs[1].loc, 'role:button[name="Save"]');
});

test("stable locator validation requires one match for the original backend node", async () => {
  const responses = new Map([
    ["zero", { count: 0 }],
    ["duplicate", { count: 2 }],
    ["wrong", { count: 1, resolvedBackendNodeId: 99 }],
    ["same", { count: 1, resolvedBackendNodeId: 10 }],
  ]);

  const cdp = {
    async sendRaw(method, params) {
      if (method === "Runtime.evaluate") {
        const key = [...responses.keys()].find((candidate) =>
          params.expression.includes(`#${candidate}`),
        );
        const response = responses.get(key);
        if (params.returnByValue) {
          return { result: { value: [response.count] } };
        }
        return {
          result: { objectId: `batch:${response.resolvedBackendNodeId}` },
        };
      }
      if (method === "Runtime.getProperties") {
        const backendNodeId = params.objectId.slice("batch:".length);
        return {
          result: [{ name: "0", value: { objectId: `node:${backendNodeId}` } }],
        };
      }
      if (method === "DOM.describeNode") {
        return {
          node: {
            backendNodeId: Number(params.objectId.slice("node:".length)),
          },
        };
      }
      if (method === "Runtime.releaseObjectGroup") return {};
      return {};
    },
  };

  for (const [selector, expected] of [
    ["zero", false],
    ["duplicate", false],
    ["wrong", false],
    ["same", true],
  ]) {
    assert.equal(
      await validateSnapshotLocator(cdp, "session:page", new Map(), {
        backendNodeId: 10,
        loc: `css:#${selector}`,
      }),
      expected,
      selector,
    );
  }
});

test("Page snapshots preserve native ref provenance", async () => {
  const result = {
    refs: [
      {
        refId: 1,
        backendNodeId: 6,
        role: "textbox",
        name: "",
      },
      {
        refId: 17,
        backendNodeId: 6,
        role: "textbox",
        name: "",
        frameId: "frame-oopif",
      },
    ],
  };
  const expected = structuredClone(result.refs);
  const services = {
    async cdp(_method, _params, sessionId) {
      if (sessionId === "session:oopif") {
        return {
          nodes: [
            {
              backendDOMNodeId: 6,
              role: { value: "textbox" },
              name: { value: "" },
            },
          ],
        };
      }
      return { nodes: [] };
    },
  };

  await preparePageSnapshotResult(
    services,
    "session:page",
    new Map([["frame-oopif", "session:oopif"]]),
    result,
  );

  assert.deepEqual(result.refs, expected);
});
