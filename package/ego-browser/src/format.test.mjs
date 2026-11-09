import test from "node:test";
import assert from "node:assert/strict";

import { formatCliLogValue } from "../dist/src/format.js";

test("formatCliLogValue preserves useful Error details", () => {
  const output = formatCliLogValue(new Error("page action failed"));

  assert.match(output, /Error: page action failed/);
  assert.match(output, /format\.test\.mjs/);
});

test("formatCliLogValue handles circular objects without throwing", () => {
  const value = { name: "root" };
  value.self = value;

  assert.match(formatCliLogValue(value), /Circular/);
});

test("formatCliLogValue shows Map, Set, and function values", () => {
  assert.match(
    formatCliLogValue(new Map([["status", 200]])),
    /Map\(1\).*status.*200/,
  );
  assert.match(formatCliLogValue(new Set(["ready"])), /Set\(1\).*ready/);
  assert.match(
    formatCliLogValue(function runTask() {}),
    /runTask/,
  );
});
