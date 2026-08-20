import test from "node:test";
import assert from "node:assert/strict";

import { setOverrides } from "../../dist/src/state.js";
import { browserRefMap } from "../../dist/src/ref-state.js";
import {
  allInnerTexts,
  allTextContents,
  blur,
  boundingBox,
  count,
  evaluateAll,
  evaluateLocator,
  getAttribute,
  innerHTML,
  innerText,
  isDisabled,
  inputValue,
  isChecked,
  isEditable,
  isEnabled,
  isHidden,
  isVisible,
  textContent,
} from "../../dist/src/driver/locator.js";

function internalSelector(kind, data) {
  return `internal:${kind}:${encodeURIComponent(JSON.stringify(data))}`;
}

test("locator read helpers call a resolved element", async () => {
  const calls = [];
  const values = ["text content", "inner text", "input value", true, "button"];
  const restore = setOverrides({
    cdpOverride(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === "Runtime.evaluate") {
        return { result: { objectId: "node-1" } };
      }
      if (method === "Runtime.callFunctionOn") {
        return { result: { value: values.shift() } };
      }
      return {};
    },
  });
  try {
    assert.equal(await textContent("#message"), "text content");
    assert.equal(await innerText("#message"), "inner text");
    assert.equal(await inputValue("#email"), "input value");
    assert.equal(await isChecked("#terms"), true);
    assert.equal(await getAttribute("#submit", "type"), "button");
  } finally {
    restore();
  }

  assert.equal(
    calls.filter((call) => call.method === "Runtime.callFunctionOn").length,
    5,
  );
  assert.equal(
    calls.filter((call) => call.method === "Runtime.releaseObject").length,
    5,
  );
});

test("required locator reads retry transient zero matches", async () => {
  let attempts = 0;
  let now = 0;
  const sleeps = [];
  const restore = setOverrides({
    defaultTimeout: 500,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    cdpOverride(method) {
      if (method === "Runtime.evaluate") {
        attempts += 1;
        return attempts < 3
          ? { result: {} }
          : { result: { objectId: "node-delayed" } };
      }
      if (method === "Runtime.callFunctionOn") {
        return { result: { value: "delayed content" } };
      }
      return {};
    },
  });
  try {
    assert.equal(await textContent("#delayed-content"), "delayed content");
  } finally {
    restore();
  }

  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [100, 100]);
});

test("locator collection helpers evaluate all matching nodes", async () => {
  const restore = setOverrides({
    cdpOverride(method, params) {
      assert.equal(method, "Runtime.evaluate");
      if (params.expression.includes("elements.length")) {
        assert.match(params.expression, /querySelectorAll\("\.item"\)/);
        return { result: { value: 2 } };
      }
      if (params.expression.includes("innerText")) {
        return { result: { value: ["One", "Two"] } };
      }
      return { result: { value: ["A", "B"] } };
    },
  });
  try {
    assert.equal(await count(".item"), 2);
    assert.deepEqual(await allInnerTexts(".item"), ["One", "Two"]);
    assert.deepEqual(await allTextContents("loc=css:.item"), ["A", "B"]);
  } finally {
    restore();
  }
});

test("test id locators query data-testid attributes exactly", async () => {
  const restore = setOverrides({
    cdpOverride(method, params) {
      assert.equal(method, "Runtime.evaluate");
      assert.match(params.expression, /\[data-testid\]/);
      assert.match(params.expression, /getAttribute\("data-testid"\)/);
      assert.match(params.expression, /=== "submit"/);
      return { result: { value: 1 } };
    },
  });
  try {
    assert.equal(await count('loc=testid:exact:"submit"'), 1);
  } finally {
    restore();
  }
});

test("scoped locators query descendants of each base element", async () => {
  const scoped = internalSelector("scope", {
    base: ".card",
    child: 'loc=testid:exact:"submit"',
  });
  const restore = setOverrides({
    cdpOverride(method, params) {
      assert.equal(method, "Runtime.evaluate");
      assert.match(params.expression, /querySelectorAll\("\.card"\)/);
      assert.match(params.expression, /\[data-testid\]/);
      assert.match(params.expression, /for \(const root of roots\)/);
      return { result: { value: 2 } };
    },
  });
  try {
    assert.equal(await count(scoped), 2);
  } finally {
    restore();
  }
});

