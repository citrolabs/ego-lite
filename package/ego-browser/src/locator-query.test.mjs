import test from "node:test";
import assert from "node:assert/strict";

import { queryAllExpression } from "../dist/src/locator-query.js";

// Implicit roles per ARIA in HTML. An empty role means the input type has no
// corresponding role and must not match any role locator.
const INPUT_ROLES = [
  [null, "textbox"],
  ["text", "textbox"],
  ["email", "textbox"],
  ["tel", "textbox"],
  ["url", "textbox"],
  ["unknown-type", "textbox"],
  ["search", "searchbox"],
  ["number", "spinbutton"],
  ["range", "slider"],
  ["checkbox", "checkbox"],
  ["radio", "radio"],
  ["button", "button"],
  ["submit", "button"],
  ["reset", "button"],
  ["image", "button"],
  ["color", ""],
  ["date", ""],
  ["datetime-local", ""],
  ["file", ""],
  ["hidden", ""],
  ["month", ""],
  ["password", ""],
  ["time", ""],
  ["week", ""],
];

const NO_ROLE_TYPES = INPUT_ROLES.filter(([, role]) => !role).map(
  ([type]) => type,
);

function fakeInput(type) {
  const attributes = type === null ? {} : { type };
  return {
    tagName: "INPUT",
    label: type === null ? "<input>" : `<input type="${type}">`,
    getAttribute: (name) =>
      Object.prototype.hasOwnProperty.call(attributes, name)
        ? attributes[name]
        : null,
    hasAttribute: (name) =>
      Object.prototype.hasOwnProperty.call(attributes, name),
    setAttribute: (name, value) => {
      attributes[name] = value;
    },
  };
}

function fakeDocument(inputs) {
  const form = { querySelectorAll: () => inputs };
  return {
    querySelectorAll: (selector) => (selector === "form" ? [form] : inputs),
    getElementById: () => null,
  };
}

// Chained locators (page.locator("form").getByRole(...)) keep the injected-JS
// DOM path, so this is the code path the implicit-role table actually serves.
function matchingInputs(role, inputs) {
  const selector = `internal:scope:${encodeURIComponent(
    JSON.stringify({ base: "form", child: `loc=role:${role}` }),
  )}`;
  const evaluate = new Function(
    "document",
    `return ${queryAllExpression(selector)};`,
  );
  return evaluate(fakeDocument(inputs)).map((element) => element.label);
}

test("chained role locators map input types to their implicit ARIA roles", () => {
  const inputs = INPUT_ROLES.map(([type]) => fakeInput(type));
  const roles = new Set(INPUT_ROLES.map(([, role]) => role));
  roles.delete("");
  for (const role of roles) {
    const expected = inputs
      .filter((_, index) => INPUT_ROLES[index][1] === role)
      .map((element) => element.label);
    assert.deepEqual(matchingInputs(role, inputs), expected, `role:${role}`);
  }
});

test("chained role locators skip input types with no implicit role", () => {
  const inputs = NO_ROLE_TYPES.map((type) => fakeInput(type));
  for (const role of ["textbox", "searchbox", "spinbutton", "button"]) {
    assert.deepEqual(matchingInputs(role, inputs), [], `role:${role}`);
  }
});

test("chained role locators treat a datalist-backed input as a combobox", () => {
  const inputs = ["text", "search"].map((type) => {
    const input = fakeInput(type);
    input.setAttribute("list", "suggestions");
    return input;
  });
  assert.deepEqual(matchingInputs("combobox", inputs), [
    '<input type="text">',
    '<input type="search">',
  ]);
  assert.deepEqual(matchingInputs("textbox", inputs), []);
  assert.deepEqual(matchingInputs("searchbox", inputs), []);
});
