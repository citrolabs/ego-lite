import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildPluginIndex } from "../../../../ego-plugins/scripts/build-index.mjs";
import {
  formatSchemaIssues,
  schemaCallShape,
  schemaResultShape,
  validateJsonSchema,
} from "../../dist/src/plugins/json-schema.js";
import {
  bundleIntegrity,
  validateManifest,
} from "../../dist/src/plugins/manifest.js";
import { bundleFromDirectory, readLock } from "../../dist/src/plugins/store.js";
import {
  runPluginCommand,
  setPluginHelperContext,
} from "../../dist/src/plugins/runtime.js";
import {
  installPlugin,
  pinPlugin,
  plugins,
  removePlugin,
  rollbackPlugin,
  updatePlugin,
} from "../../dist/src/plugins/api.js";
import {
  buildRoundHints,
  notePageTouched,
  notePluginUsed,
  resetHints,
} from "../../dist/src/plugins/hints.js";
import {
  bufferOutput,
  flushSink,
  markHardStop,
  registerRoundFinalizer,
  resetSink,
  runRoundFinalizers,
} from "../../dist/src/output-sink.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const page = { label: "p1", spaceId: 7 };
const task = { name: "plugin-test" };

/**
 * A sandbox with its own plugin home, a bundled index (what ships with the
 * SDK) and a "remote" index (what citrolabs/ego-plugins serves), both built
 * by the real index builder from plugin directories written by the test.
 */
function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), "ego-plugins-test-"));
  const saved = {};
  const setEnv = (name, value) => {
    if (!(name in saved)) saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  setEnv("EGO_BROWSER_PLUGIN_HOME", join(root, "home"));
  setEnv(
    "EGO_BROWSER_PLUGIN_BUNDLED_INDEX",
    join(root, "bundled", "index.json"),
  );
  setEnv("EGO_BROWSER_PLUGIN_INDEX", join(root, "remote", "index.json"));
  setEnv("EGO_BROWSER_PLUGIN_HINTS", undefined);
  resetHints();
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  const publish = (where, plugin) => {
    const source = join(root, `src-${where}-${plugin.id}-${plugin.version}`);
    writePlugin(join(source, plugin.id), plugin);
    buildPluginIndex({
      sourceDir: source,
      outDir: join(root, where),
      revokedPath: join(root, `${where}-revoked.json`),
    });
  };
  const revoke = (where, entries) => {
    writeFileSync(join(root, `${where}-revoked.json`), JSON.stringify(entries));
    const index = JSON.parse(
      readFileSync(join(root, where, "index.json"), "utf8"),
    );
    index.revoked = entries;
    writeFileSync(join(root, where, "index.json"), JSON.stringify(index));
  };
  // Forget when the remote index was last fetched, as if a day had passed.
  const expireIndexCache = () =>
    rmSync(join(root, "home", "index-cache.json"), { force: true });
  return {
    root,
    home: join(root, "home"),
    publish,
    revoke,
    expireIndexCache,
    setEnv,
  };
}

function writePlugin(
  dir,
  { id, version, body, domains = ["example.com"], returns },
) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "ego-plugin.json"),
    JSON.stringify({
      id,
      version,
      description: `${id} test plugin`,
      engines: { egoPluginApi: 1 },
      domains,
      commands: {
        read: {
          entry: "read.mjs",
          description: "Read things.",
          args: {
            type: "object",
            additionalProperties: false,
            properties: {
              limit: { type: "integer", minimum: 1, default: 2 },
              mode: { enum: ["ok", "drift"], default: "ok" },
            },
          },
          returns: returns || {
            type: "object",
            required: ["items", "version"],
            properties: {
              items: { type: "array", items: { type: "string" } },
              version: { type: "string" },
            },
          },
        },
      },
    }),
  );
  writeFileSync(
    join(dir, "read.mjs"),
    body ||
      `export default async function read(args, context) {
        if (args.mode === "drift") return { items: [1, 2], version: "${version}" };
        return { items: Array.from({ length: args.limit }, (_, i) => context.page.label + i), version: "${version}" };
      }\n`,
  );
}

