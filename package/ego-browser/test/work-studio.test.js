import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";

import * as helpers from "../dist/src/helpers.js";
import { startWorkStudioServer } from "../dist/src/work-studio/server.js";
import { writeStoredTask } from "../dist/src/work-studio/store.js";

const root = join(import.meta.dirname, "..");
const artifactPath = join(root, "artifacts", "ego-browser", "index.js");
function withOverrides(overrides, fn) {
  const restore = helpers.__testing.setOverrides(overrides);
  return Promise.resolve()
    .then(fn)
    .finally(restore);
}

function withBrowserRuntime(runtime, fn) {
  const previous = globalThis.ego;
  globalThis.ego = runtime;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previous === undefined) {
        delete globalThis.ego;
      } else {
        globalThis.ego = previous;
      }
    });
}

async function withWorkStudioDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "ego-work-studio-"));
  const previous = process.env.EGO_BROWSER_WORK_STUDIO_DIR;
  process.env.EGO_BROWSER_WORK_STUDIO_DIR = dir;
  try {
    await fn(dir);
  } finally {
    if (previous === undefined) {
      delete process.env.EGO_BROWSER_WORK_STUDIO_DIR;
    } else {
      process.env.EGO_BROWSER_WORK_STUDIO_DIR = previous;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

async function fetchJson(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const body = await response.json();
  return { response, body };
}

test("createWorkStudio serves an A2UI-backed Work Studio page", async () => {
  await withWorkStudioDir(async () => {
    const cdpCalls = [];
    let studio;
    await withOverrides({
      cdpOverride: async (method, params) => {
        cdpCalls.push([method, params]);
        return { success: true };
      }
    }, async () => {
      studio = await helpers.createWorkStudio({
        taskId: "buy black jacket",
        title: "Black jacket results",
        mode: "interactive-action",
        document: {
          summary: "Two candidate products were selected.",
          items: [{ id: "coat_1", title: "Short black jacket", url: "https://item.example/coat" }]
        },
        tabs: [
          { id: "product", role: "interactive_source", targetId: "target-product", url: "https://item.example/coat", title: "Product" },
          { id: "review", role: "information_source", targetId: "target-review", url: "https://blog.example/review", title: "Review" },
          { id: "search", role: "temporary", targetId: "target-search", url: "https://search.example", title: "Search" }
        ],
        bindings: [{ id: "add_coat", itemId: "coat_1", sourceTabId: "product", selector: "#add-to-cart" }]
      });
    });

    assert.equal(studio.taskId, "buy black jacket");
    assert.match(studio.url, /^http:\/\/127\.0\.0\.1:\d+\/tasks\//);
    assert.deepEqual(cdpCalls, [
      ["Target.closeTarget", { targetId: "target-review" }],
      ["Target.closeTarget", { targetId: "target-search" }]
    ]);

    const page = await fetch(studio.url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /window\.workStudio/);
    assert.match(html, /data-work-studio-shell="analysis"/);
    assert.match(html, /Task result/);
    assert.match(html, /Run checklist/);
    assert.match(html, /Tab history/);
    assert.match(html, /product-grid/);
    assert.match(html, /checkoutItem/);
    assert.match(html, /Checkout/);
    assert.match(html, /fallbackAction/);
    assert.match(html, /checkoutUrlFor/);

    const token = new URL(studio.url).searchParams.get("token");
    const unauthorized = await fetch(studio.apiUrl);
    assert.equal(unauthorized.status, 401);

    const task = await fetchJson(studio.apiUrl, token);
    assert.equal(task.response.status, 200);
    assert.equal(task.body.title, "Black jacket results");
    assert.equal(task.body.tabs.interactiveCount, 1);
    assert.equal(task.body.tabs.historyCount, 1);
    assert.equal(Object.hasOwn(task.body, "bindings"), false);

    const a2ui = await fetchJson(`${studio.apiUrl}/a2ui`, token);
    assert.equal(a2ui.response.status, 200);
    assert.equal(Array.isArray(a2ui.body), true);
    assert.equal(a2ui.body[0].createSurface.surfaceId, "main");

    const history = await fetchJson(`${studio.apiUrl}/history`, token);
    assert.deepEqual(history.body.tabs.map((tab) => tab.id), ["review"]);

    if (studio.serverPid) {
      try { process.kill(studio.serverPid); } catch {}
    }
  });
});

test("Work Studio product checkout opens the item checkout URL", async () => {
  await withWorkStudioDir(async () => {
    const task = await writeStoredTask({
      taskId: "checkout url task",
      title: "Checkout URL task",
      document: {
        items: [{
          id: "sku_1",
          title: "Desk lamp",
          url: "https://shop.example/products/lamp",
          checkoutUrl: "https://shop.example/checkout/lamp",
          image: "https://img.example/lamp.png",
          price: "$48"
        }]
      }
    });
    const opened = [];
    const started = await startWorkStudioServer({ taskId: task.taskId });
    try {
      await withBrowserRuntime({
        listTabs: async () => ({ tabs: [] }),
        createTab: async (url) => {
          opened.push(url);
          return { targetId: `tab-${opened.length}` };
        }
      }, async () => {
        const result = await fetchJson(`http://${started.host}:${started.port}/api/tasks/${task.safeTaskId}/items/sku_1/checkout`, task.token, {
          method: "POST",
          body: "{}"
        });
        assert.equal(result.response.status, 200);
        assert.equal(result.body.status, "opened_checkout");
        assert.equal(result.body.url, "https://shop.example/checkout/lamp");
      });
    } finally {
      started.server.close();
    }
    assert.deepEqual(opened, ["https://shop.example/checkout/lamp"]);
  });
});

test("Work Studio product checkout prefers a checkout binding over a checkout URL", async () => {
  await withWorkStudioDir(async () => {
    const task = await writeStoredTask({
      taskId: "checkout binding task",
      title: "Checkout binding task",
      document: {
        items: [{
          id: "sku_2",
          title: "Espresso maker",
          url: "https://shop.example/products/espresso",
          checkoutUrl: "https://shop.example/checkout/static",
          image: "https://img.example/espresso.png",
          price: "$88",
          checkoutBindingId: "sku_2_checkout"
        }]
      },
      bindings: [{
        id: "sku_2_checkout",
        itemId: "sku_2",
        label: "Checkout",
        steps: [{ type: "open_url", url: "https://shop.example/checkout/from-binding", wait: false }]
      }]
    });
    const opened = [];
    const started = await startWorkStudioServer({ taskId: task.taskId });
    try {
      await withBrowserRuntime({
        listTabs: async () => ({ tabs: [] }),
        createTab: async (url) => {
          opened.push(url);
          return { targetId: `tab-${opened.length}` };
        }
      }, async () => {
        const result = await fetchJson(`http://${started.host}:${started.port}/api/tasks/${task.safeTaskId}/items/sku_2/checkout`, task.token, {
          method: "POST",
          body: "{}"
        });
        assert.equal(result.response.status, 200);
        assert.equal(result.body.status, "done");
        assert.equal(result.body.bindingId, "sku_2_checkout");
      });
    } finally {
      started.server.close();
    }
    assert.deepEqual(opened, [
      "https://shop.example/products/espresso",
      "https://shop.example/checkout/from-binding"
    ]);
  });
});

test("Work Studio product checkout falls back to the product URL", async () => {
  await withWorkStudioDir(async () => {
    const task = await writeStoredTask({
      taskId: "checkout product fallback task",
      title: "Checkout product fallback task",
      document: {
        items: [{
          id: "sku_3",
          title: "Quick dry shirt",
          url: "https://item.jd.com/sku3.html",
          image: "https://img.example/shirt.png",
          price: "¥79"
        }]
      }
    });
    const opened = [];
    const started = await startWorkStudioServer({ taskId: task.taskId });
    try {
      await withBrowserRuntime({
        listTabs: async () => ({ tabs: [] }),
        createTab: async (url) => {
          opened.push(url);
          return { targetId: `tab-${opened.length}` };
        }
      }, async () => {
        const result = await fetchJson(`http://${started.host}:${started.port}/api/tasks/${task.safeTaskId}/items/sku_3/checkout`, task.token, {
          method: "POST",
          body: "{}"
        });
        assert.equal(result.response.status, 200);
        assert.equal(result.body.status, "opened_product");
        assert.equal(result.body.url, "https://item.jd.com/sku3.html");
      });
    } finally {
      started.server.close();
    }
    assert.deepEqual(opened, ["https://item.jd.com/sku3.html"]);
  });
});

test("createWorkStudio reuses a live per-task bridge server", async () => {
  await withWorkStudioDir(async () => {
    let first;
    let second;
    await withOverrides({ cdpOverride: async () => ({}) }, async () => {
      first = await helpers.createWorkStudio({ taskId: "research task", title: "First", tabs: [] });
      second = await helpers.createWorkStudio({ taskId: "research task", title: "Second", tabs: [] });
    });

    assert.equal(first.port, second.port);
    const token = new URL(second.url).searchParams.get("token");
    const task = await fetchJson(second.apiUrl, token);
    assert.equal(task.body.title, "Second");

    if (second.serverPid) {
      try { process.kill(second.serverPid); } catch {}
    }
  });
});

test("single-file artifact can run Work Studio bridge server mode", async () => {
  await withWorkStudioDir(async () => {
    const task = await writeStoredTask({ taskId: "artifact task", title: "Artifact Studio", tabs: [] });
    const child = spawn(process.execPath, [artifactPath, "--work-studio-server", task.taskId], {
      cwd: root,
      env: process.env,
      stdio: "ignore"
    });
    try {
      let info;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        try {
          info = JSON.parse(await readFile(join(process.env.EGO_BROWSER_WORK_STUDIO_DIR, task.safeTaskId, "server.json"), "utf8"));
          break;
        } catch {}
      }
      assert.ok(info?.port, "server.json should contain a port");
      const result = await fetchJson(`http://127.0.0.1:${info.port}/api/tasks/${task.safeTaskId}`, task.token);
      assert.equal(result.response.status, 200);
      assert.equal(result.body.title, "Artifact Studio");
    } finally {
      child.kill();
    }
  });
});
