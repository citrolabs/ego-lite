import assert from "node:assert/strict";
import test from "node:test";

import { resolveElementCenter, resolveElementObjectId } from "../dist/src/element-resolver.js";
import { parseRef, RefMap } from "../dist/src/ref-map.js";

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

test("parseRef accepts Agent Browser ref spellings", () => {
  assert.equal(parseRef("@10"), "10");
  assert.equal(parseRef("ref=42"), "42");
  assert.equal(parseRef("7"), "7");
  assert.equal(parseRef("button"), null);
  assert.equal(parseRef("@e1"), null);
});

test("resolveElementCenter uses cached backendNodeId and iframe session", async () => {
  const refMap = new RefMap();
  refMap.addWithFrame("42", 42, "button", "Submit", undefined, "frame-1");
  const iframeSessions = new Map([["frame-1", "iframe-session"]]);
  const cdp = new FakeCDP(async (method) => {
    assert.equal(method, "DOM.getBoxModel");
    return { model: { content: [0, 0, 20, 0, 20, 10, 0, 10] } };
  });

  assert.deepEqual(await resolveElementCenter(cdp, "page-session", refMap, "@42", iframeSessions), {
    x: 10,
    y: 5,
    sessionId: "iframe-session"
  });
  assert.deepEqual(cdp.calls[0], ["DOM.getBoxModel", { backendNodeId: 42 }, "iframe-session"]);
});

test("resolveElementObjectId falls back to role/name lookup when cached backendNodeId is stale", async () => {
  const refMap = new RefMap();
  refMap.add("42", 42, "button", "Submit");
  let stale = true;
  const cdp = new FakeCDP(async (method, params) => {
    if (method === "DOM.resolveNode" && stale) {
      stale = false;
      throw new Error("stale node");
    }
    if (method === "Accessibility.getFullAXTree") {
      return {
        nodes: [
          {
            nodeId: "1",
            ignored: false,
            role: { value: "button" },
            name: { value: "Submit" },
            backendDOMNodeId: 99
          }
        ]
      };
    }
    if (method === "DOM.resolveNode") {
      assert.equal(params.backendNodeId, 99);
      return { object: { objectId: "object-99" } };
    }
    return {};
  });

  assert.deepEqual(await resolveElementObjectId(cdp, "page-session", refMap, "ref=42"), {
    objectId: "object-99",
    sessionId: "page-session"
  });
});

test("resolveElementObjectId supports CSS and XPath selectors", async () => {
  const cdp = new FakeCDP(async (method, params) => {
    assert.equal(method, "Runtime.evaluate");
    assert.equal(params.returnByValue, false);
    return { result: { objectId: "selector-object" } };
  });

  assert.deepEqual(await resolveElementObjectId(cdp, "page-session", new RefMap(), "xpath=//button"), {
    objectId: "selector-object",
    sessionId: "page-session"
  });
  assert.match(cdp.calls[0][1].expression, /document\.evaluate/);
});

test("resolveElementObjectId supports stable locator strings", async () => {
  const cdp = new FakeCDP(async (method, params) => {
    if (method === "Runtime.evaluate" && params.returnByValue) {
      if (params.expression.includes("querySelectorAll")) {
        return { result: { value: 1 } };
      }
      if (params.expression.includes("HTMLAnchorElement")) {
        return { result: { value: 1 } };
      }
    }
    if (method === "Runtime.evaluate") {
      return { result: { objectId: "locator-object" } };
    }
    return {};
  });

  assert.deepEqual(await resolveElementObjectId(cdp, "page-session", new RefMap(), "css:button[data-testid=\"save\"]"), {
    objectId: "locator-object",
    sessionId: "page-session"
  });
  assert.deepEqual(await resolveElementObjectId(cdp, "page-session", new RefMap(), "href:/settings"), {
    objectId: "locator-object",
    sessionId: "page-session"
  });
});

test("resolveElementCenter supports unique role/name locators and rejects duplicates", async () => {
  const cdp = new FakeCDP(async (method, params) => {
    if (method === "Accessibility.getFullAXTree") {
      return {
        nodes: [
          {
            nodeId: "1",
            ignored: false,
            role: { value: "button" },
            name: { value: "Save" },
            backendDOMNodeId: 44
          }
        ]
      };
    }
    if (method === "DOM.getBoxModel") {
      assert.equal(params.backendNodeId, 44);
      return { model: { content: [0, 0, 20, 0, 20, 10, 0, 10] } };
    }
    return {};
  });

  assert.deepEqual(await resolveElementCenter(cdp, "page-session", new RefMap(), "role:button[name=\"Save\"]"), {
    x: 10,
    y: 5,
    sessionId: "page-session"
  });

  const duplicate = new FakeCDP(async (method) => {
    if (method === "Accessibility.getFullAXTree") {
      return {
        nodes: [
          { nodeId: "1", ignored: false, role: { value: "button" }, name: { value: "Save" }, backendDOMNodeId: 1 },
          { nodeId: "2", ignored: false, role: { value: "button" }, name: { value: "Save" }, backendDOMNodeId: 2 }
        ]
      };
    }
    return {};
  });

  await assert.rejects(
    () => resolveElementCenter(duplicate, "page-session", new RefMap(), "role:button[name=\"Save\"]"),
    /matched 2 elements/
  );
});