test("JSON Schema subset validates, fills defaults and describes shapes", () => {
  const schema = {
    type: "object",
    required: ["query"],
    additionalProperties: false,
    properties: {
      query: { type: "string", minLength: 1 },
      limit: { type: "integer", minimum: 1, maximum: 10, default: 5 },
      tab: { enum: ["top", "latest"] },
      quote: {
        anyOf: [{ type: "null" }, { type: "object", required: ["text"] }],
      },
    },
  };
  const ok = validateJsonSchema(
    schema,
    { query: "a" },
    { applyDefaults: true },
  );
  assert.deepEqual(ok, { value: { query: "a", limit: 5 }, issues: [] });

  const bad = validateJsonSchema(schema, {
    limit: 11,
    tab: "x",
    extra: 1,
    quote: {},
  });
  assert.match(formatSchemaIssues(bad.issues, 10), /\$\.query: is required/);
  assert.match(formatSchemaIssues(bad.issues, 10), /\$\.limit: must be <= 10/);
  assert.match(
    formatSchemaIssues(bad.issues, 10),
    /\$\.tab: must be one of "top", "latest"/,
  );
  assert.match(formatSchemaIssues(bad.issues, 10), /\$\.extra: is not allowed/);
  assert.match(
    formatSchemaIssues(bad.issues, 10),
    /\$\.quote: does not match any allowed shape/,
  );

  assert.equal(schemaCallShape(schema), "{ query, limit?, tab?, quote? }");
  assert.equal(
    schemaResultShape({
      type: "object",
      properties: { user: { type: "string" }, posts: { type: "array" } },
    }),
    "{ user, posts[] }",
  );
});

test("official plugins install silently on first use and run with the caller's Page", async (t) => {
  const box = sandbox(t);
  box.publish("bundled", { id: "demo", version: "1.0.0" });
  setPluginHelperContext(() => ({ helperMarker: "present" }));

  const result = await runPluginCommand(page, task, "demo/read", { limit: 3 });
  assert.deepEqual(result, { items: ["p10", "p11", "p12"], version: "1.0.0" });
  const lock = readLock();
  assert.equal(lock.plugins.demo.version, "1.0.0");
  assert.equal(lock.plugins.demo.source, "official");

  // Defaults are applied, and the helper context reaches the plugin.
  writePlugin(join(box.root, "ctx", "ctxdemo"), {
    id: "ctxdemo",
    version: "1.0.0",
    body: `export default async (args, context) => ({ items: [context.helperMarker, String(args.limit)], version: context.plugin.version });\n`,
  });
  buildPluginIndex({
    sourceDir: join(box.root, "ctx"),
    outDir: join(box.root, "bundled"),
  });
  assert.deepEqual(await runPluginCommand(page, task, "ctxdemo/read"), {
    items: ["present", "2"],
    version: "1.0.0",
  });
});

test("bad arguments and drifted results surface as structured errors", async (t) => {
  const box = sandbox(t);
  box.publish("bundled", { id: "demo", version: "1.0.0" });

  await assert.rejects(
    runPluginCommand(page, task, "demo/read", { limit: 0 }),
    (error) => {
      assert.equal(error.code, "INVALID_ARGS");
      assert.match(error.message, /\$\.limit: must be >= 1/);
      assert.match(
        error.message,
        /page\.runPlugin\("demo\/read", \{ limit\?, mode\? \}\)/,
      );
      assert.match(error.message, /limit\?: integer \(default 2, 1\.\.\)/);
      return true;
    },
  );
  await assert.rejects(
    runPluginCommand(page, task, "demo/read", { mode: "drift" }),
    (error) => {
      assert.equal(error.code, "SITE_CHANGED");
      assert.match(error.message, /no longer matches/);
      assert.match(error.message, /Next: .*page\.snapshot\(\)/);
      return true;
    },
  );
  await assert.rejects(runPluginCommand(page, task, "nothing/read"), {
    code: "PLUGIN_NOT_FOUND",
  });
  await assert.rejects(runPluginCommand(page, task, "demo/write"), {
    code: "PLUGIN_NOT_FOUND",
    message: /Commands: read \{ limit\?, mode\? \}/,
  });
  await assert.rejects(runPluginCommand(page, task, "no-slash"), TypeError);
});

