import test from "node:test";
import assert from "node:assert/strict";

import { parseRef } from "../dist/src/ref-map.js";

test("parseRef accepts action forms but not the full snapshot annotation", () => {
  assert.equal(parseRef("@21"), "21");
  assert.equal(parseRef("ref=21"), "21");
  assert.equal(parseRef("21"), "21");
  assert.equal(parseRef("[ref=21]"), null);
});