test("filter locators support hasText, hasNotText, has, and hasNot", async () => {
  const scoped = internalSelector("filter", {
    base: ".row",
    hasText: { text: "Ready", exact: false },
    hasNotText: { regex: "Archived", flags: "i" },
    has: 'loc=testid:exact:"action"',
    hasNot: ".disabled",
  });
  const restore = setOverrides({
    cdpOverride(method, params) {
      assert.equal(method, "Runtime.evaluate");
      assert.match(params.expression, /querySelectorAll\("\.row"\)/);
      assert.match(params.expression, /includes\("Ready"\)/);
      assert.match(params.expression, /new RegExp\("Archived", "i"\)/);
      assert.match(params.expression, /\[data-testid\]/);
      assert.match(params.expression, /querySelectorAll\("\.disabled"\)/);
      return { result: { value: 1 } };
    },
  });
  try {
    assert.equal(await count(scoped), 1);
  } finally {
    restore();
  }
});

test("role locators use AX regex accessible names in collection queries", async () => {
  const selector = `loc=role:button[name=${JSON.stringify({
    regex: "checkout",
    flags: "i",
  })}]`;
  const calls = [];
  const restore = setOverrides({
    cdpOverride(method, params) {
      calls.push({ method, params });
      if (method === "Accessibility.getFullAXTree") {
        return {
          nodes: [
            {
              role: { value: "button" },
              name: { value: "Proceed to Checkout" },
              backendDOMNodeId: 101,
            },
          ],
        };
      }
      throw new Error(`Unexpected CDP method: ${method}`);
    },
  });
  try {
    assert.equal(await count(selector), 1);
  } finally {
    restore();
  }
  assert.deepEqual(
    calls.map((call) => call.method),
    ["Accessibility.getFullAXTree"],
  );
});

test("role collections use the same AX match set as nth element operations", async () => {
  const selector = 'loc=role:option[name="House"]';
  const second = `internal:nth=1;${selector}`;
  const calls = [];
  const restore = setOverrides({
    cdpOverride(method, params) {
      calls.push({ method, params });
      if (method === "Accessibility.getFullAXTree") {
        return {
          nodes: [
            {
              role: { value: "option" },
              name: { value: "House" },
              backendDOMNodeId: 100,
            },
            {
              role: { value: "option" },
              name: { value: "House" },
              backendDOMNodeId: 200,
            },
          ],
        };
      }
      if (method === "DOM.resolveNode") {
        return { object: { objectId: `node-${params.backendNodeId}` } };
      }
      if (method === "Runtime.callFunctionOn") {
        if (params.functionDeclaration.includes("innerText target")) {
          assert.equal(params.objectId, "node-200");
          return { result: { value: "House 2" } };
        }
        assert.deepEqual(
          [
            params.objectId,
            ...params.arguments
              .filter((argument) => argument.objectId)
              .map((argument) => argument.objectId),
          ],
          ["node-100", "node-200"],
        );
        const functionSource = params.arguments.find(
          (argument) =>
            typeof argument.value === "string" &&
            argument.value.includes("elements"),
        )?.value;
        if (functionSource?.includes("allInnerTexts targets")) {
          return { result: { value: ["House 1", "House 2"] } };
        }
        return { result: { value: ["HOUSE 1", "HOUSE 2"] } };
      }
      if (method === "Runtime.releaseObject") {
        return {};
      }
      throw new Error(`Unexpected CDP method: ${method}`);
    },
  });
  try {
    assert.equal(await count(selector), 2);
    assert.equal(await count(second), 1);
    assert.equal(await innerText(second), "House 2");
    assert.deepEqual(await allInnerTexts(selector), ["House 1", "House 2"]);
    assert.deepEqual(
      await evaluateAll(selector, (elements) =>
        elements.map((element) => element.textContent.toUpperCase()),
      ),
      ["HOUSE 1", "HOUSE 2"],
    );
  } finally {
    restore();
  }
  assert.equal(
    calls.some((call) => call.method === "Runtime.evaluate"),
    false,
  );
});

