import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactPath = join(root, "artifacts", "ego-browser", "index.js");

test("real browser runtime can navigate, inspect page info, and snapshot", { skip: process.env.EGO_BROWSER_E2E !== "1" }, () => {
  const script = `
    await openOrReuseTab('data:text/html,<title>Ego E2E</title><button id="go">Go</button>', { wait: true });
    const info = await pageInfo();
    const text = await snapshotText();
    cliLog(JSON.stringify({ title: info.title, hasButton: text.includes('Go') }));
  `;
  const result = spawnSync(process.execPath, [artifactPath], {
    cwd: root,
    input: script,
    encoding: "utf8",
    timeout: 20_000
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.deepEqual(payload, { title: "Ego E2E", hasButton: true });
});
