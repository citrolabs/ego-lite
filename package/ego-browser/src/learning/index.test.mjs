import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  loadBrowserToolSource,
  loadLearnedContext,
  runNodeSiteTool,
} from "../../dist/src/learning/index.js";

test("loadLearnedContext includes declared tool return schemas", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-learning-"));
  const siteDir = join(root, "example");
  await mkdir(join(siteDir, "notes"), { recursive: true });
  await mkdir(join(siteDir, "tools"));
  await mkdir(join(siteDir, "browser-tools"));
  await writeFile(
    join(siteDir, "manifest.json"),
    JSON.stringify({
      id: "example",
      name: "Example",
      domains: ["example.com"],
      notes: ["notes/overview.md"],
      nodeTools: {
        read_items: {
          description: "Read items.",
          path: "tools/read-items.js",
          callable: "readItems",
          args: {
            limit: {
              type: "integer",
              required: false,
              description: "Maximum number of items.",
            },
          },
          returns: {
            type: "array",
            description: "Array of item objects.",
          },
        },
      },
      browserTools: {
        active_item: {
          description: "Read the active item.",
          path: "browser-tools/active-item.js",
          args: {},
          returns: {
            type: "object",
            description: "Active item object.",
          },
        },
      },
    }),
  );
  await writeFile(join(siteDir, "notes/overview.md"), "# Example\n");
  await writeFile(
    join(siteDir, "tools/read-items.js"),
    "export async function readItems() { return []; }\n",
  );
  await writeFile(
    join(siteDir, "browser-tools/active-item.js"),
    "async function() { return {}; }\n",
  );

  const context = await loadLearnedContext("https://example.com", { root });

  assert.equal(context.exists, true);
  assert.deepEqual(
    context.tools.find((tool) => tool.toolName === "read_items").returns,
    { type: "array", description: "Array of item objects." },
  );
  assert.deepEqual(
    context.tools.find((tool) => tool.toolName === "active_item").returns,
    { type: "object", description: "Active item object." },
  );
});

test("site tool paths resolve on every platform and stay confined", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-learning-"));
  const siteDir = join(root, "example");
  await mkdir(join(siteDir, "tools"), { recursive: true });
  await mkdir(join(siteDir, "browser-tools"));
  const manifest = {
    id: "example",
    name: "Example",
    domains: ["example.com"],
    nodeTools: {
      read_items: {
        description: "Read items.",
        path: "tools/read-items.js",
        callable: "readItems",
        args: {},
      },
    },
    browserTools: {
      active_item: {
        description: "Read the active item.",
        path: "browser-tools/active-item.js",
        args: {},
      },
    },
  };
  await writeFile(join(siteDir, "manifest.json"), JSON.stringify(manifest));
  await writeFile(
    join(siteDir, "tools/read-items.js"),
    "export async function readItems() { return ['ok']; }\n",
  );
  await writeFile(
    join(siteDir, "browser-tools/active-item.js"),
    "async function() { return {}; }\n",
  );

  // Regression: the confinement check used to compare against a hard-coded "/"
  // separator, so every declared tool path was rejected on Windows.
  const source = await loadBrowserToolSource("example", "active_item", {
    root,
  });
  assert.match(source, /async function/);
  assert.deepEqual(
    await runNodeSiteTool("example", "read_items", {}, undefined, { root }),
    ["ok"],
  );

  // Escaping the site directory must still be refused.
  const escaping = await mkdtemp(join(tmpdir(), "ego-learning-"));
  const escapingSite = join(escaping, "example");
  await mkdir(escapingSite, { recursive: true });
  await writeFile(
    join(escapingSite, "manifest.json"),
    JSON.stringify({
      ...manifest,
      browserTools: {
        active_item: {
          description: "Escape.",
          path: "../outside.js",
          args: {},
        },
      },
    }),
  );
  await assert.rejects(
    () => loadBrowserToolSource("example", "active_item", { root: escaping }),
    /must stay inside the site skill directory|must be relative/,
  );
});
