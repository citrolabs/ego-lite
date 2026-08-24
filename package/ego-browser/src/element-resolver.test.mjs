import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveElementCenter,
  resolveElementObjectId,
  ElementResolutionError,
} from "../dist/src/element-resolver.js";
import { RefMap } from "../dist/src/ref-map.js";

class FakeCDP {
  constructor(handler) {
    this.calls = [];
    this.handler = handler;
  }

  async sendRaw(method, params = {}, sessionId = undefined) {
    this.calls.push([method, params, sessionId]);
    return this.handler(method, params, sessionId);
  }
}

const AX_TREE = {
  nodes: [
    { role: { value: "button" }, name: { value: "ok" }, backendDOMNodeId: 100 },
  ],
};

test("resolveElementCenter computes the center from a valid box model", async () => {
  const refMap = new RefMap();
  refMap.add("5", 100, "button", "ok");
  const cdp = new FakeCDP(async (method) => {
    if (method === "DOM.getBoxModel") {
      return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
    }
    return {};
  });
  const point = await resolveElementCenter(cdp, undefined, refMap, "@5");
  assert.equal(point.x, 5);
  assert.equal(point.y, 5);
});

test("degenerate box model throws transient instead of returning (0,0)", async () => {
  // Regression: boxModelCenter used to return {x:0,y:0} for a missing content
  // quad, which made callers click the top-left viewport corner.
  const refMap = new RefMap();
  refMap.add("5", 100, "button", "ok");
  const cdp = new FakeCDP(async (method) => {
    if (method === "DOM.getBoxModel") {
      return { model: { content: [] } };
    }
    if (method === "Accessibility.getFullAXTree") {
      return AX_TREE;
    }
    return {};
  });
  await assert.rejects(
    () => resolveElementCenter(cdp, undefined, refMap, "@5"),
    (error) => {
      assert.ok(error instanceof ElementResolutionError);
      assert.equal(error.kind, "transient");
      assert.match(error.message, /no box model/);
      return true;
    },
  );
  assert.ok(
    !cdp.calls.some(([method]) => method === "Accessibility.getFullAXTree"),
    "must not fall back to role/name lookup — it could match a different node with the same label",
  );
});

test("stale backend node still falls back to role/name lookup", async () => {
  const refMap = new RefMap();
  refMap.add("5", 100, "button", "ok");
  let boxModelCalls = 0;
  const cdp = new FakeCDP(async (method) => {
    if (method === "DOM.getBoxModel") {
      boxModelCalls += 1;
      if (boxModelCalls === 1) {
        throw new Error("No node with given id found");
      }
      return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
    }
    if (method === "Accessibility.getFullAXTree") {
      return AX_TREE;
    }
    return {};
  });
  const point = await resolveElementCenter(cdp, undefined, refMap, "@5");
  assert.equal(point.x, 5);
  assert.equal(point.y, 5);
  assert.ok(
    cdp.calls.some(([method]) => method === "Accessibility.getFullAXTree"),
    "a stale node must trigger the role/name fallback",
  );
});

test("role locator with degenerate box model throws transient", async () => {
  const cdp = new FakeCDP(async (method) => {
    if (method === "Accessibility.getFullAXTree") {
      return AX_TREE;
    }
    if (method === "DOM.getBoxModel") {
      return { model: {} };
    }
    return {};
  });
  await assert.rejects(
    () =>
      resolveElementCenter(
        cdp,
        undefined,
        new RefMap(),
        'loc=role:button[name="ok"]',
      ),
    (error) => {
      assert.ok(error instanceof ElementResolutionError);
      assert.equal(error.kind, "transient");
      return true;
    },
  );
});

test("CSS locators search nested open shadow roots", async () => {
  const cdp = new FakeCDP(async (method, params) => {
    if (method === "Runtime.evaluate") {
      assert.match(
        params.expression,
        /shadowRoot/,
        "the CSS query must visit open shadow roots instead of using only document.querySelectorAll",
      );
      return { result: { value: { x: 12, y: 34 } } };
    }
    return {};
  });

  const point = await resolveElementCenter(
    cdp,
    undefined,
    new RefMap(),
    'loc=css:input[aria-label="Shadow field"]',
  );

  assert.deepEqual(point, { x: 12, y: 34, sessionId: undefined });
});

