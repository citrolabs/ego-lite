import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as helpers from "../dist/src/helpers.js";

function withOverrides(overrides, fn) {
  const restore = helpers.__testing.setOverrides(overrides);
  return Promise.resolve()
    .then(fn)
    .finally(restore);
}

test("helpers expose camelCase names without snake_case aliases", () => {
  for (const name of [
    "drain_events",
    "goto_url",
    "site_skills_enabled",
    "site_skills_status",
    "site_skills_for_url",
    "site_skills",
    "run_site_tool",
    "run_site_browser_tool",
    "page_info",
    "type_text",
    "fill_input",
    "press_key",
    "element_eval",
    "element_center",
    "capture_screenshot",
    "list_tabs",
    "current_tab",
    "switch_tab",
    "new_tab",
    "ensure_real_tab",
    "iframe_target",
    "wait_for_load",
    "wait_for_element",
    "wait_for_network_idle",
    "dispatch_key",
    "upload_file",
    "http_get"
  ]) {
    assert.equal(Object.hasOwn(helpers, name), false, `${name} should not be exported`);
  }
});

test("js wraps top-level return but ignores return inside strings and comments", async () => {
  const calls = [];
  await withOverrides({
    cdpOverride: async (method, params) => {
      calls.push([method, params]);
      return { result: { value: null } };
    }
  }, async () => {
    await helpers.js("const x = 1; return x");
    await helpers.js("document.body.innerText.includes('return ')");
    await helpers.js("// return comment\n1 + 1");
  });

  assert.equal(calls[0][1].expression, "(function(){const x = 1; return x})()");
  assert.equal(calls[1][1].expression, "document.body.innerText.includes('return ')");
  assert.equal(calls[2][1].expression, "// return comment\n1 + 1");
});