test("plugin code errors keep known codes and wrap unknown failures", async (t) => {
  const box = sandbox(t);
  box.publish("bundled", {
    id: "throws",
    version: "1.0.0",
    body: `export default async (args, context) => {
      if (args.mode === "drift") context.fail("NOT_LOGGED_IN", "sign in first");
      throw new TypeError("boom");
    };\n`,
  });
  await assert.rejects(
    runPluginCommand(page, task, "throws/read", { mode: "drift" }),
    (error) => {
      assert.equal(error.code, "NOT_LOGGED_IN");
      assert.match(
        error.message,
        /^\[throws\/read\] NOT_LOGGED_IN: sign in first\nNext: Ask the user to sign in/,
      );
      return true;
    },
  );
  await assert.rejects(runPluginCommand(page, task, "throws/read"), {
    code: "PLUGIN_BROKEN",
    message: /TypeError: boom/,
  });
});

test("a plugin that exceeds its timeout fails with TIMEOUT", async (t) => {
  const box = sandbox(t);
  box.publish("bundled", {
    id: "slow",
    version: "1.0.0",
    body: `export default () => new Promise((resolve) => setTimeout(resolve, 2000));\n`,
  });
  await assert.rejects(
    runPluginCommand(page, task, "slow/read", {}, { timeout: 50 }),
    { code: "TIMEOUT" },
  );
  await assert.rejects(
    runPluginCommand(page, task, "slow/read", {}, { wait: 1 }),
    /unknown option: wait/,
  );
});

test("SITE_CHANGED fetches a fixed official version and retries once", async (t) => {
  const box = sandbox(t);
  box.publish("bundled", { id: "demo", version: "1.0.0" });
  box.publish("remote", { id: "demo", version: "1.0.0" });
  assert.equal(
    (await runPluginCommand(page, task, "demo/read")).version,
    "1.0.0",
  );

  // The maintainers publish 1.0.1, which handles the redesigned page.
  box.publish("remote", {
    id: "demo",
    version: "1.0.1",
    body: `export default async () => ({ items: ["fixed"], version: "1.0.1" });\n`,
  });
  resetSink();
  const result = await runPluginCommand(page, task, "demo/read", {
    mode: "drift",
  });
  assert.deepEqual(result, { items: ["fixed"], version: "1.0.1" });
  assert.equal(readLock().plugins.demo.version, "1.0.1");
  assert.equal(readLock().plugins.demo.previous.version, "1.0.0");
  const out = [];
  flushSink({ write: (chunk) => out.push(chunk) }, false);
  assert.match(
    out.join(""),
    /reported a site change; updated 1\.0\.0 → 1\.0\.1 and retried/,
  );
});

test("daily sync updates within the major version and respects pins", async (t) => {
  const box = sandbox(t);
  box.publish("bundled", { id: "demo", version: "1.0.0" });
  await runPluginCommand(page, task, "demo/read");

  box.publish("remote", { id: "demo", version: "1.2.0" });
  box.publish("remote", { id: "demo", version: "2.0.0" });
  box.expireIndexCache();
  assert.equal(
    (await runPluginCommand(page, task, "demo/read")).version,
    "1.2.0",
  );

  // A pin holds the version even when a newer compatible one appears.
  await pinPlugin("demo");
  box.publish("remote", { id: "demo", version: "1.3.0" });
  box.expireIndexCache();
  assert.equal(
    (await runPluginCommand(page, task, "demo/read")).version,
    "1.2.0",
  );

  // An explicit update crosses the major version and clears the pin.
  const updates = await updatePlugin("demo");
  assert.deepEqual(updates, [
    { id: "demo", from: "1.2.0", to: "2.0.0", status: "updated" },
  ]);
  assert.equal(
    (await runPluginCommand(page, task, "demo/read")).version,
    "2.0.0",
  );

  // Rolling back restores the previous version and pins it.
  const rolledBack = await rollbackPlugin("demo");
  assert.equal(rolledBack.version, "1.2.0");
  assert.equal(rolledBack.pinned, true);
  assert.equal(
    (await runPluginCommand(page, task, "demo/read")).version,
    "1.2.0",
  );
});