test("raw Playwright has-text selectors filter native CSS candidates", async () => {
  const restore = setOverrides({
    cdpOverride(method, params) {
      assert.equal(method, "Runtime.evaluate");
      assert.match(params.expression, /querySelectorAll\("button"\)/);
      assert.match(params.expression, /includes\("Skip to Checkout"\)/);
      return { result: { value: 1 } };
    },
  });
  try {
    assert.equal(await count('button:has-text("Skip to Checkout")'), 1);
  } finally {
    restore();
  }
});

test("locator state helpers read element state and tolerate missing elements", async () => {
  const values = [true, true, true];
  const restore = setOverrides({
    cdpOverride(method, params) {
      if (method === "Runtime.evaluate") {
        return { result: { objectId: "node-1" } };
      }
      if (method === "Runtime.callFunctionOn") {
        return { result: { value: values.shift() } };
      }
      return {};
    },
  });
  try {
    assert.equal(await isVisible("#status"), true);
    assert.equal(await isEnabled("#status"), true);
    assert.equal(await isEditable("#status"), true);
  } finally {
    restore();
  }

  const missingRestore = setOverrides({
    cdpOverride(method) {
      if (method === "Runtime.evaluate") {
        return { result: {} };
      }
      return {};
    },
  });
  try {
    assert.equal(await isVisible("#missing"), false);
    assert.equal(await isHidden("#missing"), true);
    assert.equal(await isEnabled("#missing"), false);
    assert.equal(await isDisabled("#missing"), true);
    assert.equal(await isEditable("#missing"), false);
  } finally {
    missingRestore();
  }
});

test("innerHTML, blur, and boundingBox use the resolved element", async () => {
  const values = [
    "<span>Ready</span>",
    undefined,
    { x: 1, y: 2, width: 3, height: 4 },
  ];
  const restore = setOverrides({
    cdpOverride(method, params) {
      if (method === "Runtime.evaluate") {
        return { result: { objectId: "node-1" } };
      }
      if (method === "Runtime.callFunctionOn") {
        return { result: { value: values.shift() } };
      }
      return {};
    },
  });
  try {
    assert.equal(await innerHTML("#status"), "<span>Ready</span>");
    await blur("#status");
    assert.deepEqual(await boundingBox("#status"), {
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    });
  } finally {
    restore();
  }
});

test("evaluateAll runs a page function with matching elements and an argument", async () => {
  const restore = setOverrides({
    cdpOverride(method, params) {
      assert.equal(method, "Runtime.evaluate");
      assert.equal(params.awaitPromise, true);
      assert.match(params.expression, /querySelectorAll\("\.item"\)/);
      assert.match(
        params.expression,
        /pageFunction\(elements, \{"prefix":"#"\}\)/,
      );
      assert.match(params.expression, /elements\.map/);
      return { result: { value: ["#One", "#Two"] } };
    },
  });
  try {
    const values = await evaluateAll(
      ".item",
      (elements, options) =>
        elements.map((element) => options.prefix + element.textContent),
      { prefix: "#" },
    );
    assert.deepEqual(values, ["#One", "#Two"]);
  } finally {
    restore();
  }
});

test("evaluateLocator runs a page function with one resolved element and an argument", async () => {
  const calls = [];
  const restore = setOverrides({
    cdpOverride(method, params) {
      calls.push({ method, params });
      if (method === "Runtime.evaluate") {
        return { result: { objectId: "node-1" } };
      }
      if (method === "Runtime.callFunctionOn") {
        assert.match(params.functionDeclaration, /pageFunction\(this, arg\)/);
        assert.deepEqual(
          params.arguments.map((item) => item.value),
          [
            "(element, options) => options.prefix + element.textContent",
            { prefix: "#" },
          ],
        );
        return { result: { value: "#One" } };
      }
      return {};
    },
  });
  try {
    const value = await evaluateLocator(
      ".item",
      (element, options) => options.prefix + element.textContent,
      { prefix: "#" },
    );
    assert.equal(value, "#One");
  } finally {
    restore();
  }
  assert.equal(calls[0].method, "Runtime.evaluate");
  assert.equal(calls.at(-1).method, "Runtime.releaseObject");
});

