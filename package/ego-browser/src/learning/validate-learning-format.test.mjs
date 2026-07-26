import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { validateLearning } from "../../dist/src/learning/index.js";

async function writePack(browserToolSource) {
  const root = await mkdtemp(join(tmpdir(), "ego-validate-"));
  const siteDir = join(root, "example");
  await mkdir(join(siteDir, "notes"), { recursive: true });
  await mkdir(join(siteDir, "browser-tools"));
  await writeFile(
    join(siteDir, "manifest.json"),
    JSON.stringify({
      id: "example",
      name: "Example",
      domains: ["example.com"],
      notes: ["notes/overview.md"],
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
    join(siteDir, "browser-tools/active-item.js"),
    browserToolSource,
  );
  return siteDir;
}

test("accepts an anonymous async function browser tool", async () => {
  const siteDir = await writePack(
    "async function(args) { return { ok: true }; }\n",
  );
  assert.deepEqual(await validateLearning(siteDir), []);
});

test("accepts an arrow function browser tool", async () => {
  const siteDir = await writePack("async (args) => ({ ok: true })\n");
  assert.deepEqual(await validateLearning(siteDir), []);
});

test("reports a browser tool that does not parse", async () => {
  const siteDir = await writePack("async function(args) { return oops(( }\n");
  const errors = await validateLearning(siteDir);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /cannot parse "browser-tools\/active-item\.js"/);
});

test("reports a browser tool that is not a function expression", async () => {
  const siteDir = await writePack("({ run: (args) => args })\n");
  const errors = await validateLearning(siteDir);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /must contain a single function expression/);
});
