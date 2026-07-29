import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const marketplaceUrl = new URL(
  "../../../.claude-plugin/marketplace.json",
  import.meta.url,
);
const manifestUrl = new URL(
  "../../../.codex-plugin/plugin.json",
  import.meta.url,
);

test("marketplace plugin name matches the Codex plugin manifest", () => {
  const marketplace = JSON.parse(
    readFileSync(fileURLToPath(marketplaceUrl), "utf8"),
  );
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(manifestUrl), "utf8"),
  );

  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].name, manifest.name);
});
