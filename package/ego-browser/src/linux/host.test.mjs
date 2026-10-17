import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { LinuxHost } from "../../dist/src/linux/host.js";
function fixture(headless = false) {
  const calls = [];
  const targets = [];
  let sequence = 0;
  const chrome = {
    headless,
    bridge: {
      async call(method, params) {
        calls.push({ method, params });
        if (method === "Target.createBrowserContext")
          return { browserContextId: `ctx-${++sequence}` };
        if (method === "Target.createTarget") {
          const target = {
            targetId: `tab-${++sequence}`,
            browserContextId: params.browserContextId,
            type: "page",
          };
          targets.push(target);
          return { targetId: target.targetId };
        }
        if (method === "Target.getTargets") return { targetInfos: targets };
        if (method === "Target.attachToTarget")
          return { sessionId: `session-${++sequence}` };
        return {};
      },
    },
  };
  const host = new LinuxHost(chrome);
  function client() {
    const socket = new EventEmitter();
    socket.write = () => {};
    socket.destroyed = false;
    return host.add(socket);
  }
  const a = client(),
    b = client();
  const call = (client, method, spaceId = null, args = []) =>
    host.enqueue(client, { method, spaceId, args });
  return { calls, targets, host, a, b, call, chrome };
}
test("target inventories and sessions cannot cross task or client boundaries", async () => {
  const { a, b, call } = fixture();
  const x = await call(a, "createTaskSpace", null, ["x"]);
  const y = await call(b, "createTaskSpace", null, ["y"]);
  const tab = (await call(a, "listTabs", x.id)).tabs[0].targetId;
  assert.equal((await call(a, "listTabs", x.id)).tabs.length, 1);
  await assert.rejects(
    call(b, "cdp", y.id, [
      { method: "Target.attachToTarget", params: { targetId: tab } },
    ]),
    { error_code: "EGO_WEB_CONTENTS_UNAVAILABLE" },
  );
  const { sessionId } = await call(a, "cdp", x.id, [
    { method: "Target.attachToTarget", params: { targetId: tab } },
  ]);
  for (const [client, task] of [
    [b, x.id],
    [a, y.id],
  ])
    await assert.rejects(
      call(client, "cdp", task, [{ method: "Runtime.evaluate", sessionId }]),
      { error_code: "EGO_CDP_SEND_FAILED" },
    );
  for (const method of [
    "Target.exposeDevToolsProtocol",
    "Target.attachToBrowserTarget",
    "Target.sendMessageToTarget",
    "Browser.close",
    "Storage.getCookies",
  ])
    await assert.rejects(call(a, "cdp", x.id, [{ method, sessionId }]), {
      error_code: "EGO_CDP_SEND_FAILED",
    });
});
test("handoff blocks APIs and existing CDP sessions across clients until takeover", async () => {
  const { a, b, call } = fixture();
  const task = await call(a, "createTaskSpace", null, ["handoff"]);
  const targetId = (await call(a, "listTabs", task.id)).tabs[0].targetId;
  const { sessionId } = await call(a, "cdp", task.id, [
    { method: "Target.attachToTarget", params: { targetId } },
  ]);
  await call(b, "handOffTaskSpace", task.id);
  for (const method of [
    "listTabs",
    "createTab",
    "snapshot",
    "closeTaskSpace",
    "completeTaskSpace",
    "cdp",
  ])
    await assert.rejects(
      call(
        a,
        method,
        task.id,
        method === "cdp" ? [{ method: "Runtime.evaluate", sessionId }] : [],
      ),
      { error_code: "EGO_TASK_SPACE_USER_IN_CONTROL" },
    );
  await call(b, "takeOverTaskSpace", task.id);
  assert.equal((await call(b, "listTabs", task.id)).tabs.length, 1);
  await assert.rejects(
    call(a, "cdp", task.id, [{ method: "Runtime.evaluate", sessionId }]),
    { error_code: "EGO_CDP_SEND_FAILED" },
  );
});
test("headless handoff fails explicitly and preserves agent control", async () => {
  const { a, call } = fixture(true);
  const task = await call(a, "createTaskSpace", null, ["headless"]);
  await assert.rejects(
    call(a, "handOffTaskSpace", task.id),
    /headed Linux host/,
  );
  assert.equal((await call(a, "listTabs", task.id)).tabs.length, 1);
});