test("revoked versions never run; official ones move to a safe version", async (t) => {
  const box = sandbox(t);
  box.publish("bundled", { id: "demo", version: "1.0.0" });
  box.publish("remote", { id: "demo", version: "1.0.0" });
  await runPluginCommand(page, task, "demo/read");

  box.revoke("remote", [
    { id: "demo", versions: ["1.0.0"], reason: "leaked tokens" },
  ]);
  box.expireIndexCache();
  await assert.rejects(runPluginCommand(page, task, "demo/read"), {
    code: "PLUGIN_REVOKED",
    message: /demo@1\.0\.0 was withdrawn: leaked tokens/,
  });

  box.publish("remote", { id: "demo", version: "1.0.1" });
  box.revoke("remote", [
    { id: "demo", versions: ["1.0.0"], reason: "leaked tokens" },
  ]);
  box.expireIndexCache();
  assert.equal(
    (await runPluginCommand(page, task, "demo/read")).version,
    "1.0.1",
  );
});

test("modified installed files are restored for official plugins and refused for third-party ones", async (t) => {
  const box = sandbox(t);
  box.publish("bundled", { id: "demo", version: "1.0.0" });
  await runPluginCommand(page, task, "demo/read");
  const installed = join(box.home, "installed", "demo", "1.0.0", "read.mjs");
  writeFileSync(
    installed,
    `export default async () => ({ items: ["tampered"], version: "x" });\n`,
  );
  assert.equal(
    (await runPluginCommand(page, task, "demo/read")).version,
    "1.0.0",
  );
  assert.doesNotMatch(readFileSync(installed, "utf8"), /tampered/);

  const thirdParty = join(box.root, "third", "acme.feed");
  writePlugin(thirdParty, { id: "acme.feed", version: "0.1.0" });
  await installPlugin(thirdParty, { allowThirdParty: true });
  writeFileSync(
    join(box.home, "installed", "acme.feed", "0.1.0", "read.mjs"),
    `export default async () => ({ items: [], version: "x" });\n`,
  );
  await assert.rejects(runPluginCommand(page, task, "acme.feed/read"), {
    code: "PLUGIN_BROKEN",
    message: /changed after installation/,
  });
});

test("third-party plugins need explicit consent, keep their own ids, and never auto-update", async (t) => {
  const box = sandbox(t);
  box.publish("bundled", { id: "demo", version: "1.0.0" });
  const source = join(box.root, "third", "acme.feed");
  writePlugin(source, { id: "acme.feed", version: "0.1.0" });

  await assert.rejects(installPlugin(source), {
    code: "PLUGIN_INSTALL_FAILED",
    message: /installPlugin\(source, \{ allowThirdParty: true \}\)/,
  });
  const info = await installPlugin(source, { allowThirdParty: true });
  assert.equal(info.source, "third-party");
  assert.equal(info.version, "0.1.0");
  assert.equal(readLock().plugins["acme.feed"].origin, source);

  // The source changes, but nothing updates until updatePlugin() is called.
  writePlugin(source, { id: "acme.feed", version: "0.2.0" });
  box.expireIndexCache();
  assert.equal(
    (await runPluginCommand(page, task, "acme.feed/read")).version,
    "0.1.0",
  );
  assert.deepEqual(await updatePlugin("acme.feed"), [
    { id: "acme.feed", from: "0.1.0", to: "0.2.0", status: "updated" },
  ]);
  assert.equal(
    (await runPluginCommand(page, task, "acme.feed/read")).version,
    "0.2.0",
  );

  const impostor = join(box.root, "third", "demo");
  writePlugin(impostor, { id: "demo", version: "9.0.0" });
  await assert.rejects(installPlugin(impostor, { allowThirdParty: true }), {
    message: /belongs to an official plugin/,
  });
  await assert.rejects(installPlugin("nonexistent"), {
    code: "PLUGIN_NOT_FOUND",
  });

  assert.equal(await removePlugin("acme.feed"), true);
  await assert.rejects(runPluginCommand(page, task, "acme.feed/read"), {
    code: "PLUGIN_NOT_FOUND",
  });
});

