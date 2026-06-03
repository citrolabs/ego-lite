import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { click } from "../driver/pointer.js";
import { fillInput } from "../driver/keyboard.js";
import { openOrReuseTab, switchTab } from "../driver/nav.js";
import { wait } from "../driver/waits.js";
import { js } from "../cdp-eval.js";
import { readStoredTask, writeStoredTask, type WorkStudioBinding, type WorkStudioStoredTask } from "./store.js";

export type WorkStudioServerOptions = {
  taskId: string;
  host?: string;
  port?: number;
};

export async function startWorkStudioServer(options: WorkStudioServerOptions) {
  const host = options.host || "127.0.0.1";
  const server = createServer((req, res) => {
    handleRequest(options.taskId, req, res).catch((error) => {
      json(res, 500, { ok: false, error: error?.message || String(error) });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port || 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return { server, host, port };
}

async function handleRequest(taskId: string, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const task = await readStoredTask(taskId);
  if (!authorized(task, req, url)) {
    json(res, 401, { ok: false, error: "unauthorized" });
    return;
  }

  if (req.method === "GET" && url.pathname === `/tasks/${task.safeTaskId}`) {
    html(res, shellHtml(task));
    return;
  }
  if (req.method === "GET" && url.pathname === `/api/tasks/${task.safeTaskId}`) {
    json(res, 200, publicTask(task));
    return;
  }
  if (req.method === "GET" && url.pathname === `/api/tasks/${task.safeTaskId}/a2ui`) {
    json(res, 200, task.a2ui.messages);
    return;
  }
  if (req.method === "GET" && url.pathname === `/api/tasks/${task.safeTaskId}/history`) {
    json(res, 200, { tabs: historyTabs(task) });
    return;
  }
  if (req.method === "POST" && url.pathname === `/api/tasks/${task.safeTaskId}/history/restore`) {
    const body = await requestJson(req);
    json(res, 200, await restoreHistory(task, body));
    return;
  }

  const openOriginal = url.pathname.match(new RegExp(`^/api/tasks/${escapeRegExp(task.safeTaskId)}/items/([^/]+)/open-original$`));
  if (req.method === "POST" && openOriginal) {
    json(res, 200, await openOriginalItem(task, decodeURIComponent(openOriginal[1])));
    return;
  }

  const checkoutItemMatch = url.pathname.match(new RegExp(`^/api/tasks/${escapeRegExp(task.safeTaskId)}/items/([^/]+)/checkout$`));
  if (req.method === "POST" && checkoutItemMatch) {
    const body = await requestJson(req);
    json(res, 200, await checkoutItem(task, decodeURIComponent(checkoutItemMatch[1]), body));
    return;
  }

  const bindingRun = url.pathname.match(new RegExp(`^/api/tasks/${escapeRegExp(task.safeTaskId)}/bindings/([^/]+)/run$`));
  if (req.method === "POST" && bindingRun) {
    const body = await requestJson(req);
    json(res, 200, await runBinding(task, decodeURIComponent(bindingRun[1]), body));
    return;
  }

  const action = url.pathname.match(new RegExp(`^/api/tasks/${escapeRegExp(task.safeTaskId)}/actions/([^/]+)$`));
  if (req.method === "POST" && action) {
    const body = await requestJson(req);
    json(res, 200, await runAction(task, decodeURIComponent(action[1]), body));
    return;
  }

  json(res, 404, { ok: false, error: "not found" });
}

function authorized(task: WorkStudioStoredTask, req: IncomingMessage, url: URL) {
  const token = url.searchParams.get("token");
  const auth = req.headers.authorization || "";
  return token === task.token || auth === `Bearer ${task.token}`;
}

function publicTask(task: WorkStudioStoredTask) {
  const history = historyTabs(task);
  return {
    taskId: task.taskId,
    safeTaskId: task.safeTaskId,
    title: task.title,
    mode: task.mode,
    data: task.data || {},
    items: task.items,
    tabs: {
      interactiveCount: task.tabs.filter((tab) => tab.role === "interactive_source").length,
      historyCount: history.length
    },
    a2ui: { version: task.a2ui.version, surfaceId: task.a2ui.surfaceId }
  };
}

function historyTabs(task: WorkStudioStoredTask) {
  return task.tabs
    .filter((tab) => tab.role === "information_source" || (tab.role === "temporary" && tab.archived))
    .map(({ id, title, url, role, reason, restoreable }) => ({ id, title, url, role, reason, restoreable }));
}

async function restoreHistory(task: WorkStudioStoredTask, body: any) {
  const ids = Array.isArray(body?.ids) ? new Set(body.ids.map(String)) : null;
  const candidates = historyTabs(task).filter((tab) => body?.all || ids?.has(String(tab.id)));
  const opened = [];
  const skipped = [];
  for (const tab of candidates) {
    if (!tab.url) {
      skipped.push({ id: tab.id, reason: "missing url" });
      continue;
    }
    try {
      const openedTab = await openOrReuseTab(tab.url, { wait: false, match: "exact" });
      opened.push({ id: tab.id, targetId: openedTab.targetId, url: tab.url });
    } catch (error) {
      skipped.push({ id: tab.id, reason: error?.message || String(error) });
    }
  }
  return { ok: true, opened, skipped };
}

async function openOriginalItem(task: WorkStudioStoredTask, itemId: string) {
  const item = task.items.find((candidate) => candidate.id === itemId);
  if (!item) return { ok: false, status: "not_found", message: `item not found: ${itemId}` };
  const source = sourceTab(task, item.sourceTabId as string, item.url as string);
  if (source?.targetId) {
    await switchTab(source.targetId);
    return { ok: true, status: "switched", targetId: source.targetId, url: source.url };
  }
  const url = (item.url as string) || source?.url;
  if (!url) return { ok: false, status: "missing_url", message: "item has no URL" };
  const opened = await openOrReuseTab(url, { wait: false, match: "exact" });
  return { ok: true, status: opened.reused ? "reused" : "opened", targetId: opened.targetId, url };
}

async function checkoutItem(task: WorkStudioStoredTask, itemId: string, body: any) {
  const item = task.items.find((candidate) => candidate.id === itemId);
  if (!item) return { ok: false, status: "not_found", message: `item not found: ${itemId}` };

  const binding = checkoutBinding(task, item);
  if (binding) {
    return runBinding(task, binding.id, body || {});
  }

  const source = sourceTab(task, item.sourceTabId as string, item.url as string);
  const url = checkoutUrl(item) || (item.url as string) || source?.url;
  if (!url) {
    return {
      ok: false,
      status: "missing_checkout",
      message: `item has no checkout URL, product URL, or checkout binding: ${itemId}`
    };
  }
  const opened = await openOrReuseTab(url, { wait: false, match: "exact" });
  const usedFallback = !checkoutUrl(item);
  const status = usedFallback
    ? (opened.reused ? "reused_product" : "opened_product")
    : (opened.reused ? "reused_checkout" : "opened_checkout");
  await appendAudit(task, { type: "checkout", itemId, status, url });
  return { ok: true, status, targetId: opened.targetId, url };
}

async function runAction(task: WorkStudioStoredTask, actionName: string, body: any) {
  if (actionName === "run_binding") {
    return runBinding(task, String(body?.bindingId || ""), body);
  }
  if (actionName === "open_original") {
    return openOriginalItem(task, String(body?.itemId || ""));
  }
  if (actionName === "checkout_item") {
    return checkoutItem(task, String(body?.itemId || ""), body);
  }
  if (actionName === "load_history") {
    return { ok: true, status: "loaded", history: historyTabs(task), a2ui: historyA2UI(task) };
  }
  if (actionName === "restore_history_tabs") {
    return restoreHistory(task, body || { all: true });
  }
  return { ok: false, status: "unknown_action", message: `unknown action: ${actionName}` };
}

async function runBinding(task: WorkStudioStoredTask, bindingId: string, body: any) {
  const binding = task.bindings.find((candidate) => candidate.id === bindingId);
  if (!binding) return { ok: false, status: "not_found", message: `binding not found: ${bindingId}` };
  const item = binding.itemId ? task.items.find((candidate) => candidate.id === binding.itemId) : null;
  const source = sourceTab(task, binding.sourceTabId || (item?.sourceTabId as string), item?.url as string);
  if (source?.targetId) {
    await switchTab(source.targetId);
  } else if (source?.url || item?.url) {
    await openOrReuseTab(String(source?.url || item?.url), { wait: false, match: "exact" });
  }
  const steps = binding.steps?.length ? binding.steps : bindingToSteps(binding);
  const results = [];
  for (const step of steps) {
    results.push(await runStep(step, body?.params || {}));
  }
  await appendAudit(task, { type: "binding", bindingId, itemId: binding.itemId, results });
  return {
    ok: true,
    status: "done",
    bindingId,
    results,
    a2ui: statusA2UI(task, bindingId, binding.label || "Action completed")
  };
}

function bindingToSteps(binding: WorkStudioBinding) {
  if (binding.selector || binding.locator) {
    return [{ type: "click", selector: binding.selector, locator: binding.locator }];
  }
  return [];
}

function checkoutBinding(task: WorkStudioStoredTask, item: Record<string, unknown>) {
  const ids = [
    item.checkoutBindingId,
    item.buyBindingId,
    item.orderBindingId,
    item.purchaseBindingId,
    `${item.id}_checkout`,
    `${item.id}_buy`,
    `${item.id}_order`
  ].filter(Boolean).map(String);
  return task.bindings.find((binding) => ids.includes(binding.id)) ||
    task.bindings.find((binding) => binding.itemId === item.id && isCheckoutBinding(binding));
}

function isCheckoutBinding(binding: WorkStudioBinding) {
  const haystack = `${binding.id} ${binding.label || ""}`.toLowerCase();
  return /\b(checkout|buy|order|purchase|cart)\b/.test(haystack);
}

function checkoutUrl(item: Record<string, unknown>) {
  return firstString(item, [
    "checkoutUrl",
    "checkout_url",
    "checkoutPageUrl",
    "checkout_page_url",
    "buyUrl",
    "buy_url",
    "cartUrl",
    "cart_url",
    "orderUrl",
    "order_url",
    "purchaseUrl",
    "purchase_url"
  ]);
}

function firstString(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return "";
}

async function runStep(step: any, params: Record<string, unknown>) {
  if (step.type === "switch_tab") {
    await switchTab(step.targetId);
    return { type: step.type, ok: true };
  }
  if (step.type === "open_url") {
    const url = interpolate(String(step.url || ""), params);
    const tab = await openOrReuseTab(url, { wait: Boolean(step.wait), match: "exact" });
    return { type: step.type, ok: true, targetId: tab.targetId, url };
  }
  if (step.type === "click") {
    await click(step.selector || step.locator);
    return { type: step.type, ok: true };
  }
  if (step.type === "fill") {
    await fillInput(step.selector || step.locator, interpolate(String(step.value || ""), params));
    return { type: step.type, ok: true };
  }
  if (step.type === "wait") {
    await wait(Number(step.seconds || 1));
    return { type: step.type, ok: true };
  }
  if (step.type === "eval") {
    return { type: step.type, ok: true, value: await js(interpolate(step.expression, params)) };
  }
  throw new Error(`unsupported work studio step: ${step.type}`);
}

function sourceTab(task: WorkStudioStoredTask, sourceTabId?: string, fallbackUrl?: string) {
  const tab = sourceTabId ? task.tabs.find((candidate) => candidate.id === sourceTabId) : null;
  if (tab) return tab;
  if (fallbackUrl) return task.tabs.find((candidate) => candidate.url === fallbackUrl) || { url: fallbackUrl };
  return null;
}

function historyA2UI(task: WorkStudioStoredTask) {
  const surfaceId = task.a2ui.surfaceId;
  const components = historyTabs(task).flatMap((tab) => ([
    { id: `history_${tab.id}_title`, component: "Text", text: tab.title || tab.url, variant: "body" },
    { id: `history_${tab.id}_open`, component: "Button", text: "Open", action: { event: { name: "restore_history_tabs", context: { ids: [tab.id] } } } }
  ]));
  return [{ version: "v0.9", updateComponents: { surfaceId, components } }];
}

function statusA2UI(task: WorkStudioStoredTask, bindingId: string, message: string) {
  return [{
    version: "v0.9",
    updateDataModel: {
      surfaceId: task.a2ui.surfaceId,
      path: `/status/${bindingId}`,
      value: { state: "success", message }
    }
  }];
}

async function appendAudit(task: WorkStudioStoredTask, event: Record<string, unknown>) {
  const audit = [...((task as any).audit || []), { ...event, at: new Date().toISOString() }];
  await writeStoredTask({ ...task, data: { ...(task.data || {}), audit } }, task);
}

function shellHtml(task: WorkStudioStoredTask) {
  const base = `/api/tasks/${task.safeTaskId}`;
  const token = task.token;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(task.title || "Work Studio")}</title>
<style>
:root{color-scheme:light;--bg:#eef3f1;--paper:#fbfcfa;--paper-2:#eef4f2;--ink:#18201d;--muted:#64736e;--line:#d7e0dc;--line-strong:#bdcbc5;--sage:#416856;--sage-soft:#dcebe3;--blue:#285c8f;--blue-soft:#dceaf4;--amber:#a45b16;--amber-soft:#f2e4cf;--rose:#9a3f4d;--shadow:0 18px 60px rgba(55,42,25,.08),0 1px 2px rgba(55,42,25,.08);font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:linear-gradient(180deg,#f7faf8 0,#edf3f0 260px,#f5f8f6 100%);color:var(--ink)}button{appearance:none;border:1px solid var(--line-strong);background:#fbfcfa;color:var(--ink);border-radius:8px;padding:9px 12px;font:600 13px/1.1 inherit;cursor:pointer;transition:transform .16s ease,border-color .16s ease,background .16s ease,box-shadow .16s ease}button:hover{transform:translateY(-1px);border-color:#879c92;box-shadow:0 8px 24px rgba(55,42,25,.08)}button:focus-visible{outline:3px solid rgba(40,92,143,.25);outline-offset:2px}button.primary{background:var(--ink);border-color:var(--ink);color:#fbfcfa}button.checkout{min-width:96px}button.ghost{background:transparent;border-color:transparent;color:var(--blue);padding-inline:4px}button[disabled]{opacity:.45;cursor:not-allowed;transform:none;box-shadow:none}.app{max-width:1240px;margin:0 auto;padding:30px clamp(18px,3vw,34px) 44px}.hero{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:24px;align-items:end;padding:26px 0 24px;border-bottom:1px solid var(--line)}.eyebrow{margin:0 0 10px;color:var(--sage);font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.hero h1{margin:0;max-width:900px;font-size:clamp(34px,4.4vw,64px);line-height:.96;letter-spacing:0;font-weight:850}.hero p{margin:16px 0 0;max-width:780px;color:var(--muted);font-size:17px;line-height:1.55}.metrics{display:grid;grid-template-columns:repeat(3,92px);gap:8px}.metric{border:1px solid var(--line);border-radius:8px;background:rgba(255,253,248,.72);padding:11px}.metric strong{display:block;font-size:26px;line-height:1;font-weight:850}.metric span{display:block;margin-top:6px;color:var(--muted);font-size:11px;font-weight:750;text-transform:uppercase;letter-spacing:.08em}.grid{display:grid;grid-template-columns:minmax(0,1fr) 330px;gap:18px;margin-top:20px;align-items:start}.panel{background:var(--paper);border:1px solid var(--line);border-radius:8px;box-shadow:var(--shadow)}.panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:18px 20px;border-bottom:1px solid var(--line)}.panel-title{margin:0;font-size:15px;font-weight:850;letter-spacing:.02em}.panel-note{margin:5px 0 0;color:var(--muted);font-size:13px;line-height:1.4}.result-body{padding:8px 20px 20px}.brief{display:grid;gap:10px;padding:18px 0 16px;border-bottom:1px solid var(--line)}.brief p{margin:0;color:#27302c;font-size:16px;line-height:1.58}.brief .subtitle{color:var(--muted);font-size:14px}.items{display:grid;gap:10px;padding-top:16px}.source-row{display:grid;grid-template-columns:42px minmax(0,1fr) auto;gap:14px;align-items:center;padding:14px 0;border-bottom:1px solid #e4ece8}.source-row:last-child{border-bottom:0}.index{display:grid;place-items:center;width:34px;height:34px;border-radius:8px;background:var(--blue-soft);color:var(--blue);font-size:12px;font-weight:850}.source-title{margin:0;font-size:17px;line-height:1.28;font-weight:800}.source-meta{display:flex;gap:10px;align-items:center;min-width:0;margin-top:6px;color:var(--muted);font-size:13px}.source-meta span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.domain{color:var(--sage);font-weight:750}.product-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;padding-top:16px}.product{display:grid;grid-template-columns:124px minmax(0,1fr);gap:14px;padding:12px;border:1px solid #d8e2dd;border-radius:8px;background:#f8fbf8}.product-media{width:124px;aspect-ratio:1;border:1px solid var(--line);border-radius:8px;background:var(--paper-2);object-fit:cover}.product-placeholder{display:grid;place-items:center;color:var(--muted);font-size:22px;font-weight:850}.product h3{margin:0;font-size:15px;line-height:1.3}.price{margin-top:8px;color:var(--amber);font-size:20px;font-weight:850}.product-meta{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;color:var(--muted);font-size:12px}.pill{display:inline-flex;align-items:center;min-height:24px;border-radius:999px;padding:3px 9px;background:var(--paper-2);border:1px solid var(--line);font-size:12px;font-weight:750;color:#40504a}.side{display:grid;gap:0;overflow:hidden}.side-section{padding:18px 18px 16px;border-bottom:1px solid var(--line)}.side-section:last-child{border-bottom:0}.todo{display:grid;gap:11px;margin:14px 0 0;padding:0;list-style:none}.todo li{display:grid;grid-template-columns:22px minmax(0,1fr);gap:10px;align-items:start;color:#27302c;font-size:13px;line-height:1.35}.check{display:grid;place-items:center;width:22px;height:22px;border-radius:6px;background:var(--sage-soft);color:var(--sage);font-size:12px;font-weight:900}.check.pending{background:var(--amber-soft);color:var(--amber)}.history{display:grid;gap:10px;margin-top:14px}.history-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;padding:10px 0;border-top:1px solid #e4ece8}.history-row:first-child{border-top:0}.history-title{margin:0;font-size:13px;line-height:1.3;font-weight:800}.history-url{margin-top:4px;color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.empty{padding:16px;border:1px dashed var(--line-strong);border-radius:8px;color:var(--muted);font-size:13px;background:rgba(255,253,248,.54)}.generic{display:grid;gap:10px;padding:16px 0;border-top:1px solid var(--line)}.generic h2,.generic h3,.generic p{margin:0}.status{position:fixed;right:18px;bottom:18px;z-index:10;background:#18201d;color:#fbfcfa;border:1px solid rgba(255,255,255,.14);padding:11px 13px;border-radius:8px;box-shadow:0 18px 60px rgba(0,0,0,.22);max-width:min(420px,calc(100vw - 36px));font-size:13px}@media (max-width:900px){.hero{grid-template-columns:1fr}.metrics{grid-template-columns:repeat(3,minmax(0,1fr))}.grid{grid-template-columns:1fr}.source-row{grid-template-columns:34px minmax(0,1fr);align-items:start}.source-row .actions{grid-column:2}.product-grid{grid-template-columns:1fr}}@media (max-width:560px){.app{padding-inline:14px}.hero h1{font-size:36px}.metrics{grid-template-columns:1fr 1fr}.source-row{gap:10px}.product{grid-template-columns:1fr}.product-media{width:100%;max-height:260px}.panel-head{display:grid}.source-meta{display:grid;gap:4px}.source-meta span{white-space:normal}.actions{display:flex;flex-wrap:wrap;gap:8px}}@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#11110f;--paper:#191816;--paper-2:#22201d;--ink:#f4efe7;--muted:#b8ad9e;--line:#353029;--line-strong:#50483d;--sage:#93c5a4;--sage-soft:#20372a;--blue:#96bee8;--blue-soft:#1f3142;--amber:#f1b56c;--amber-soft:#3d2b18;--shadow:none}body{background:#11110f}.brief p{color:#e8dfd1}.source-row{border-color:#2c2822}.product{background:#1d1b18;border-color:#393228}.history-row{border-color:#2c2822}.todo li{color:#e8dfd1}button{background:#211f1b;color:var(--ink)}button.primary{background:#f4efe7;color:#18201d;border-color:#f4efe7}}
</style>
</head>
<body><main class="app" data-work-studio-shell="analysis">
  <header class="hero">
    <div>
      <p class="eyebrow">Work Studio</p>
      <h1 id="taskTitle">${escapeHtml(task.title || "Work Studio")}</h1>
      <p id="taskSummary"></p>
    </div>
    <div class="metrics" aria-label="Task counts">
      <div class="metric"><strong id="itemCount">0</strong><span>Results</span></div>
      <div class="metric"><strong id="historyCount">0</strong><span>History</span></div>
      <div class="metric"><strong id="tabCount">0</strong><span>Live tabs</span></div>
    </div>
  </header>
  <section class="grid">
    <article class="panel">
      <div class="panel-head">
        <div>
          <h2 class="panel-title">Task result</h2>
          <p class="panel-note" id="resultNote"></p>
        </div>
        <div class="actions" id="primaryActions"></div>
      </div>
      <div class="result-body" id="surface"></div>
    </article>
    <aside class="panel side">
      <section class="side-section">
        <h2 class="panel-title">Run checklist</h2>
        <ol class="todo" id="todoList"></ol>
      </section>
      <section class="side-section">
        <div class="panel-head" style="padding:0;border:0">
          <div>
            <h2 class="panel-title">Tab history</h2>
            <p class="panel-note" id="historyNote"></p>
          </div>
          <button id="restoreAll" class="ghost" type="button">Restore all</button>
        </div>
        <div class="history" id="historyList"></div>
      </section>
    </aside>
  </section>
</main><div id="status" class="status" hidden></div>
<script>
const taskBase = ${JSON.stringify(base)};
const auth = { Authorization: 'Bearer ' + ${JSON.stringify(token)} };
const surface = document.getElementById('surface');
const statusBox = document.getElementById('status');
const components = new Map();
const model = {};
let taskState = null;
let historyState = [];
function showStatus(text){ statusBox.textContent = text; statusBox.hidden = false; setTimeout(function(){ statusBox.hidden=true; }, 3500); }
async function api(path, options={}) {
  const res = await fetch(path, { ...options, headers: { ...auth, 'Content-Type': 'application/json', ...(options.headers||{}) } });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'request failed');
  return json;
}
window.workStudio = {
  getTask: () => api(taskBase),
  getA2UI: () => api(taskBase + '/a2ui'),
  getHistory: () => api(taskBase + '/history'),
  restoreHistory: (idsOrAll={all:true}) => api(taskBase + '/history/restore', { method:'POST', body: JSON.stringify(Array.isArray(idsOrAll) ? { ids: idsOrAll } : idsOrAll) }),
  openOriginal: (itemId) => api(taskBase + '/items/' + encodeURIComponent(itemId) + '/open-original', { method:'POST', body:'{}' }),
  checkoutItem: (itemId, params={}) => api(taskBase + '/items/' + encodeURIComponent(itemId) + '/checkout', { method:'POST', body: JSON.stringify({ params }) }),
  runBinding: (bindingId, params={}) => api(taskBase + '/bindings/' + encodeURIComponent(bindingId) + '/run', { method:'POST', body: JSON.stringify({ params }) }),
  action: (name, context={}) => api(taskBase + '/actions/' + encodeURIComponent(name), { method:'POST', body: JSON.stringify(context) })
};
function childText(id){ const c = components.get(id); return c?.text || id; }
function component(id){ return components.get(id); }
function componentText(id){ return String(component(id)?.text || ''); }
function el(tag, className, text){
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
function renderComponent(c){
  if (!c || !c.id) return document.createTextNode('');
  let el;
  if (c.component === 'Button') { el = document.createElement('button'); el.textContent = c.text || childText(c.child) || 'Action'; if(c.variant==='primary') el.className='primary'; if(c.action?.event) el.onclick = () => dispatchAction(c.action.event); }
  else if (c.component === 'Image') { el = document.createElement('img'); el.src = c.src || c.url || ''; el.alt = c.alt || ''; el.style.maxWidth='180px'; }
  else if (c.component === 'Divider') { el = document.createElement('hr'); }
  else { el = document.createElement(c.variant === 'h1' ? 'h2' : c.variant === 'h2' ? 'h2' : c.variant === 'h3' ? 'h3' : 'p'); el.textContent = c.text || ''; if(c.variant==='subtitle') el.className='subtitle'; }
  el.dataset.componentId = c.id;
  return el;
}
function mergeModel(path, value){
  if (!path || path === '/') Object.assign(model, value || {});
  else model[path.replace(/^\\//, '')] = value;
}
function processMessages(messages){
  for (const m of messages || []) {
    const update = m.updateComponents;
    if(update?.components) for (const c of update.components) components.set(c.id, c);
    if(m.updateDataModel) mergeModel(m.updateDataModel.path, m.updateDataModel.value);
  }
  rerender();
}
function domainFor(url){
  try { return new URL(url).hostname.replace(/^www\\./, ''); } catch { return ''; }
}
function firstField(item, names){
  for (const name of names) {
    const value = item?.[name];
    if (value !== undefined && value !== null && String(value) !== '') return value;
  }
  return '';
}
function itemById(id){ return taskItems().find((item) => String(item.id) === String(id)); }
function imageFor(item){ return firstField(item, ['image','imageUrl','image_url','thumbnail','thumbnailUrl','photo','src']); }
function priceFor(item){ return firstField(item, ['price','currentPrice','salePrice','priceText']); }
function ratingFor(item){ return firstField(item, ['rating','stars','score','reviewRating']); }
function checkoutUrlFor(item){ return firstField(item, ['checkoutUrl','checkout_url','checkoutPageUrl','checkout_page_url','buyUrl','buy_url','cartUrl','cart_url','orderUrl','order_url','purchaseUrl','purchase_url']); }
function isProduct(item){ return Boolean(imageFor(item) || priceFor(item) || ratingFor(item) || item?.availability || item?.merchant || item?.store); }
function openBrowserUrl(url){
  if (!url) return false;
  window.open(String(url), '_blank', 'noopener');
  return true;
}
function fallbackAction(event){
  const item = itemById(event?.context?.itemId);
  if (!item) return false;
  if (event.name === 'open_original') {
    return openBrowserUrl(item.url);
  }
  if (event.name === 'checkout_item') {
    return openBrowserUrl(checkoutUrlFor(item) || item.url);
  }
  return false;
}
function renderChrome(){
  if (!taskState) return;
  document.getElementById('taskTitle').textContent = componentText('title') || taskState.title || 'Work Studio';
  const summary = componentText('summary') || componentText('subtitle') || taskState.data?.summary || '';
  document.getElementById('taskSummary').textContent = summary || 'A persistent task space with results, source tabs, and recovery actions.';
  const items = taskItems();
  document.getElementById('itemCount').textContent = String(items.length);
  document.getElementById('historyCount').textContent = String(historyState.length || taskState.tabs?.historyCount || 0);
  document.getElementById('tabCount').textContent = String(taskState.tabs?.interactiveCount || 0);
  document.getElementById('resultNote').textContent = items.length ? 'Reviewed outputs are grouped with their source actions.' : 'No structured results were attached to this task.';
  document.getElementById('historyNote').textContent = historyState.length ? String(historyState.length) + ' archived source tab' + (historyState.length === 1 ? '' : 's') : 'No archived tabs yet';
  const restoreAll = document.getElementById('restoreAll');
  restoreAll.disabled = !historyState.some((tab) => tab.restoreable !== false);
  restoreAll.onclick = () => restoreHistory({ all: true });
}
function taskItems(){
  return Array.isArray(taskState?.items) && taskState.items.length ? taskState.items : Array.isArray(model.items) ? model.items : [];
}
function renderBrief(){
  const subtitle = componentText('subtitle');
  const summary = componentText('summary');
  if (!subtitle && !summary) return null;
  const box = el('section', 'brief');
  if (subtitle) box.append(el('p', 'subtitle', subtitle));
  if (summary) box.append(el('p', '', summary));
  return box;
}
function actionForItem(item){
  const button = component(String(item.id) + '_open');
  if (button) return renderComponent(button);
  const fallback = el('button', '', 'Open original');
  fallback.onclick = () => dispatchAction({ name: 'open_original', context: { itemId: item.id } });
  return fallback;
}
function checkoutActionForItem(item){
  const button = el('button', 'primary checkout', 'Checkout');
  button.onclick = () => dispatchAction({ name: 'checkout_item', context: { itemId: item.id } });
  return button;
}
function renderSourceItem(item, index){
  const row = el('div', 'source-row');
  row.append(el('div', 'index', String(index + 1).padStart(2, '0')));
  const main = el('div', '');
  main.append(el('h3', 'source-title', componentText(String(item.id) + '_title') || item.title || item.id));
  const meta = el('div', 'source-meta');
  const domain = domainFor(String(item.url || ''));
  if (domain) meta.append(el('span', 'domain', domain));
  if (item.url) meta.append(el('span', '', item.url));
  if (item.reason) meta.append(el('span', '', item.reason));
  main.append(meta);
  row.append(main);
  const actions = el('div', 'actions');
  actions.append(actionForItem(item));
  row.append(actions);
  return row;
}
function renderProductItem(item){
  const card = el('article', 'product');
  const image = imageFor(item);
  if (image) {
    const img = el('img', 'product-media');
    img.src = String(image);
    img.alt = String(item.title || item.id || 'Product');
    card.append(img);
  } else {
    card.append(el('div', 'product-media product-placeholder', 'P'));
  }
  const body = el('div', '');
  body.append(el('h3', '', componentText(String(item.id) + '_title') || item.title || item.id));
  const price = priceFor(item);
  if (price) body.append(el('div', 'price', price));
  const meta = el('div', 'product-meta');
  const fields = [
    firstField(item, ['merchant','store','site']),
    ratingFor(item) ? 'Rating ' + ratingFor(item) : '',
    firstField(item, ['availability','shipping','delivery'])
  ].filter(Boolean);
  for (const value of fields) meta.append(el('span', 'pill', value));
  if (item.url) meta.append(el('span', 'pill', domainFor(String(item.url)) || 'Source'));
  if (fields.length || item.url) body.append(meta);
  const actions = el('div', 'actions');
  actions.style.marginTop = '12px';
  actions.append(checkoutActionForItem(item));
  actions.append(actionForItem(item));
  body.append(actions);
  card.append(body);
  return card;
}
function renderItems(items){
  if (!items.length) return el('div', 'empty', 'No result items were attached.');
  if (items.some(isProduct)) {
    const grid = el('div', 'product-grid');
    for (const item of items) grid.append(renderProductItem(item));
    return grid;
  }
  const list = el('div', 'items');
  items.forEach((item, index) => list.append(renderSourceItem(item, index)));
  return list;
}
function consumedIds(items){
  const ids = new Set(['title','subtitle','summary']);
  for (const item of items) {
    ids.add(String(item.id) + '_title');
    ids.add(String(item.id) + '_open');
  }
  ids.add('history_toggle');
  return ids;
}
function renderGeneric(items){
  const used = consumedIds(items);
  const box = el('section', 'generic');
  let count = 0;
  for (const c of components.values()) {
    if (used.has(String(c.id))) continue;
    if (String(c.id).startsWith('history_')) continue;
    box.append(renderComponent(c));
    count++;
  }
  return count ? box : null;
}
function rerender(){
  renderChrome();
  surface.replaceChildren();
  const brief = renderBrief();
  if (brief) surface.append(brief);
  const items = taskItems();
  surface.append(renderItems(items));
  const generic = renderGeneric(items);
  if (generic) surface.append(generic);
  renderPrimaryActions();
  renderTodos();
  renderHistoryList();
}
function renderPrimaryActions(){
  const actions = document.getElementById('primaryActions');
  actions.replaceChildren();
  const historyButton = component('history_toggle');
  if (historyButton) actions.append(renderComponent(historyButton));
}
function normalizedTodos(){
  const raw = taskState?.data?.todos || taskState?.data?.todo || taskState?.data?.steps;
  if (Array.isArray(raw) && raw.length) {
    return raw.map((item) => typeof item === 'string' ? { text: item, done: true } : {
      text: item.text || item.title || item.label || 'Task step',
      done: item.done ?? item.completed ?? item.status === 'done'
    });
  }
  const items = taskItems();
  return [
    { text: 'Collect source tabs', done: Boolean((taskState?.tabs?.interactiveCount || 0) + historyState.length) },
    { text: 'Prepare task result', done: Boolean(items.length || componentText('summary')) },
    { text: 'Archive browsing history', done: Boolean(historyState.length) },
    { text: 'Ready for review', done: true }
  ];
}
function renderTodos(){
  const list = document.getElementById('todoList');
  list.replaceChildren();
  for (const item of normalizedTodos()) {
    const li = el('li', '');
    li.append(el('span', 'check' + (item.done ? '' : ' pending'), item.done ? 'OK' : ''));
    li.append(el('span', '', item.text));
    list.append(li);
  }
}
function renderHistoryList(){
  const list = document.getElementById('historyList');
  list.replaceChildren();
  if (!historyState.length) {
    list.append(el('div', 'empty', 'No archived source tabs.'));
    return;
  }
  for (const tab of historyState) {
    const row = el('div', 'history-row');
    const main = el('div', '');
    main.append(el('p', 'history-title', tab.title || tab.url || tab.id));
    main.append(el('div', 'history-url', domainFor(String(tab.url || '')) || tab.url || tab.role || 'Archived tab'));
    row.append(main);
    const restore = el('button', 'ghost', 'Restore');
    restore.disabled = tab.restoreable === false;
    restore.onclick = () => restoreHistory([tab.id]);
    row.append(restore);
    list.append(row);
  }
}
async function restoreHistory(idsOrAll){
  try {
    const result = await window.workStudio.restoreHistory(idsOrAll);
    showStatus('Restored ' + (result.opened?.length || 0) + ' tab' + ((result.opened?.length || 0) === 1 ? '' : 's'));
  } catch(e) {
    showStatus(e.message || String(e));
  }
}
async function dispatchAction(event){
  try {
    const result = await window.workStudio.action(event.name, event.context || {});
    if (result && result.ok === false && fallbackAction(event)) {
      showStatus('Opened in browser');
      return;
    }
    if (result.history) historyState = result.history;
    if(result.a2ui) processMessages(result.a2ui);
    rerender();
    showStatus(result.message || result.status || 'Done');
  } catch(e) {
    if (fallbackAction(event)) {
      showStatus('Opened in browser');
      return;
    }
    showStatus(e.message || String(e));
  }
}
window.addEventListener('DOMContentLoaded', async () => {
  try {
    const loaded = await Promise.all([window.workStudio.getTask(), window.workStudio.getA2UI(), window.workStudio.getHistory()]);
    taskState = loaded[0];
    historyState = loaded[2]?.tabs || [];
    processMessages(loaded[1]);
  } catch(e) {
    surface.replaceChildren(el('div', 'empty', e.message || String(e)));
  }
});
</script></body></html>`;
}

function interpolate(value: string, params: Record<string, unknown>) {
  return value.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_, key) => String(params[key] ?? ""));
}

async function requestJson(req: IncomingMessage) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(`${JSON.stringify(value)}\n`);
}

function html(res: ServerResponse, value: string) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(value);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