test("dialog handling proceeds while another CDP response is pending", async () => {
  const { a, call, chrome } = fixture();
  const task = await call(a, "createTaskSpace", null, ["dialog"]);
  const targetId = (await call(a, "listTabs", task.id)).tabs[0].targetId;
  const { sessionId } = await call(a, "cdp", task.id, [
    { method: "Target.attachToTarget", params: { targetId } },
  ]);
  const original = chrome.bridge.call;
  let release;
  let started;
  const running = new Promise((resolve) => (started = resolve));
  chrome.bridge.call = (method, ...args) => {
    if (method === "Runtime.evaluate") {
      started();
      return new Promise((resolve) => (release = resolve));
    }
    return original(method, ...args);
  };
  const evaluate = call(a, "cdp", task.id, [
    { method: "Runtime.evaluate", sessionId },
  ]);
  await running;
  let timer;
  try {
    await Promise.race([
      call(a, "cdp", task.id, [
        {
          method: "Page.handleJavaScriptDialog",
          params: { accept: true },
          sessionId,
        },
      ]),
      new Promise(
        (_, reject) =>
          (timer = setTimeout(
            () =>
              reject(
                new Error("dialog handler was blocked by pending evaluation"),
              ),
            500,
          )),
      ),
    ]);
  } finally {
    clearTimeout(timer);
    release({});
    await evaluate;
  }
});

test("active tabs persist across clients and fall back after target destruction", async () => {
  const { a, b, call, chrome, targets } = fixture();
  const task = await call(a, "createTaskSpace", null, ["active"]);
  const created = await call(a, "createTab", task.id, ["about:blank"]);
  assert.equal(
    (await call(b, "listTabs", task.id)).tabs.find((t) => t.active).targetId,
    created.targetId,
  );
  targets.splice(
    targets.findIndex((t) => t.targetId === created.targetId),
    1,
  );
  chrome.bridge.onEvent({
    method: "Target.targetDestroyed",
    params: { targetId: created.targetId },
  });
  assert.equal(
    (await call(b, "listTabs", task.id)).tabs.filter((t) => t.active).length,
    1,
  );
});

test("root detach events reach only the owning client and revoke child sessions", async () => {
  const { a, b, call, chrome } = fixture();
  const task = await call(a, "createTaskSpace", null, ["detach"]);
  const targetId = (await call(a, "listTabs", task.id)).tabs[0].targetId;
  const { sessionId } = await call(a, "cdp", task.id, [
    { method: "Target.attachToTarget", params: { targetId } },
  ]);
  const receivedA = [],
    receivedB = [];
  a.socket.write = (text) => receivedA.push(JSON.parse(text));
  b.socket.write = (text) => receivedB.push(JSON.parse(text));
  chrome.bridge.onEvent({
    method: "Target.attachedToTarget",
    sessionId,
    params: { sessionId: "child", targetInfo: { targetId: "worker" } },
  });
  chrome.bridge.onEvent({
    method: "Target.detachedFromTarget",
    params: { sessionId },
  });
  assert.equal(receivedA.at(-1).event.method, "Target.detachedFromTarget");
  assert.equal(receivedB.length, 0);
  for (const id of [sessionId, "child"])
    await assert.rejects(
      call(a, "cdp", task.id, [{ method: "Runtime.evaluate", sessionId: id }]),
      { error_code: "EGO_CDP_SEND_FAILED" },
    );
});

test("download cancellation forces the selected context", async () => {
  const { a, call, calls } = fixture();
  const task = await call(a, "createTaskSpace", null, ["download"]);
  await call(a, "cdp", task.id, [
    {
      method: "Browser.cancelDownload",
      params: { guid: "download-id", browserContextId: "foreign" },
    },
  ]);
  assert.deepEqual(calls.at(-1), {
    method: "Browser.cancelDownload",
    params: { guid: "download-id", browserContextId: task.browserContextId },
  });
});

test("handoff revokes a pending snapshot without blocking the control queue", async () => {
  const { a, call, chrome } = fixture();
  const task = await call(a, "createTaskSpace", null, ["snapshot"]);
  const original = chrome.bridge.call;
  let release, started;
  const running = new Promise((resolve) => (started = resolve));
  chrome.bridge.call = (method, ...args) => {
    if (method === "Accessibility.enable") {
      started();
      return new Promise((resolve) => (release = resolve));
    }
    return original(method, ...args);
  };
  const pending = call(a, "snapshot", task.id);
  const rejected = assert.rejects(pending, {
    error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
  });
  await running;
  let timer;
  try {
    await Promise.race([
      call(a, "handOffTaskSpace", task.id),
      new Promise(
        (_, reject) =>
          (timer = setTimeout(
            () => reject(new Error("snapshot blocked handoff")),
            500,
          )),
      ),
    ]);
  } finally {
    clearTimeout(timer);
    release({});
    await rejected;
  }
  assert.equal(a.sessions.size, 0);
});

test("disconnected clients cannot execute queued work", async () => {
  const { a, call, calls } = fixture();
  a.socket.destroyed = true;
  await assert.rejects(call(a, "createTaskSpace", null, ["disconnected"]), {
    error_code: "EGO_TASK_HOST_DISCONNECTED",
  });
  assert.equal(calls.length, 0);
});
