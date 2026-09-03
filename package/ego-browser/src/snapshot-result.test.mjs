import test from "node:test";
import assert from "node:assert/strict";

import {
  compactSnapshotContent,
  compactSnapshotResult,
  deferIframeSnapshotSubtrees,
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

test("viewport snapshots defer iframe descendants while preserving frame roots and siblings", () => {
  const content = [
    "root",
    '  heading "Host"',
    "  iframe [ref=4]",
    "    root",
    '      button "Inside same-origin frame" [ref=5]',
    '  text "Host sibling"',
    "  iframe [ref=6]",
    "    root",
    "      iframe [ref=7]",
    "        root",
    '          textbox "Inside nested OOPIF" [ref=8]',
    '  text "iframe is literal text, not a frame node"',
  ].join("\n");

  assert.equal(
    deferIframeSnapshotSubtrees(content),
    [
      "root",
      '  heading "Host"',
      "  iframe [ref=4]",
      '  text "Host sibling"',
      "  iframe [ref=6]",
      '  text "iframe is literal text, not a frame node"',
    ].join("\n"),
  );
});

test("iframe deferral preserves non-tree output and trailing newlines", () => {
  assert.equal(
    deferIframeSnapshotSubtrees("snapshot unavailable"),
    "snapshot unavailable",
  );
  assert.equal(
    deferIframeSnapshotSubtrees("root\n  iframe [ref=4]\n    root\n"),
    "root\n  iframe [ref=4]\n",
  );
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

  assert.deepEqual(result.refs, [
    {
      refId: 1,
      backendNodeId: 6,
      role: "textbox",
      name: "",
      frameProvenance: "page",
    },
    {
      refId: 17,
      backendNodeId: 6,
      role: "textbox",
      name: "",
      frameId: "frame-oopif",
      frameProvenance: "frame",
    },
  ]);
});

test("Page snapshots backfill missing frame provenance from a unique locator", async () => {
  const result = {
    content: [
      "iframe [ref=12]",
      "root",
      '  button "Run iframe action" [ref=21, loc=role:button[name="Run iframe action"]]',
    ].join("\n"),
    refs: [
      {
        refId: 21,
        backendNodeId: 21,
        role: "button",
        name: "Run iframe action",
        loc: 'role:button[name="Run iframe action"]',
      },
    ],
  };
  const services = {
    async cdp(method, params, sessionId) {
      assert.equal(method, "Accessibility.getFullAXTree");
      if (sessionId === "session:page" && params.frameId === "frame-same") {
        return {
          nodes: [
            {
              backendDOMNodeId: 21,
              ignored: false,
              role: { value: "button" },
              name: { value: "Run iframe action" },
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
    new Map([
      ["frame-same", "session:page"],
      ["frame-oopif", "session:oopif"],
    ]),
    result,
  );

  assert.equal(result.refs[0].frameId, "frame-same");
  assert.equal(result.refs[0].frameProvenance, "frame");
});

test("Page snapshots do not invent frame provenance for an ambiguous backend node", async () => {
  const result = {
    content: [
      "iframe [ref=12]",
      "root",
      '  button "Duplicate action" [ref=21, loc=role:button[name="Duplicate action"]]',
    ].join("\n"),
    refs: [
      {
        refId: 21,
        backendNodeId: 21,
        role: "button",
        name: "Duplicate action",
        loc: 'role:button[name="Duplicate action"]',
      },
    ],
  };
  const services = {
    async cdp(method, params, sessionId) {
      assert.equal(method, "Accessibility.getFullAXTree");
      const isFirstFrame =
        sessionId === "session:page" && params.frameId === "frame-first";
      const isSecondFrame = sessionId === "session:second";
      return isFirstFrame || isSecondFrame
        ? {
            nodes: [
              {
                backendDOMNodeId: 21,
                ignored: false,
                role: { value: "button" },
                name: { value: "Duplicate action" },
              },
            ],
          }
        : { nodes: [] };
    },
  };

  await preparePageSnapshotResult(
    services,
    "session:page",
    new Map([
      ["frame-first", "session:page"],
      ["frame-second", "session:second"],
    ]),
    result,
  );

  assert.equal(result.refs[0].frameId, undefined);
  assert.equal(result.refs[0].frameProvenance, "unknown");
});

test("iframe deferral keeps a frame that advertises no ref expandable", () => {
  // Deferring an iframe with no ref would hide its descendants with no root to
  // pass back through subtree scope, so that frame stays inline.
  const content = [
    "root",
    "  iframe",
    "    root",
    '      button "Unreachable without a ref" [ref=5]',
    "  iframe [ref=6]",
    "    root",
    '      button "Reachable via @6" [ref=7]',
  ].join("\n");

  assert.equal(
    deferIframeSnapshotSubtrees(content),
    [
      "root",
      "  iframe",
      "    root",
      '      button "Unreachable without a ref" [ref=5]',
      "  iframe [ref=6]",
    ].join("\n"),
  );
});

test("frame provenance ignores a ref token inside an accessible name", async () => {
  const result = {
    content: [
      "root",
      '  link "See [ref=3] in the spec" [ref=3]',
      "  iframe [ref=12]",
      "    root",
      '      link "See [ref=3] in the spec" [ref=42]',
    ].join("\n"),
    refs: [
      {
        refId: 3,
        backendNodeId: 3,
        role: "link",
        name: "See [ref=3] in the spec",
      },
      {
        refId: 42,
        backendNodeId: 42,
        role: "link",
        name: "See [ref=3] in the spec",
      },
    ],
  };

  await preparePageSnapshotResult(
    {
      async cdp() {
        return { nodes: [] };
      },
    },
    "session:page",
    new Map([["frame-child", "session:page"]]),
    result,
  );

  assert.equal(
    result.refs[0].frameProvenance,
    "page",
    "the page-owned ref must not be re-homed by a quoted ref token",
  );
  assert.equal(
    result.refs[1].frameProvenance,
    "frame",
    "the frame-owned ref must still be recognised as a frame descendant",
  );
  assert.equal(result.refs[1].frameId, "frame-child");
});
