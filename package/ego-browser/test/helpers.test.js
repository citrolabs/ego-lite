import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as helpers from "../dist/src/helpers.js";
import { browserRefMap } from "../dist/src/ref-state.js";

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
  assert.match(warning, /elementEval\(target, \(el, \.\.\.args\) => \.\.\.\)/);
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

test("listTaskSpaces normalizes ego listTaskSpaces object results", async () => {
  const previous = globalThis.ego;
  globalThis.ego = {
    listTaskSpaces: async () => ({ taskIds: ["default", "x-openai-7d-posts"] })
  };
  try {
    const spaces = await helpers.listTaskSpaces();
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

function withTaskSpaceEgo(extraMethods = {}) {
  return {
    listTaskSpaces: async () => ({ taskIds: ["my-task"] }),
    closeTaskSpace: async () => {},
    completeTaskSpace: async () => {},
    handOffTaskSpace: async () => {},
    takeOverTaskSpace: async () => {},
    ...extraMethods
  };
}

async function withEgo(ego, fn) {
  const previous = globalThis.ego;
  globalThis.ego = ego;
  try {
    await fn();
  } finally {
    if (previous === undefined) {
      delete globalThis.ego;
    } else {
      globalThis.ego = previous;
    }
  }
}

test("completeTaskSpace with keep:false closes the task space", async () => {
  const calls = [];
  await withEgo(withTaskSpaceEgo({
    useTaskSpace: (id) => calls.push(["use", id]),
    closeTaskSpace: async (...args) => calls.push(["close", ...args]),
    completeTaskSpace: async () => calls.push(["complete"])
  }), async () => {
    await helpers.completeTaskSpace("my-task", { keep: false });
  });
  assert.deepEqual(calls, [["use", "my-task"], ["close"]]);
});

test("completeTaskSpace with keep:true keeps the page for the user", async () => {
  const calls = [];
  await withEgo(withTaskSpaceEgo({
    useTaskSpace: (id) => calls.push(["use", id]),
    closeTaskSpace: async (id) => calls.push(["close", id]),
    completeTaskSpace: async () => calls.push(["complete"])
  }), async () => {
    await helpers.completeTaskSpace("my-task", { keep: true });
  });
  assert.deepEqual(calls, [["use", "my-task"], ["complete"]]);
});

test("completeTaskSpace requires { keep } option", async () => {
  await withEgo(withTaskSpaceEgo(), async () => {
    await assert.rejects(() => helpers.completeTaskSpace("my-task"), /\{ keep: boolean \}/);
    await assert.rejects(() => helpers.completeTaskSpace("my-task", {}), /\{ keep: boolean \}/);
  });
});

test("completeTaskSpace throws when task space not found", async () => {
  await withEgo(withTaskSpaceEgo(), async () => {
    await assert.rejects(() => helpers.completeTaskSpace("unknown", { keep: false }), /task space not found/);
  });
});

test("completeTaskSpace surfaces ego { error } responses", async () => {
  await withEgo(withTaskSpaceEgo({
    useTaskSpace: () => {},
    closeTaskSpace: async () => ({ error: "The task is under user control" })
  }), async () => {
    await assert.rejects(
      () => helpers.completeTaskSpace("my-task", { keep: false }),
      /completeTaskSpace: The task is under user control/
    );
  });

  await withEgo(withTaskSpaceEgo({
    useTaskSpace: () => {},
    completeTaskSpace: async () => ({ error: "Task not found" })
  }), async () => {
    await assert.rejects(
      () => helpers.completeTaskSpace("my-task", { keep: true }),
      /completeTaskSpace: Task not found/
    );
  });
});

test("handOffTaskSpace surfaces ego { error } responses", async () => {
  await withEgo(withTaskSpaceEgo({
    handOffTaskSpace: async () => ({ error: "Task not found" })
  }), async () => {
    await assert.rejects(() => helpers.handOffTaskSpace(), /handOffTaskSpace: Task not found/);
  });
});

test("takeOverTaskSpace surfaces ego { error } responses", async () => {
  await withEgo(withTaskSpaceEgo({
    takeOverTaskSpace: async () => ({ error: "Task not found" })
  }), async () => {
    await assert.rejects(() => helpers.takeOverTaskSpace(), /takeOverTaskSpace: Task not found/);
  });
});

test("handOffTaskSpace calls ego.handOffTaskSpace with no arguments", async () => {
  let called = false;
  await withEgo(withTaskSpaceEgo({ handOffTaskSpace: async () => { called = true; } }), async () => {
    await helpers.handOffTaskSpace();
  });
  assert.equal(called, true);
});

test("handOffTaskSpace switches to named task space before handing off", async () => {
  const calls = [];
  await withEgo(withTaskSpaceEgo({
    useTaskSpace: (id) => calls.push(["use", id]),
    handOffTaskSpace: async () => calls.push(["handOff"])
  }), async () => {
    await helpers.handOffTaskSpace("my-task");
  });
  assert.deepEqual(calls, [["use", "my-task"], ["handOff"]]);
});

test("takeOverTaskSpace calls ego.takeOverTaskSpace with no arguments", async () => {
  let called = false;
  await withEgo(withTaskSpaceEgo({ takeOverTaskSpace: async () => { called = true; } }), async () => {
    await helpers.takeOverTaskSpace();
  });
  assert.equal(called, true);
});

test("takeOverTaskSpace switches to named task space before taking over", async () => {
  const calls = [];
  await withEgo(withTaskSpaceEgo({
    useTaskSpace: (id) => calls.push(["use", id]),
    takeOverTaskSpace: async () => calls.push(["takeOver"])
  }), async () => {
    await helpers.takeOverTaskSpace("my-task");
  });
  assert.deepEqual(calls, [["use", "my-task"], ["takeOver"]]);
});

test("waitForAgentControl returns once the probe succeeds", async () => {
  let attempts = 0;
  const ego = withTaskSpaceEgo({
    useTaskSpace: () => {},
    snapshot: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("The task is under user control");
      return { content: "", refs: [] };
    }
  });
  await withEgo(ego, async () => {
    await helpers.waitForAgentControl("my-task", { interval: 0.01, timeout: 5 });
  });
  assert.equal(attempts, 3);
});

test("waitForAgentControl throws when timeout elapses", async () => {
  const ego = withTaskSpaceEgo({
    useTaskSpace: () => {},
    snapshot: async () => { throw new Error("The task is under user control"); }
  });
  await withEgo(ego, async () => {
    await assert.rejects(
      () => helpers.waitForAgentControl("my-task", { interval: 0.01, timeout: 0.05 }),
      /waitForAgentControl timed out/
    );
  });
});

test("waitForAgentControl requires a task space name", async () => {
  await withEgo(withTaskSpaceEgo(), async () => {
    await assert.rejects(() => helpers.waitForAgentControl(), /requires a task space name/);
  });
});

test("waitForAgentControl propagates non-user-control snapshot errors", async () => {
  const ego = withTaskSpaceEgo({
    useTaskSpace: () => {},
    snapshot: async () => { throw new Error("task space not found"); }
  });
  await withEgo(ego, async () => {
    await assert.rejects(
      () => helpers.waitForAgentControl("my-task", { interval: 0.01, timeout: 5 }),
      /task space not found/
    );
  });
});

test("assertNoEgoError stringifies non-string error fields", async () => {
  await withEgo(withTaskSpaceEgo({
    handOffTaskSpace: async () => ({ error: { code: 42, message: "boom" } })
  }), async () => {
    await assert.rejects(() => helpers.handOffTaskSpace(), /handOffTaskSpace:.*boom|handOffTaskSpace:.*42/);
  });
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

test("fillInput resolves the selector, clears via native value setter, inserts text, and fires framework events", async () => {
  const calls = [];
  await withOverrides({
    cdpOverride: async (method, params, sessionId) => {
      calls.push([method, params, sessionId]);
      if (method === "Runtime.evaluate") return { result: { objectId: "obj-css" } };
      return {};
    }
  }, async () => {
    await helpers.fillInput("#my-input", "x");
  });

  const callFnOn = calls.filter(([m]) => m === "Runtime.callFunctionOn").map(([, p]) => p);
  assert.ok(calls.some(([m, p]) => m === "Runtime.evaluate" && /querySelector/.test(p.expression || "")), "must resolve raw CSS via the unified resolver");
  assert.ok(callFnOn.length > 0 && callFnOn.every((p) => p.objectId === "obj-css"), "callFunctionOn must target the resolved objectId");
  assert.equal(callFnOn.some((p) => /setSelectionRange/.test(p.functionDeclaration)), false, "must not use setSelectionRange");
  assert.equal(calls.some(([m, p]) => m === "Input.dispatchKeyEvent" && p.key === "Backspace"), false, "must not clear with Backspace");
  assert.ok(callFnOn.some((p) => /this\.value\s*=\s*''/.test(p.functionDeclaration)), "must clear via native value setter");
  assert.ok(calls.some(([m, p]) => m === "Input.insertText" && p.text === "x"), "must insert text via CDP");
  assert.ok(callFnOn.some((p) => /'input'/.test(p.functionDeclaration) && /'change'/.test(p.functionDeclaration)), "must fire input/change events");
});

test("pressKey sends printable text on keyDown", async () => {
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

  assert.deepEqual(keyEvents.map((event) => event.type), ["keyDown", "keyUp"]);
  assert.equal(keyEvents[0].key, "x");
  assert.equal(keyEvents[0].code, "KeyX");
  assert.equal(keyEvents[0].text, "x");
  assert.equal(keyEvents[0].unmodifiedText, "x");
});

test("pressKey sends special-key text when the browser needs it", async () => {
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
  assert.equal(keyEvents[0].text, "\r");
  assert.equal(keyEvents[0].unmodifiedText, "\r");
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
  const calls = [];
  await withOverrides({
    cdpOverride: async (method, params) => {
      calls.push([method, params]);
      if (method === "Runtime.evaluate") return { result: { objectId: "obj-btn" } };
      if (method === "Runtime.callFunctionOn") return { result: { value: true } };
      return {};
    },
    now: (() => {
      let value = 1000;
      return () => value += 1;
    })(),
    sleep: async () => {}
  }, async () => {
    assert.equal(await helpers.waitForElement("#btn", { visible: true }), true);
  });
  const callFnOn = calls.find(([m]) => m === "Runtime.callFunctionOn");
  assert.ok(callFnOn, "visibility must be checked via callFunctionOn on the resolved element");
  assert.match(callFnOn[1].functionDeclaration, /checkVisibility/);
  assert.match(callFnOn[1].functionDeclaration, /getComputedStyle/);
  assert.equal(callFnOn[1].functionDeclaration.includes("offsetParent"), false);
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

function withRefEntry(refId, backendNodeId, role, name) {
  browserRefMap.clear();
  browserRefMap.add(String(refId), backendNodeId, role, name);
  return () => browserRefMap.clear();
}

test("fillInput on @ref resolves to objectId and uses callFunctionOn + Input.insertText", async () => {
  const calls = [];
  const restoreRef = withRefEntry("42", 42, "textbox", "Username");
  try {
    await withOverrides({
      cdpOverride: async (method, params, sessionId) => {
        calls.push([method, params, sessionId]);
        if (method === "DOM.resolveNode") return { object: { objectId: "obj-42" } };
        return {};
      }
    }, async () => {
      await helpers.fillInput("@42", "hello");
    });
  } finally {
    restoreRef();
  }

  assert.ok(calls.some(([m]) => m === "DOM.resolveNode"), "must resolve ref via DOM.resolveNode");
  assert.equal(calls.some(([m, p]) => m === "Runtime.evaluate" && /querySelector/.test(p.expression || "")), false, "must not fall back to querySelector");
  const callFnOn = calls.filter(([m]) => m === "Runtime.callFunctionOn");
  assert.ok(callFnOn.every(([, p]) => p.objectId === "obj-42"), "callFunctionOn must target the resolved objectId");
  assert.ok(callFnOn.some(([, p]) => /this\.focus\(\)/.test(p.functionDeclaration)), "must focus the element");
  assert.equal(callFnOn.some(([, p]) => /setSelectionRange/.test(p.functionDeclaration)), false, "must not use setSelectionRange");
  assert.ok(callFnOn.some(([, p]) => /this\.value\s*=\s*''/.test(p.functionDeclaration)), "must clear via native value setter");
  assert.ok(callFnOn.some(([, p]) => /dispatchEvent\(new Event\('input'/.test(p.functionDeclaration) && /'change'/.test(p.functionDeclaration)), "must fire input/change events");
  assert.ok(calls.some(([m, p]) => m === "Input.insertText" && p.text === "hello"), "must insert text via CDP");
  assert.equal(calls.some(([m, p]) => m === "Input.dispatchKeyEvent" && p.key === "Backspace"), false, "must not clear by pressing Backspace");
});

test("fillInput with clearFirst:false on @ref skips the clear+Backspace path", async () => {
  const calls = [];
  const restoreRef = withRefEntry("7", 7, "textbox", "Email");
  try {
    await withOverrides({
      cdpOverride: async (method, params) => {
        calls.push([method, params]);
        if (method === "DOM.resolveNode") return { object: { objectId: "obj-7" } };
        return {};
      }
    }, async () => {
      await helpers.fillInput("@7", "abc", { clearFirst: false });
    });
  } finally {
    restoreRef();
  }
  assert.equal(calls.some(([m, p]) => m === "Input.dispatchKeyEvent" && p.key === "Backspace"), false);
  assert.equal(calls.some(([, p]) => p && typeof p.functionDeclaration === "string" && /setSelectionRange/.test(p.functionDeclaration)), false);
  assert.ok(calls.some(([m, p]) => m === "Input.insertText" && p.text === "abc"));
});

test("dispatchKey on @ref focuses via objectId and dispatches a synthetic KeyboardEvent", async () => {
  const calls = [];
  const restoreRef = withRefEntry("9", 9, "textbox", "Search");
  try {
    await withOverrides({
      cdpOverride: async (method, params) => {
        calls.push([method, params]);
        if (method === "DOM.resolveNode") return { object: { objectId: "obj-9" } };
        return {};
      }
    }, async () => {
      await helpers.dispatchKey("@9", "Enter");
    });
  } finally {
    restoreRef();
  }
  assert.equal(calls.some(([m, p]) => m === "Runtime.evaluate" && /querySelector/.test(p.expression || "")), false);
  const callFnOn = calls.filter(([m]) => m === "Runtime.callFunctionOn");
  assert.equal(callFnOn.length, 1);
  assert.equal(callFnOn[0][1].objectId, "obj-9");
  assert.match(callFnOn[0][1].functionDeclaration, /this\.focus\(\)/);
  assert.match(callFnOn[0][1].functionDeclaration, /new KeyboardEvent/);
  assert.deepEqual(callFnOn[0][1].arguments, [
    { value: 13 },
    { value: "Enter" },
    { value: "Enter" },
    { value: "keypress" }
  ]);
});

test("fillInput routes xpath= selectors through the unified resolver", async () => {
  const calls = [];
  await withOverrides({
    cdpOverride: async (method, params) => {
      calls.push([method, params]);
      if (method === "Runtime.evaluate") return { result: { objectId: "obj-xp" } };
      return {};
    }
  }, async () => {
    await helpers.fillInput("xpath=//input[@name='email']", "a@b.com");
  });
  assert.ok(calls.some(([m, p]) => m === "Runtime.evaluate" && /document\.evaluate/.test(p.expression || "")), "xpath must resolve via document.evaluate, not querySelector");
  assert.ok(calls.filter(([m]) => m === "Runtime.callFunctionOn").every(([, p]) => p.objectId === "obj-xp"));
  assert.ok(calls.some(([m, p]) => m === "Input.insertText" && p.text === "a@b.com"));
});

test("fillInput routes loc=css: selectors through the unified resolver", async () => {
  const calls = [];
  await withOverrides({
    cdpOverride: async (method, params) => {
      calls.push([method, params]);
      if (method === "Runtime.evaluate") {
        return /querySelectorAll/.test(params.expression) ? { result: { value: 1 } } : { result: { objectId: "obj-loc" } };
      }
      return {};
    }
  }, async () => {
    await helpers.fillInput("loc=css:input[name=\"email\"]", "a@b.com");
  });
  assert.ok(calls.some(([m, p]) => m === "Runtime.evaluate" && /querySelectorAll/.test(p.expression || "")), "loc=css must check uniqueness via querySelectorAll");
  assert.ok(calls.some(([m, p]) => m === "Input.insertText" && p.text === "a@b.com"));
});

test("dispatchKey routes xpath= selectors through the unified resolver", async () => {
  const calls = [];
  await withOverrides({
    cdpOverride: async (method, params) => {
      calls.push([method, params]);
      if (method === "Runtime.evaluate") return { result: { objectId: "obj-xp" } };
      return {};
    }
  }, async () => {
    await helpers.dispatchKey("xpath=//button", "Enter");
  });
  assert.ok(calls.some(([m, p]) => m === "Runtime.evaluate" && /document\.evaluate/.test(p.expression || "")));
  const callFnOn = calls.find(([m]) => m === "Runtime.callFunctionOn");
  assert.ok(callFnOn, "must dispatch the KeyboardEvent via callFunctionOn on the resolved element");
  assert.match(callFnOn[1].functionDeclaration, /new KeyboardEvent/);
});

test("waitForElement routes xpath= selectors through the unified resolver", async () => {
  const calls = [];
  await withOverrides({
    cdpOverride: async (method, params) => {
      calls.push([method, params]);
      if (method === "Runtime.evaluate") return { result: { objectId: "obj-xp" } };
      return {};
    },
    now: (() => {
      let value = 1000;
      return () => (value += 1);
    })(),
    sleep: async () => {}
  }, async () => {
    assert.equal(await helpers.waitForElement("xpath=//button"), true);
  });
  assert.ok(calls.some(([m, p]) => m === "Runtime.evaluate" && /document\.evaluate/.test(p.expression || "")), "xpath must resolve via document.evaluate, not querySelector");
});

test("waitForElement on @ref polls resolveElementObjectId and returns true when it succeeds", async () => {
  const calls = [];
  const restoreRef = withRefEntry("12", 12, "button", "Save");
  try {
    await withOverrides({
      cdpOverride: async (method, params) => {
        calls.push([method, params]);
        if (method === "DOM.resolveNode") return { object: { objectId: "obj-12" } };
        return {};
      },
      now: (() => {
        let value = 1000;
        return () => (value += 1);
      })(),
      sleep: async () => {}
    }, async () => {
      assert.equal(await helpers.waitForElement("@12"), true);
    });
  } finally {
    restoreRef();
  }
  assert.equal(calls.some(([m, p]) => m === "Runtime.evaluate" && /querySelector/.test(p.expression || "")), false);
  assert.ok(calls.some(([m]) => m === "DOM.resolveNode"));
});

test("waitForElement on @ref with visible:true runs checkVisibility via callFunctionOn", async () => {
  const calls = [];
  const restoreRef = withRefEntry("13", 13, "button", "Save");
  try {
    await withOverrides({
      cdpOverride: async (method, params) => {
        calls.push([method, params]);
        if (method === "DOM.resolveNode") return { object: { objectId: "obj-13" } };
        if (method === "Runtime.callFunctionOn") return { result: { value: true } };
        return {};
      },
      now: (() => {
        let value = 1000;
        return () => (value += 1);
      })(),
      sleep: async () => {}
    }, async () => {
      assert.equal(await helpers.waitForElement("@13", { visible: true }), true);
    });
  } finally {
    restoreRef();
  }
  const callFnOn = calls.find(([m]) => m === "Runtime.callFunctionOn");
  assert.ok(callFnOn);
  assert.match(callFnOn[1].functionDeclaration, /checkVisibility/);
  assert.match(callFnOn[1].functionDeclaration, /getComputedStyle/);
});

test("waitForElement on unknown @ref returns false after timeout without falling back to querySelector", async () => {
  browserRefMap.clear();
  const calls = [];
  let nowValue = 0;
  const previousEgo = globalThis.ego;
  globalThis.ego = {
    sendCDPMessage() {},
    snapshot: async () => ({ refs: [], content: "" })
  };
  try {
    await withOverrides({
      cdpOverride: async (method, params) => {
        calls.push([method, params]);
        return {};
      },
      now: () => (nowValue += 5000),
      sleep: async () => {}
    }, async () => {
      assert.equal(await helpers.waitForElement("@999", { timeout: 1 }), false);
    });
  } finally {
    browserRefMap.clear();
    if (previousEgo === undefined) delete globalThis.ego; else globalThis.ego = previousEgo;
  }
  assert.equal(calls.some(([m, p]) => m === "Runtime.evaluate" && /querySelector/.test(p.expression || "")), false);
});

test("elementEval passes the element as the first argument and forwards user args after it", async () => {
  const calls = [];
  await withOverrides({
    cdpOverride: async (method, params) => {
      calls.push([method, params]);
      if (method === "Runtime.evaluate") {
        return { result: { objectId: "OID-EL" } };
      }
      if (method === "Runtime.callFunctionOn") {
        return { result: { value: "hello" } };
      }
      return {};
    }
  }, async () => {
    const arrowNoArgs = await helpers.elementEval("#status", (el) => el.textContent);
    assert.equal(arrowNoArgs, "hello");
    const arrowWithArg = await helpers.elementEval("#input", (el, prop) => el[prop], "value");
    assert.equal(arrowWithArg, "hello");
    await helpers.elementEval("#btn", function () { this.click(); });
  });

  const callFnOnCalls = calls.filter(([m]) => m === "Runtime.callFunctionOn");
  assert.equal(callFnOnCalls.length, 3);

  const [, noArgsParams] = callFnOnCalls[0];
  assert.deepEqual(noArgsParams.arguments, [{ objectId: "OID-EL" }]);

  const [, withArgParams] = callFnOnCalls[1];
  assert.deepEqual(withArgParams.arguments, [{ objectId: "OID-EL" }, { value: "value" }]);

  const [, legacyThisParams] = callFnOnCalls[2];
  assert.deepEqual(legacyThisParams.arguments, [{ objectId: "OID-EL" }]);
  assert.equal(legacyThisParams.objectId, "OID-EL");
  assert.match(legacyThisParams.functionDeclaration, /^function/);
});

test("elementEval regression: arrow-style el.click() no longer fails because el is now supplied", async () => {
  const calls = [];
  await withOverrides({
    cdpOverride: async (method) => {
      if (method === "Runtime.evaluate") {
        return { result: { objectId: "OID-BUTTON" } };
      }
      if (method === "Runtime.callFunctionOn") {
        calls.push("callFunctionOn");
        return { result: { value: null } };
      }
      return {};
    }
  }, async () => {
    await helpers.elementEval("#submit", (el) => el.click());
  });
  assert.equal(calls.length, 1);
});