test("local plugins load from the local directory first and reload after edits", async (t) => {
  const box = sandbox(t);
  box.publish("bundled", { id: "demo", version: "1.0.0" });
  const local = join(box.home, "local", "my-demo");
  writePlugin(local, {
    id: "demo",
    version: "1.5.0",
    body: `export default async () => ({ items: ["local"], version: "1.5.0" });\n`,
  });
  assert.deepEqual(await runPluginCommand(page, task, "demo/read"), {
    items: ["local"],
    version: "1.5.0",
  });
  assert.equal(readLock().plugins.demo, undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  writeFileSync(
    join(local, "read.mjs"),
    `export default async () => ({ items: ["edited"], version: "1.5.0" });\n`,
  );
  assert.deepEqual((await runPluginCommand(page, task, "demo/read")).items, [
    "edited",
  ]);

  const listed = await plugins("https://www.example.com/path");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].source, "local");
  assert.equal(
    listed[0].commands[0].call,
    'await page.runPlugin("demo/read", { limit?, mode? })',
  );
  assert.deepEqual(await plugins("other.org"), []);
  assert.equal((await plugins({ query: "read things" })).length, 1);
});

test("hints name the call once per task space and skip plugins already used", async (t) => {
  const box = sandbox(t);
  box.publish("bundled", {
    id: "demo",
    version: "1.0.0",
    domains: ["example.com"],
  });
  const fakeTask = { name: "hint-space", cdp: async () => ({}) };
  const hintPage = { label: "p2", spaceId: 11, targetId: "T1" };
  const url = async () => "https://news.example.com/item/1";

  notePageTouched(hintPage, fakeTask);
  const first = await buildRoundHints(url);
  assert.match(
    first,
    /^\[ego-browser:plugins\] Page p2 is on news\.example\.com\./,
  );
  assert.match(
    first,
    /await page\.runPlugin\("demo\/read", \{ limit\?, mode\? \}\) → \{ items\[\], version \}  Read things\./,
  );
  assert.match(first, /plugins\("news\.example\.com"\)/);

  resetHints();
  notePageTouched(hintPage, fakeTask);
  assert.equal(
    await buildRoundHints(url),
    undefined,
    "a seen hint is not repeated",
  );

  resetHints();
  notePageTouched({ ...hintPage, spaceId: 12 }, fakeTask);
  notePluginUsed(12, "hint-space", "demo");
  assert.equal(
    await buildRoundHints(url),
    undefined,
    "a used plugin needs no hint",
  );

  resetHints();
  box.setEnv("EGO_BROWSER_PLUGIN_HINTS", "0");
  notePageTouched({ ...hintPage, spaceId: 13 }, fakeTask);
  assert.equal(await buildRoundHints(url), undefined, "hints can be disabled");
});

test("round finalizers append after the output and are dropped on a hard stop", async () => {
  resetSink();
  bufferOutput("result\n");
  registerRoundFinalizer(async () => "hint");
  await runRoundFinalizers();
  const out = [];
  flushSink({ write: (chunk) => out.push(chunk) }, false);
  assert.equal(out.join(""), "result\nhint\n");

  resetSink();
  bufferOutput("result\n");
  registerRoundFinalizer(async () => "hint");
  markHardStop("stop here");
  await runRoundFinalizers();
  const stopped = [];
  flushSink({ write: (chunk) => stopped.push(chunk) }, false);
  assert.equal(stopped.join(""), "stop here\n");
  resetSink();
});

test("the index builder and the runtime agree on bundle integrity", (t) => {
  const box = sandbox(t);
  box.publish("bundled", { id: "demo", version: "1.0.0" });
  const index = JSON.parse(
    readFileSync(join(box.root, "bundled", "index.json"), "utf8"),
  );
  const source = join(box.root, "src-bundled-demo-1.0.0", "demo");
  assert.equal(
    index.plugins[0].versions[0].integrity,
    bundleIntegrity(bundleFromDirectory(source)),
  );
});

test("official plugins in ego-plugins/ have valid manifests and existing entries", () => {
  const dir = join(repoRoot, "ego-plugins", "plugins");
  const ids = readdirSync(dir);
  assert.deepEqual(ids.sort(), ["wikipedia", "x"]);
  for (const id of ids) {
    const bundle = bundleFromDirectory(join(dir, id));
    validateManifest(bundle.manifest);
    assert.equal(bundle.manifest.id, id);
    for (const command of Object.values(bundle.manifest.commands)) {
      assert.equal(command.readOnly, true);
      assert.ok(
        command.returns,
        "official commands declare returns to detect site changes",
      );
    }
  }
});