test("js accepts a function value, wraps it as an IIFE, and warns once on stderr", async () => {
  const calls = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  const stderrChunks = [];
  process.stderr.write = (chunk) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  try {
    await withOverrides({
      cdpOverride: async (method, params) => {
        calls.push([method, params]);
        return { result: { value: null } };
      }
    }, async () => {
      await helpers.js(() => 1 + 1);
      await helpers.js(() => 2 + 2);
    });
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.match(calls[0][1].expression, /^\(\(?\)?\s*=>\s*1\s*\+\s*1\)\(\)$/);
  assert.match(calls[1][1].expression, /^\(\(?\)?\s*=>\s*2\s*\+\s*2\)\(\)$/);
  const warning = stderrChunks.join("");
  assert.match(warning, /\[ego-browser\] js\(\) received a function and auto-wrapped it/);
  assert.match(warning, /CDP Runtime\.evaluate/);
  assert.match(warning, /elementEval\(target, fn, \.\.\.args\)/);
  const occurrences = warning.match(/\[ego-browser\] js\(\) received a function/g) || [];
  assert.equal(occurrences.length, 1, "warning should be emitted only once per process");
});

test("js rejects non-string non-function expressions with a clear TypeError", async () => {
  await withOverrides({
    cdpOverride: async () => ({ result: { value: null } })
  }, async () => {
    await assert.rejects(() => helpers.js(123), /expects a string expression or function, got number/);
    await assert.rejects(() => helpers.js(null), /expects a string expression or function, got null/);
    await assert.rejects(() => helpers.js({ source: "1" }), /expects a string expression or function, got object/);
  });
});

test("js surfaces CDP exception details with expression context", async () => {
  await withOverrides({
    cdpOverride: async () => ({
      result: {
        type: "object",
        subtype: "error",
        description: "ReferenceError: missing is not defined"
      },
      exceptionDetails: {
        text: "Uncaught",
        lineNumber: 0,
        columnNumber: 17
      }
    })
  }, async () => {
    await assert.rejects(() => helpers.js("return missing.value"), /ReferenceError.*missing/);
  });
});

test("js returns unserializable JavaScript values", () => {
  assert.ok(Number.isNaN(helpers.__testing.decodeUnserializableJsValue("NaN")));
  assert.equal(helpers.__testing.decodeUnserializableJsValue("Infinity"), Infinity);
  assert.equal(Object.is(helpers.__testing.decodeUnserializableJsValue("-0"), -0), true);
  assert.equal(helpers.__testing.decodeUnserializableJsValue("1n"), 1n);
});

test("gotoUrl includes domain skills only when enabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ego-browser-skills-"));
  const previous = process.env.EGO_BROWSER_DOMAIN_SKILLS;
  try {
    await mkdir(join(dir, "domain-skills", "example"), { recursive: true });
    await writeFile(join(dir, "domain-skills", "example", "scraping.md"), "hi");

    await withOverrides({
      agentWorkspace: () => dir,
      cdpOverride: async () => ({ frameId: "f" })
    }, async () => {
      delete process.env.EGO_BROWSER_DOMAIN_SKILLS;
      assert.deepEqual(await helpers.gotoUrl("https://www.example.com/"), { frameId: "f" });
      process.env.EGO_BROWSER_DOMAIN_SKILLS = "1";
      assert.deepEqual(await helpers.gotoUrl("https://www.example.com/"), {
        frameId: "f",
        domain_skills: ["scraping.md"]
      });
    });
  } finally {
    if (previous === undefined) {
      delete process.env.EGO_BROWSER_DOMAIN_SKILLS;
    } else {
      process.env.EGO_BROWSER_DOMAIN_SKILLS = previous;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("taskSpaces normalizes ego listTaskSpaces object results", async () => {
  const previous = globalThis.ego;
  globalThis.ego = {
    listTaskSpaces: async () => ({ taskIds: ["default", "x-openai-7d-posts"] })
  };
  try {
    const spaces = await helpers.taskSpaces();
    assert.deepEqual(spaces, [
      { taskId: "default", id: "default", name: "default" },
      { taskId: "x-openai-7d-posts", id: "x-openai-7d-posts", name: "x-openai-7d-posts" }
    ]);
  } finally {
    if (previous === undefined) {
      delete globalThis.ego;
    } else {
      globalThis.ego = previous;
    }
  }
});

test("useOrCreateTaskSpace reuses matching normalized task spaces", async () => {
  const calls = [];
  const previous = globalThis.ego;
  globalThis.ego = {
    listTaskSpaces: async () => ({ taskIds: ["x-openai-7d-posts"] }),
    useTaskSpace: (taskId) => calls.push(["use", taskId])
  };
  try {
    const task = await helpers.useOrCreateTaskSpace("x-openai-7d-posts");
    assert.deepEqual(task, {
      taskId: "x-openai-7d-posts",
      id: "x-openai-7d-posts",
      name: "x-openai-7d-posts"
    });
    assert.deepEqual(calls, [["use", "x-openai-7d-posts"]]);
  } finally {
    if (previous === undefined) {
      delete globalThis.ego;
    } else {
      globalThis.ego = previous;
    }
  }
});

test("fillInput focuses, select-alls without char event, types, and fires framework events", async () => {
  const cdpCalls = [];
  const jsExpressions = [];
  await withOverrides({
    cdpOverride: async (method, params, sessionId) => {
      cdpCalls.push([method, params, sessionId]);
      if (method === "Runtime.evaluate") {
        jsExpressions.push(params.expression);
        return { result: { value: params.expression.includes("focus") ? true : null } };
      }
      return {};
    }
  }, async () => {
    await helpers.fillInput("#my-input", "x");
  });

  const keyEvents = cdpCalls.filter(([method]) => method === "Input.dispatchKeyEvent").map(([, params]) => params);
  const selectAllA = keyEvents.filter((event) => event.key === "a");
  assert.ok(selectAllA.length > 0);
  assert.equal(selectAllA.every((event) => event.modifiers === (process.platform === "darwin" ? 4 : 2)), true);
  assert.equal(keyEvents.some((event) => event.type === "char" && event.text === "a"), false);
  assert.ok(keyEvents.some((event) => event.key === "Backspace"));
  assert.ok(jsExpressions.some((expression) => expression.includes("input") && expression.includes("change")));
});

test("fill clears the element, fires input, then inserts text", async () => {
  const cdpCalls = [];
  await withOverrides({
    cdpOverride: async (method, params, sessionId) => {
      cdpCalls.push([method, params, sessionId]);
      if (method === "Runtime.evaluate") {
        return { result: { objectId: "input-object" } };
      }
      return {};
    }
  }, async () => {
    assert.deepEqual(await helpers.fill("#my-input", "hello"), { ok: true });
  });

  assert.deepEqual(cdpCalls.map(([method]) => method), [
    "Runtime.evaluate",
    "Runtime.callFunctionOn",
    "Runtime.callFunctionOn",
    "Input.insertText"
  ]);
  assert.match(cdpCalls[1][1].functionDeclaration, /this\.focus\(\)/);
  assert.match(cdpCalls[2][1].functionDeclaration, /this\.value = ''/);
  assert.match(cdpCalls[2][1].functionDeclaration, /dispatchEvent\(new Event\('input'/);
  assert.deepEqual(cdpCalls[3], ["Input.insertText", { text: "hello" }, undefined]);
});

test("pressKey sends one printable char event without text on keyDown", async () => {
  const keyEvents = [];
  await withOverrides({
    cdpOverride: async (method, params) => {
      if (method === "Input.dispatchKeyEvent") {
        keyEvents.push(params);
      }
      return {};
    }
  }, async () => {
    await helpers.pressKey("x");
  });

  assert.deepEqual(keyEvents.map((event) => event.type), ["keyDown", "char", "keyUp"]);
  assert.equal(Object.hasOwn(keyEvents[0], "text"), false);
  assert.equal(keyEvents[1].text, "x");
});

test("pressKey does not emit printable char events for special keys", async () => {
  const keyEvents = [];
  await withOverrides({
    cdpOverride: async (method, params) => {
      if (method === "Input.dispatchKeyEvent") {
        keyEvents.push(params);
      }
      return {};
    }
  }, async () => {
    await helpers.pressKey("Enter");
  });

  assert.deepEqual(keyEvents.map((event) => event.type), ["keyDown", "keyUp"]);
  assert.equal(keyEvents.some((event) => event.type === "char"), false);
});

test("scroll preserves the mouse-wheel signature", async () => {
  const calls = [];
  await withOverrides({
    cdpOverride: async (method, params) => {
      calls.push([method, params]);
      return {};
    }
  }, async () => {
    await helpers.scroll(10, 20, { dx: 1, dy: -250 });
    await helpers.scroll({ dy: 900 });
  });

  assert.deepEqual(calls, [
    [
      "Input.dispatchMouseEvent",
      { type: "mouseWheel", x: 10, y: 20, deltaX: 1, deltaY: -250 }
    ],
    [
      "Input.dispatchMouseEvent",
      { type: "mouseWheel", x: 0, y: 0, deltaX: 0, deltaY: 900 }
    ]
  ]);
});

test("scrollBy uses DOM window scrolling", async () => {
  const expressions = [];
  await withOverrides({
    cdpOverride: async (method, params) => {
      assert.equal(method, "Runtime.evaluate");
      expressions.push(params.expression);
      return { result: { value: { x: 0, y: 900 } } };
    }
  }, async () => {
    const result = await helpers.scrollBy({ dy: 900 });
    assert.deepEqual(result, { x: 0, y: 900 });
  });

  assert.match(expressions[0], /window\.scrollBy/);
  assert.match(expressions[0], /top: 900/);
});

test("scrollToBottomUntil scrolls until a function condition is met", async () => {
  const states = [
    { x: 0, y: 0, viewportHeight: 900, scrollHeight: 3000, atBottom: false },
    { x: 0, y: 900, viewportHeight: 900, scrollHeight: 3000, atBottom: false }
  ];
  let domScrolls = 0;
  await withOverrides({
    cdpOverride: async (method, params) => {
      assert.equal(method, "Runtime.evaluate");
      if (params.expression.includes("window.scrollBy")) {
        domScrolls += 1;
        return { result: { value: { x: 0, y: 900 } } };
      }
      return { result: { value: states.shift() } };
    }
  }, async () => {
    const result = await helpers.scrollToBottomUntil((state) => state.y >= 900, { wait: 0, maxSteps: 3 });
    assert.equal(result.done, true);
    assert.equal(result.reason, "condition");
    assert.equal(result.steps, 1);
  });

  assert.equal(domScrolls, 1);
});

test("click doubleClick and hover accept viewport coordinate targets", async () => {
  const calls = [];
  await withOverrides({
    cdpOverride: async (method, params, sessionId) => {
      calls.push([method, params, sessionId]);
      return {};
    }
  }, async () => {
    await helpers.click({ x: 10, y: 20 });
    await helpers.doubleClick([30, 40]);
    await helpers.hover({ x: 50, y: 60 });
  });

  assert.deepEqual(calls, [
    ["Input.dispatchMouseEvent", { type: "mousePressed", x: 10, y: 20, button: "left", buttons: 1, clickCount: 1 }, undefined],
    ["Input.dispatchMouseEvent", { type: "mouseReleased", x: 10, y: 20, button: "left", buttons: 0, clickCount: 1 }, undefined],
    ["Input.dispatchMouseEvent", { type: "mousePressed", x: 30, y: 40, button: "left", buttons: 1, clickCount: 2 }, undefined],
    ["Input.dispatchMouseEvent", { type: "mouseReleased", x: 30, y: 40, button: "left", buttons: 0, clickCount: 2 }, undefined],
    ["Input.dispatchMouseEvent", { type: "mouseMoved", x: 50, y: 60, buttons: 0 }, undefined]
  ]);
});

test("waitForElement visible check uses checkVisibility with computed-style fallback", async () => {
  const expressions = [];
  await withOverrides({
    cdpOverride: async (method, params) => {
      expressions.push(params.expression);
      return { result: { value: true } };
    },
    now: (() => {
      let value = 1000;
      return () => value += 1;
    })(),
    sleep: async () => {}
  }, async () => {
    assert.equal(await helpers.waitForElement("#btn", { visible: true }), true);
  });
  assert.ok(expressions.some((expression) => expression.includes("checkVisibility")));
  assert.ok(expressions.some((expression) => expression.includes("getComputedStyle")));
  assert.equal(expressions.some((expression) => expression.includes("offsetParent")), false);
});

test("captureScreenshot clips to CSS viewport with scale=1/DPR by default", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "shot-"));
  const path = join(tmp, "shot.png");
  let shotParams;
  try {
    await withOverrides({
      cdpOverride: async (method, params) => {
        if (method === "Runtime.evaluate") {
          if (params.expression.includes("devicePixelRatio")) return { result: { value: 2 } };
          return { result: { value: JSON.stringify({ url: "u", title: "t", w: 1291, h: 805, sx: 0, sy: 0, pw: 1291, ph: 4000 }) } };
        }
        if (method === "Page.captureScreenshot") {
          shotParams = params;
          return { data: Buffer.from("png").toString("base64") };
        }
        return {};
      },
      writeFile: async () => {}
    }, async () => {
      await helpers.captureScreenshot(path);
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  assert.deepEqual(shotParams.clip, { x: 0, y: 0, width: 1291, height: 805, scale: 0.5 });
  assert.equal(shotParams.captureBeyondViewport, false);
});

test("captureScreenshot uses scale=1 when DPR is 1", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "shot-"));
  const path = join(tmp, "shot.png");
  let shotParams;
  try {
    await withOverrides({
      cdpOverride: async (method, params) => {
        if (method === "Runtime.evaluate") {
          if (params.expression.includes("devicePixelRatio")) return { result: { value: 1 } };
          return { result: { value: JSON.stringify({ url: "u", title: "t", w: 1280, h: 800, sx: 0, sy: 0, pw: 1280, ph: 800 }) } };
        }
        if (method === "Page.captureScreenshot") {
          shotParams = params;
          return { data: Buffer.from("png").toString("base64") };
        }
        return {};
      },
      writeFile: async () => {}
    }, async () => {
      await helpers.captureScreenshot(path);
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  assert.equal(shotParams.clip.scale, 1);
});

test("captureScreenshot full uses pw/ph for the clip", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "shot-"));
  const path = join(tmp, "shot.png");
  let shotParams;
  try {
    await withOverrides({
      cdpOverride: async (method, params) => {
        if (method === "Runtime.evaluate") {
          if (params.expression.includes("devicePixelRatio")) return { result: { value: 2 } };
          return { result: { value: JSON.stringify({ url: "u", title: "t", w: 1291, h: 805, sx: 0, sy: 0, pw: 1291, ph: 4000 }) } };
        }
        if (method === "Page.captureScreenshot") {
          shotParams = params;
          return { data: Buffer.from("png").toString("base64") };
        }
        return {};
      },
      writeFile: async () => {}
    }, async () => {
      await helpers.captureScreenshot(path, { full: true });
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  assert.deepEqual(shotParams.clip, { x: 0, y: 0, width: 1291, height: 4000, scale: 0.5 });
  assert.equal(shotParams.captureBeyondViewport, true);
});

test("captureScreenshot custom clip without scale fills in 1/DPR", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "shot-"));
  const path = join(tmp, "shot.png");
  let shotParams;
  try {
    await withOverrides({
      cdpOverride: async (method, params) => {
        if (method === "Runtime.evaluate") {
          if (params.expression.includes("devicePixelRatio")) return { result: { value: 2 } };
          return { result: { value: JSON.stringify({ url: "u", title: "t", w: 1291, h: 805, sx: 0, sy: 0, pw: 1291, ph: 4000 }) } };
        }
        if (method === "Page.captureScreenshot") {
          shotParams = params;
          return { data: Buffer.from("png").toString("base64") };
        }
        return {};
      },
      writeFile: async () => {}
    }, async () => {
      await helpers.captureScreenshot(path, { clip: { x: 100, y: 50, width: 400, height: 300 } });
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  assert.deepEqual(shotParams.clip, { x: 100, y: 50, width: 400, height: 300, scale: 0.5 });
});

test("captureScreenshot custom clip with explicit scale wins over the default", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "shot-"));
  const path = join(tmp, "shot.png");
  let shotParams;
  try {
    await withOverrides({
      cdpOverride: async (method, params) => {
        if (method === "Runtime.evaluate") {
          if (params.expression.includes("devicePixelRatio")) return { result: { value: 2 } };
          return { result: { value: JSON.stringify({ url: "u", title: "t", w: 1291, h: 805, sx: 0, sy: 0, pw: 1291, ph: 4000 }) } };
        }
        if (method === "Page.captureScreenshot") {
          shotParams = params;
          return { data: Buffer.from("png").toString("base64") };
        }
        return {};
      },
      writeFile: async () => {}
    }, async () => {
      await helpers.captureScreenshot(path, { clip: { x: 0, y: 0, width: 200, height: 200, scale: 0.25 } });
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  assert.equal(shotParams.clip.scale, 0.25);
});

test("captureScreenshot raw:true keeps the physical-pixel behavior", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "shot-"));
  const path = join(tmp, "shot.png");
  let shotParams;
  try {
    await withOverrides({
      cdpOverride: async (method, params) => {
        if (method === "Page.captureScreenshot") {
          shotParams = params;
          return { data: Buffer.from("png").toString("base64") };
        }
        return {};
      },
      writeFile: async () => {}
    }, async () => {
      await helpers.captureScreenshot(path, { raw: true });
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  assert.equal(shotParams.clip, undefined);
  assert.equal(shotParams.captureBeyondViewport, false);
});