test("evaluateLocator awaits a promise returned by an async page function", async () => {
  const restore = setOverrides({
    cdpOverride(method, params) {
      if (method === "Runtime.evaluate") {
        return { result: { objectId: "node-1" } };
      }
      if (method === "Runtime.callFunctionOn") {
        assert.equal(
          params.awaitPromise,
          true,
          "async locator.evaluate must ask CDP to await the returned promise",
        );
        // Simulate Chromium: the resolved value is only returned when awaitPromise
        // is set; otherwise an unresolved promise serializes to {}.
        return params.awaitPromise
          ? { result: { value: "resolved" } }
          : { result: { value: {} } };
      }
      return {};
    },
  });
  try {
    const value = await evaluateLocator(".item", async () => "resolved");
    assert.equal(value, "resolved");
  } finally {
    restore();
  }
});

test("evaluateAll awaits a promise for a ref selector", async () => {
  browserRefMap.clear();
  browserRefMap.add("1", 123, "button", "Submit");
  const restore = setOverrides({
    cdpOverride(method, params) {
      if (method === "DOM.resolveNode") {
        return { object: { objectId: "node-1" } };
      }
      if (method === "Runtime.callFunctionOn") {
        assert.equal(params.awaitPromise, true);
        return params.awaitPromise
          ? { result: { value: 42 } }
          : { result: { value: {} } };
      }
      return {};
    },
  });
  try {
    assert.equal(await evaluateAll("@1", async () => 42), 42);
  } finally {
    browserRefMap.clear();
    restore();
  }
});

test("plain element reads do not await promises (unchanged)", async () => {
  const restore = setOverrides({
    cdpOverride(method, params) {
      if (method === "Runtime.evaluate") {
        return { result: { objectId: "node-1" } };
      }
      if (method === "Runtime.callFunctionOn") {
        assert.notEqual(
          params.awaitPromise,
          true,
          "synchronous reads must not opt into promise awaiting",
        );
        return { result: { value: "hello" } };
      }
      return {};
    },
  });
  try {
    assert.equal(await textContent(".item"), "hello");
  } finally {
    restore();
  }
});

test("evaluateAll supports refs as a single-element array", async () => {
  const calls = [];
  browserRefMap.clear();
  browserRefMap.add("1", 123, "button", "Submit");
  const restore = setOverrides({
    cdpOverride(method, params) {
      calls.push({ method, params });
      if (method === "DOM.resolveNode") {
        return { object: { objectId: "node-1" } };
      }
      if (method === "Runtime.callFunctionOn") {
        assert.match(
          params.functionDeclaration,
          /pageFunction\(\[this\], arg\)/,
        );
        assert.deepEqual(
          params.arguments.map((item) => item.value),
          ["elements => elements.length", undefined],
        );
        return { result: { value: 1 } };
      }
      return {};
    },
  });
  try {
    assert.equal(await evaluateAll("@1", "elements => elements.length"), 1);
  } finally {
    browserRefMap.clear();
    restore();
  }
  assert.equal(calls[0].method, "DOM.resolveNode");
  assert.equal(calls.at(-1).method, "Runtime.releaseObject");
});

test("count treats a resolved ref as one element", async () => {
  const calls = [];
  browserRefMap.clear();
  browserRefMap.add("1", 123, "button", "Submit");
  const restore = setOverrides({
    cdpOverride(method, params) {
      calls.push({ method, params });
      if (method === "DOM.resolveNode") {
        return { object: { objectId: "node-1" } };
      }
      return {};
    },
  });
  try {
    assert.equal(await count("@1"), 1);
  } finally {
    browserRefMap.clear();
    restore();
  }
  assert.equal(calls[0].method, "DOM.resolveNode");
  assert.equal(calls.at(-1).method, "Runtime.releaseObject");
});
