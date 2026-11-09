import test from "node:test";
import assert from "node:assert/strict";

import { formatHelp, help } from "../dist/src/help-runtime.js";

test("help resolves public aliases from the API schema", () => {
  const pageClick = help({}, "page.click");

  assert.equal(pageClick.name, "Page.click");
  assert.match(pageClick.signature, /await page\.click/);
  assert.match(pageClick.description, /timeout/);
  assert.match(formatHelp(pageClick), /Page\.click[\s\S]*await page\.click/);
});

test("help keeps legacy and unknown names out of the public surface", () => {
  assert.equal(
    help({ oldHelper() {} }, "oldHelper"),
    'Legacy helper hidden from default help: oldHelper. Use help("legacy", "oldHelper").',
  );
  assert.equal(help({}, "missingHelper"), "Unknown helper: missingHelper");
});