test("Playwright css= aliases the documented CSS locator", async () => {
  const cdp = new FakeCDP(async (method, params) => {
    if (method === "Runtime.evaluate") {
      assert.match(params.expression, /button#target/);
      assert.doesNotMatch(
        params.expression,
        /__egoQueryAllOpenShadow\("css=button/,
      );
      return { result: { value: { x: 7, y: 9 } } };
    }
    return {};
  });

  const point = await resolveElementCenter(
    cdp,
    undefined,
    new RefMap(),
    "css=button#target",
  );

  assert.deepEqual(point, { x: 7, y: 9, sessionId: undefined });
});

test("Playwright has-text and text-is pseudos keep their matching semantics", async () => {
  const expressions = [];
  const cdp = new FakeCDP(async (method, params) => {
    if (method === "Runtime.evaluate") {
      expressions.push(params.expression);
      return { result: { value: { x: 11, y: 13 } } };
    }
    return {};
  });

  await resolveElementCenter(
    cdp,
    undefined,
    new RefMap(),
    'button:has-text("Save changes")',
  );
  await resolveElementCenter(
    cdp,
    undefined,
    new RefMap(),
    "loc=css:button:text-is('Save')",
  );

  assert.match(expressions[0], /selector: "button"/);
  assert.match(expressions[0], /mode: "substring"/);
  assert.match(expressions[0], /toLowerCase\(\)\.includes/);
  assert.match(expressions[1], /mode: "exact"/);
  assert.match(expressions[1], /immediate\.some/);
});

test("Playwright text pseudos strictly decode quoted CSS strings", async () => {
  const cdp = new FakeCDP(async (method, params) => {
    if (method === "Runtime.evaluate") {
      assert.match(params.expression, /can&apos;t|can't/);
      return { result: { value: { x: 9, y: 11 } } };
    }
    return {};
  });

  const point = await resolveElementCenter(
    cdp,
    undefined,
    new RefMap(),
    String.raw`button:text-is('can\'t')`,
  );

  assert.deepEqual(point, { x: 9, y: 11, sessionId: undefined });
});

test("Playwright text pseudos decode CSS hex escapes and their terminator", async () => {
  const cdp = new FakeCDP(async (method, params) => {
    if (method === "Runtime.evaluate") {
      assert.match(params.expression, /text: "AB"/);
      return { result: { value: { x: 10, y: 12 } } };
    }
    return {};
  });

  const point = await resolveElementCenter(
    cdp,
    undefined,
    new RefMap(),
    String.raw`button:text-is("\41 B")`,
  );

  assert.deepEqual(point, { x: 10, y: 12, sessionId: undefined });
});

test("Playwright text-is matches an element with no immediate text", async () => {
  const cdp = new FakeCDP(async (method, params) => {
    if (method === "Runtime.evaluate") {
      assert.match(params.expression, /expected === ""/);
      assert.match(params.expression, /text\.immediate\.length === 0/);
      return { result: { value: { x: 12, y: 14 } } };
    }
    return {};
  });

  const point = await resolveElementCenter(
    cdp,
    undefined,
    new RefMap(),
    '#empty:text-is("")',
  );

  assert.deepEqual(point, { x: 12, y: 14, sessionId: undefined });
});

test("raw CSS may contain compatibility tokens inside quoted values", async () => {
  const cdp = new FakeCDP(async (method, params) => {
    if (method === "Runtime.evaluate") {
      assert.match(params.expression, /data-value/);
      assert.match(params.expression, /:has-text/);
      return { result: { value: { x: 13, y: 14 } } };
    }
    return {};
  });

  const point = await resolveElementCenter(
    cdp,
    undefined,
    new RefMap(),
    '[data-value=":has-text("]',
  );

  assert.deepEqual(point, { x: 13, y: 14, sessionId: undefined });
});

test("Playwright terminal nth selects before actionability filtering", async () => {
  const cdp = new FakeCDP(async (method, params) => {
    if (method === "Runtime.evaluate") {
      assert.match(params.expression, /const values = Array\.from/);
      assert.match(params.expression, /const index = 1/);
      return { result: { value: { x: 15, y: 17 } } };
    }
    return {};
  });

  const point = await resolveElementCenter(
    cdp,
    undefined,
    new RefMap(),
    ".duplicate >> nth=1",
  );

  assert.deepEqual(point, { x: 15, y: 17, sessionId: undefined });
});

test("Playwright text filters compose with nth=-1 and quoted parentheses", async () => {
  const cdp = new FakeCDP(async (method, params) => {
    if (method === "Runtime.evaluate") {
      assert.match(params.expression, /Save \(draft\)/);
      assert.match(params.expression, /const index = -1 === -1/);
      return { result: { value: { x: 19, y: 23 } } };
    }
    return {};
  });

  const point = await resolveElementCenter(
    cdp,
    undefined,
    new RefMap(),
    'button:has-text("Save (draft)") >> nth=-1',
  );

  assert.deepEqual(point, { x: 19, y: 23, sessionId: undefined });
});

test("unsupported Playwright selector combinations fail before CDP", async () => {
  const cdp = new FakeCDP(async () => {
    throw new Error("unsupported selector syntax must not reach CDP");
  });

  for (const selector of [
    "button:has-text(Save)",
    'button:has-text("a" "b")',
    'button, a:has-text("Docs")',
    'loc=css:button:not(:has-text("Save"))',
    ".row >> visible=true",
  ]) {
    await assert.rejects(
      () =>
        resolveElementObjectId(
          cdp,
          "session:page",
          new RefMap(),
          selector,
          new Map(),
          { strict: true },
        ),
      (error) => {
        assert.ok(error instanceof ElementResolutionError);
        assert.equal(error.kind, "permanent");
        assert.match(error.message, /Invalid locator/);
        return true;
      },
    );
  }
  assert.deepEqual(cdp.calls, []);
});

test("role name*= uses a case-insensitive accessible-name substring", async () => {
  const cdp = new FakeCDP(async (method) => {
    if (method === "Accessibility.getFullAXTree") {
      return {
        nodes: [
          {
            role: { value: "button" },
            name: { value: "Increment counter 42" },
            backendDOMNodeId: 101,
          },
        ],
      };
    }
    if (method === "DOM.getBoxModel") {
      return { model: { content: [0, 0, 20, 0, 20, 10, 0, 10] } };
    }
    return {};
  });

  const point = await resolveElementCenter(
    cdp,
    "session:page",
    new RefMap(),
    'loc=role:button[name*="increment COUNTER"]',
  );

  assert.deepEqual(point, { x: 10, y: 5, sessionId: "session:page" });
});

test("invalid numeric CSS ids suggest a valid attribute selector", async () => {
  const cdp = new FakeCDP(async (method) => {
    if (method === "Runtime.evaluate") {
      return {
        exceptionDetails: {
          exception: {
            description:
              "SyntaxError: Failed to execute 'querySelectorAll' on 'Document'",
          },
        },
      };
    }
    return {};
  });

  await assert.rejects(
    () =>
      resolveElementObjectId(
        cdp,
        "session:page",
        new RefMap(),
        "#73503e10-2be7-42d1-a053-c77402da1f80",
        new Map(),
        { strict: true },
      ),
    (error) => {
      assert.ok(error instanceof ElementResolutionError);
      assert.equal(error.kind, "permanent");
      assert.match(
        error.message,
        /\[id="73503e10-2be7-42d1-a053-c77402da1f80"\]/,
      );
      return true;
    },
  );
});

test("malformed role locators fail before raw CSS evaluation", async () => {
  const cdp = new FakeCDP(async () => {
    throw new Error("malformed role locator must not reach CDP");
  });

  await assert.rejects(
    () =>
      resolveElementObjectId(
        cdp,
        "session:page",
        new RefMap(),
        'loc=role:button[name^="View flight details"]',
        new Map(),
        { strict: true },
      ),
    (error) => {
      assert.ok(error instanceof ElementResolutionError);
      assert.equal(error.kind, "permanent");
      assert.match(error.message, /loc=role:<role>\[name="<exact name>"\]/);
      assert.match(error.message, /text=\.\.\./);
      return true;
    },
  );
  assert.deepEqual(cdp.calls, []);
});

test("text locators normalize whitespace and search nested open shadow roots", async () => {
  const cdp = new FakeCDP(async (method, params) => {
    if (method === "Runtime.evaluate") {
      assert.match(params.expression, /shadowRoot/);
      assert.match(params.expression, /replace\(\/\\s\+\/g, " "\)/);
      assert.match(params.expression, /toLowerCase\(\)\s*\.includes/);
      assert.match(params.expression, /INPUT/);
      return { result: { value: { x: 20, y: 30 } } };
    }
    return {};
  });

  const point = await resolveElementCenter(
    cdp,
    undefined,
    new RefMap(),
    "text=Save changes",
  );

  assert.deepEqual(point, { x: 20, y: 30, sessionId: undefined });
});

test("quoted text locators use exact case-sensitive matching", async () => {
  const cdp = new FakeCDP(async (method, params) => {
    if (method === "Runtime.evaluate") {
      assert.match(params.expression, /mode: "exact"/);
      assert.match(params.expression, /=== expected/);
      return { result: { value: { x: 40, y: 50 } } };
    }
    return {};
  });

  const point = await resolveElementCenter(
    cdp,
    undefined,
    new RefMap(),
    'text="Save changes"',
  );

  assert.deepEqual(point, { x: 40, y: 50, sessionId: undefined });
});

test("ambiguous text locators fail permanently instead of choosing one match", async () => {
  const cdp = new FakeCDP(async (method, params) => {
    if (method === "Runtime.evaluate") {
      if (params.expression.includes("__egoDescribeMatches")) {
        return {
          result: {
            value: {
              visible: 2,
              hidden: 0,
              candidates: [
                { tag: "button", name: "Save draft", visible: true },
                { tag: "button", name: "Save changes", visible: true },
              ],
            },
          },
        };
      }
      return {
        result: {
          value: { error: "Locator text=Save matched 2 elements" },
        },
      };
    }
    return {};
  });

  await assert.rejects(
    () => resolveElementCenter(cdp, undefined, new RefMap(), "text=Save"),
    (error) => {
      assert.ok(error instanceof ElementResolutionError);
      assert.equal(error.kind, "permanent");
      assert.match(error.message, /matched 2 elements/);
      assert.match(error.message, /2 visible, 0 hidden/);
      assert.match(error.message, /button "Save draft"/);
      assert.match(error.message, /current snapshot ref|more specific/i);
      return true;
    },
  );
});

test("ambiguous raw CSS selectors fail instead of choosing the first match", async () => {
  const cdp = new FakeCDP(async (method, params) => {
    if (method === "Runtime.evaluate") {
      if (params.expression.includes("__egoDescribeMatches")) {
        return {
          result: {
            value: {
              visible: 2,
              hidden: 1,
              candidates: [
                {
                  tag: "button",
                  role: "button",
                  name: "Create",
                  visible: true,
                  disabled: false,
                },
                {
                  tag: "button",
                  role: "button",
                  name: "Create menu",
                  visible: true,
                  disabled: false,
                },
                {
                  tag: "button",
                  name: "Create",
                  visible: false,
                  disabled: true,
                },
              ],
            },
          },
        };
      }
      assert.match(params.expression, /querySelectorAll/);
      return { result: { value: 3 } };
    }
    return {};
  });

  await assert.rejects(
    () =>
      resolveElementObjectId(
        cdp,
        "session:page",
        new RefMap(),
        "button.save",
        new Map(),
        { strict: true },
      ),
    (error) => {
      assert.ok(error instanceof ElementResolutionError);
      assert.equal(error.kind, "permanent");
      assert.match(error.message, /Selector button\.save matched 3 elements/);
      assert.match(error.message, /2 visible, 1 hidden/);
      assert.match(error.message, /button role=button "Create" \(visible\)/);
      assert.match(error.message, /button "Create" \(hidden, disabled\)/);
      assert.match(error.message, /current snapshot ref|more specific/i);
      return true;
    },
  );
});

test("action resolution uses the sole usable CSS match", async () => {
  const cdp = new FakeCDP(async (method, params) => {
    if (method !== "Runtime.evaluate") return {};
    if (params.expression.includes("__egoActionableMatches")) {
      return params.returnByValue
        ? { result: { value: 1 } }
        : { result: { objectId: "visible-button" } };
    }
    return { result: { value: 2 } };
  });

  assert.deepEqual(
    await resolveElementObjectId(
      cdp,
      "session:page",
      new RefMap(),
      "button.save",
      new Map(),
      { strict: true, actionability: "enabled" },
    ),
    { objectId: "visible-button", sessionId: "session:page" },
  );
});

test("action resolution prefers a sole actionable Page match over iframe matches", async () => {
  const cdp = new FakeCDP(async (method, params, sessionId) => {
    if (method !== "Runtime.evaluate") return {};
    if (params.expression.includes("__egoActionableMatches")) {
      return params.returnByValue
        ? { result: { value: 1 } }
        : { result: { objectId: `button:${sessionId}` } };
    }
    return { result: { value: 1 } };
  });

  assert.deepEqual(
    await resolveElementObjectId(
      cdp,
      "session:page",
      new RefMap(),
      "button.save",
      new Map([["frame-child", "session:frame-child"]]),
      { strict: true, actionability: "pointer-enabled" },
    ),
    { objectId: "button:session:page", sessionId: "session:page" },
  );
});

test("pointer action resolution skips a covered Page match for a frame match", async () => {
  const cdp = new FakeCDP(async (method, params, sessionId) => {
    if (method !== "Runtime.evaluate") return {};
    if (params.expression.includes("__egoActionableMatches")) {
      assert.match(params.expression, /elementsFromPoint/);
      if (params.returnByValue) {
        return {
          result: { value: sessionId === "session:frame-child" ? 1 : 0 },
        };
      }
      return { result: { objectId: "frame-button" } };
    }
    return { result: { value: 1 } };
  });

  assert.deepEqual(
    await resolveElementObjectId(
      cdp,
      "session:page",
      new RefMap(),
      "button.move",
      new Map([["frame-child", "session:frame-child"]]),
      { strict: true, actionability: "pointer-enabled" },
    ),
    { objectId: "frame-button", sessionId: "session:frame-child" },
  );
});

test("enabled action resolution permits opacity-zero native controls", async () => {
  const cdp = new FakeCDP(async (method, params) => {
    if (method !== "Runtime.evaluate") return {};
    if (params.expression.includes("__egoActionableMatches")) {
      assert.doesNotMatch(params.expression, /style\.opacity/);
      return params.returnByValue
        ? { result: { value: 1 } }
        : { result: { objectId: "transparent-select" } };
    }
    return { result: { value: 1 } };
  });

  assert.deepEqual(
    await resolveElementObjectId(
      cdp,
      "session:page",
      new RefMap(),
      "select.sort",
      new Map(),
      { strict: true, actionability: "enabled" },
    ),
    { objectId: "transparent-select", sessionId: "session:page" },
  );
});

test("ambiguous raw XPath selectors fail instead of choosing the first match", async () => {
  const cdp = new FakeCDP(async (method, params) => {
    if (method === "Runtime.evaluate") {
      assert.match(params.expression, /ORDERED_NODE_SNAPSHOT_TYPE/);
      return { result: { value: 2 } };
    }
    return {};
  });

  await assert.rejects(
    () =>
      resolveElementObjectId(
        cdp,
        "session:page",
        new RefMap(),
        "xpath=//button",
        new Map(),
        { strict: true },
      ),
    (error) => {
      assert.ok(error instanceof ElementResolutionError);
      assert.equal(error.kind, "permanent");
      assert.match(
        error.message,
        /Selector xpath=\/\/button matched 2 elements/,
      );
      return true;
    },
  );
});

test("semantic locators search cross-process iframe sessions", async () => {
  const cdp = new FakeCDP(async (method, _params, sessionId) => {
    if (method === "Accessibility.getFullAXTree") {
      return sessionId === "session:frame-child"
        ? {
            nodes: [
              {
                role: { value: "button" },
                name: { value: "Run iframe action" },
                backendDOMNodeId: 201,
              },
            ],
          }
        : { nodes: [] };
    }
    if (method === "DOM.resolveNode") {
      assert.equal(sessionId, "session:frame-child");
      assert.equal(_params.backendNodeId, 201);
      return { object: { objectId: "iframe-button" } };
    }
    return {};
  });

  const resolved = await resolveElementObjectId(
    cdp,
    "session:page",
    new RefMap(),
    'loc=role:button[name="Run iframe action"]',
    new Map([["frame-child", "session:frame-child"]]),
  );

  assert.deepEqual(resolved, {
    objectId: "iframe-button",
    sessionId: "session:frame-child",
  });
});

test("text locators search same-process iframe execution contexts", async () => {
  const cdp = new FakeCDP(async (method, params, sessionId) => {
    assert.equal(sessionId, "session:page");
    if (method === "Page.createIsolatedWorld") {
      assert.equal(params.frameId, "frame-child");
      return { executionContextId: 77 };
    }
    if (method === "Runtime.evaluate") {
      const inFrame = params.contextId === 77;
      if (params.returnByValue) {
        return { result: { value: inFrame ? 1 : 0 } };
      }
      return {
        result: inFrame
          ? { objectId: "same-process-upload" }
          : { type: "undefined" },
      };
    }
    return {};
  });

  assert.deepEqual(
    await resolveElementObjectId(
      cdp,
      "session:page",
      new RefMap(),
      'text="Upload"',
      new Map([["frame-child", "session:page"]]),
      { strict: true },
    ),
    {
      objectId: "same-process-upload",
      sessionId: "session:page",
      frameId: "frame-child",
    },
  );
});

test("snapshot role aliases resolve against standard accessibility roles", async () => {
  const cdp = new FakeCDP(async (method) => {
    if (method === "Accessibility.getFullAXTree") {
      return {
        nodes: [
          {
            role: { value: "option" },
            name: { value: "Upload" },
            backendDOMNodeId: 201,
          },
        ],
      };
    }
    if (method === "DOM.resolveNode") {
      return { object: { objectId: "upload-option" } };
    }
    return {};
  });

  assert.deepEqual(
    await resolveElementObjectId(
      cdp,
      "session:page",
      new RefMap(),
      'loc=role:listboxoption[name="Upload"]',
    ),
    { objectId: "upload-option", sessionId: "session:page" },
  );
});

test("same-process frame role matches keep their frame provenance", async () => {
  const cdp = new FakeCDP(async (method, params) => {
    if (method === "Accessibility.getFullAXTree") {
      return {
        nodes: [
          {
            role: { value: "option" },
            name: { value: "Upload" },
            backendDOMNodeId: 201,
          },
        ],
      };
    }
    if (method === "DOM.resolveNode") {
      return { object: { objectId: "upload-option" } };
    }
    if (method === "Runtime.callFunctionOn") {
      return { result: { value: { actionable: true } } };
    }
    return {};
  });

  assert.deepEqual(
    await resolveElementObjectId(
      cdp,
      "session:page",
      new RefMap(),
      'loc=role:listboxoption[name="Upload"]',
      new Map([["frame-child", "session:page"]]),
      { actionability: "pointer-enabled" },
    ),
    {
      objectId: "upload-option",
      sessionId: "session:page",
      frameId: "frame-child",
    },
  );
});

test("a unique interactable frame role wins over a blocked Page duplicate", async () => {
  const cdp = new FakeCDP(async (method, _params, sessionId) => {
    if (method === "Accessibility.getFullAXTree") {
      return {
        nodes: [
          {
            role: { value: "button" },
            name: { value: "Duplicate" },
            backendDOMNodeId: sessionId === "session:page" ? 1 : 2,
          },
        ],
      };
    }
    if (method === "DOM.resolveNode") {
      return { object: { objectId: `node:${sessionId}` } };
    }
    if (method === "Runtime.callFunctionOn") {
      assert.match(_params.functionDeclaration, /elementsFromPoint/);
      return { result: { value: sessionId === "session:frame-child" } };
    }
    return {};
  });

  assert.deepEqual(
    await resolveElementObjectId(
      cdp,
      "session:page",
      new RefMap(),
      'loc=role:button[name="Duplicate"]',
      new Map([["frame-child", "session:frame-child"]]),
      { actionability: "pointer-enabled" },
    ),
    { objectId: "node:session:frame-child", sessionId: "session:frame-child" },
  );
});

test("role actions prefer the actionable Page match over a frame match", async () => {
  const cdp = new FakeCDP(async (method, _params, sessionId) => {
    if (method === "Accessibility.getFullAXTree") {
      return {
        nodes: [
          {
            role: { value: "button" },
            name: { value: "Duplicate" },
            backendDOMNodeId: sessionId === "session:page" ? 1 : 2,
          },
        ],
      };
    }
    if (method === "DOM.resolveNode") {
      return { object: { objectId: `node:${sessionId}` } };
    }
    if (method === "Runtime.callFunctionOn") {
      return { result: { value: true } };
    }
    return {};
  });

  assert.deepEqual(
    await resolveElementObjectId(
      cdp,
      "session:page",
      new RefMap(),
      'loc=role:button[name="Duplicate"]',
      new Map([["frame-child", "session:frame-child"]]),
      { actionability: "pointer-enabled" },
    ),
    { objectId: "node:session:page", sessionId: "session:page" },
  );
});

test("strict global role validation rejects a hidden duplicate", async () => {
  const cdp = new FakeCDP(async (method, _params, sessionId) => {
    if (method === "Accessibility.getFullAXTree") {
      return {
        nodes: [
          {
            role: { value: "textbox" },
            name: { value: "Prompt" },
            backendDOMNodeId: sessionId === "session:page" ? 1 : 2,
          },
        ],
      };
    }
    return {};
  });

  await assert.rejects(
    () =>
      resolveElementObjectId(
        cdp,
        "session:page",
        new RefMap(),
        'loc=role:textbox[name="Prompt"]',
        new Map([["frame-child", "session:frame-child"]]),
        { strictGlobal: true },
      ),
    (error) => {
      assert.ok(error instanceof ElementResolutionError);
      assert.equal(error.kind, "permanent");
      assert.match(error.message, /matched 2 elements/);
      return true;
    },
  );
});
