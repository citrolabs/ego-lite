import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEgoBridge } from "../dist/src/ego-bridge.js";
import { TaskSpaceRegistry } from "../dist/src/task-spaces.js";

function fakeConnection(handler = async () => ({})) {
  const connection = {
    requests: [],
    sentRaw: [],
    handlers: new Set(),
    async request(method, params = {}, sessionId = undefined) {
      connection.requests.push({ method, params, sessionId });
      return handler(method, params, sessionId);
    },
    sendRaw(payload) {
      connection.sentRaw.push(payload);
    },
    onMessage(listener) {
      connection.handlers.add(listener);
      return () => connection.handlers.delete(listener);
    },
    emit(raw) {
      for (const listener of [...connection.handlers]) {
        listener(raw);
      }
    },
    close() {},
  };
  return connection;
}

let targetCounter = 0;
function hostHandler(targets = []) {
  return async (method, params, sessionId) => {
    if (method === "Target.getTargets") {
      return { targetInfos: targets };
    }
    if (method === "Target.createTarget") {
      const targetId = `target-${++targetCounter}`;
      targets.push({ targetId, type: "page", url: params.url, title: "" });
      return { targetId };
    }
    if (method === "Target.closeTarget") {
      const index = targets.findIndex((t) => t.targetId === params.targetId);
      if (index >= 0) targets.splice(index, 1);
      return {};
    }
    if (method === "Target.attachToTarget") {
      return { sessionId: "host-sess-1" };
    }
    if (method === "Accessibility.getFullAXTree") {
      return {
        nodes: [
          {
            nodeId: "1",
            role: { value: "RootWebArea" },
            name: { value: "Page" },
            backendDOMNodeId: 1,
            childIds: ["2"],
          },
          {
            nodeId: "2",
            role: { value: "button" },
            name: { value: "Go" },
            backendDOMNodeId: 2,
            childIds: [],
          },
        ],
      };
    }
    return {};
  };
}

async function withBridge(run) {
  const dir = await mkdtemp(join(tmpdir(), "ego-host-bridge-"));
  try {
    const targets = [];
    const hostConnection = fakeConnection(hostHandler(targets));
    const agentConnection = fakeConnection();
    const registry = new TaskSpaceRegistry(dir);
    const ego = createEgoBridge({
      hostConnection,
      agentConnection,
      registry,
      browserVersion: "FakeBrowser/1.0 (ego-windows-host)",
    });
    await run({ ego, registry, hostConnection, agentConnection, targets });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function selectFreshSpace(ego, name = "research") {
  const created = await ego.createTaskSpace(name);
  await ego.useTaskSpace(created.id);
  return created;
}

test("createTaskSpace returns the shape the runtime normalizes", async () => {
  await withBridge(async ({ ego }) => {
    const created = await ego.createTaskSpace("research");
    assert.equal(typeof created.id, "number");
    assert.equal(created.name, "research");
    assert.equal(created.ownership, "agent");
    assert.equal(created.taskId, String(created.id));
  });
});

test("createTaskSpace opens an initial blank tab for the session", async () => {
  await withBridge(async ({ ego, registry }) => {
    const created = await ego.createTaskSpace("research");
    const space = registry.get(created.id);
    assert.equal(space.targetIds.length, 1);
    assert.equal(space.activeTargetId, space.targetIds[0]);
  });
});

test("createTaskSpace rejects an empty name with EGO_INVALID_ARGUMENT", async () => {
  await withBridge(async ({ ego }) => {
    const result = await ego.createTaskSpace("");
    assert.equal(result.error_code, "EGO_INVALID_ARGUMENT");
  });
});

test("listTaskSpaces wraps spaces in { taskSpaces }", async () => {
  await withBridge(async ({ ego }) => {
    await ego.createTaskSpace("research");
    const result = await ego.listTaskSpaces();
    assert.equal(result.taskSpaces.length, 1);
    assert.equal(result.taskSpaces[0].name, "research");
  });
});

test("useTaskSpace resolves not-found for unknown ids", async () => {
  await withBridge(async ({ ego }) => {
    const result = await ego.useTaskSpace(42);
    assert.equal(result.error_code, "EGO_TASK_SPACE_NOT_FOUND");
  });
});

test("listTabs scopes tabs to the selected space", async () => {
  await withBridge(async ({ ego, targets }) => {
    await selectFreshSpace(ego, "research");
    targets.push({
      targetId: "other-tab",
      type: "page",
      url: "https://outside.example",
      title: "outside",
    });
    const { tabs } = await ego.listTabs();
    assert.equal(tabs.length, 1);
    assert.notEqual(tabs[0].targetId, "other-tab");
    assert.equal(tabs[0].active, true);
  });
});

test("listTabs without a selected space resolves EGO_TASK_SPACE_NOT_SELECTED", async () => {
  await withBridge(async ({ ego }) => {
    const result = await ego.listTabs();
    assert.equal(result.error_code, "EGO_TASK_SPACE_NOT_SELECTED");
  });
});

test("createTab tracks and activates the new tab in the space", async () => {
  await withBridge(async ({ ego, registry }) => {
    const created = await selectFreshSpace(ego);
    const result = await ego.createTab("https://example.com");
    const space = registry.get(created.id);
    assert.ok(space.targetIds.includes(result.targetId));
    assert.equal(space.activeTargetId, result.targetId);
  });
});

test("sendCDPMessage forwards traffic verbatim for an agent-owned space", async () => {
  await withBridge(async ({ ego, agentConnection }) => {
    await selectFreshSpace(ego);
    const payload = '{"id":1,"method":"Runtime.evaluate","params":{}}';
    ego.sendCDPMessage(payload);
    assert.deepEqual(agentConnection.sentRaw, [payload]);
  });
});

test("sendCDPMessage without a space reports EGO_TASK_SPACE_NOT_SELECTED", async () => {
  await withBridge(async ({ ego, agentConnection }) => {
    const failures = [];
    ego.onSendCDPMessageError = (message, code) =>
      failures.push({ message, code });
    ego.sendCDPMessage('{"id":1,"method":"Runtime.evaluate"}');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(failures.length, 1);
    assert.equal(failures[0].code, "EGO_TASK_SPACE_NOT_SELECTED");
    assert.equal(agentConnection.sentRaw.length, 0, "nothing is forwarded");
  });
});

test("a handed-off space pauses commands with EGO_TASK_SPACE_USER_IN_CONTROL", async () => {
  await withBridge(async ({ ego, agentConnection }) => {
    await selectFreshSpace(ego);
    await ego.handOffTaskSpace();
    const failures = [];
    ego.onSendCDPMessageError = (message, code) =>
      failures.push({ message, code });
    ego.sendCDPMessage('{"id":1,"method":"Runtime.evaluate"}');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(failures[0].code, "EGO_TASK_SPACE_USER_IN_CONTROL");
    assert.equal(agentConnection.sentRaw.length, 0);

    await ego.takeOverTaskSpace();
    ego.sendCDPMessage('{"id":2,"method":"Runtime.evaluate"}');
    assert.equal(agentConnection.sentRaw.length, 1, "commands resume");
  });
});

test("snapshot rejects with the user-control code during a handoff", async () => {
  await withBridge(async ({ ego }) => {
    await selectFreshSpace(ego);
    await ego.handOffTaskSpace();
    await assert.rejects(ego.snapshot({ maxResultLength: 1 }), (error) => {
      assert.equal(error.error_code, "EGO_TASK_SPACE_USER_IN_CONTROL");
      return true;
    });
  });
});

test("claimTaskSpace returns ownership to the agent", async () => {
  await withBridge(async ({ ego }) => {
    const created = await selectFreshSpace(ego);
    await ego.handOffTaskSpace();
    const claimed = await ego.claimTaskSpace(created.id, created.name);
    assert.equal(claimed.ownership, "agent");
  });
});

test("snapshot renders the AX tree with refs from the active tab", async () => {
  await withBridge(async ({ ego }) => {
    await selectFreshSpace(ego);
    const result = await ego.snapshot();
    assert.match(result.content, /button "Go" \[@2\]/);
    assert.deepEqual(result.refs, [
      { backendNodeId: 2, role: "button", name: "Go" },
    ]);
  });
});

test("snapshot honors maxResultLength for the control probe", async () => {
  await withBridge(async ({ ego }) => {
    await selectFreshSpace(ego);
    const result = await ego.snapshot({ maxResultLength: 1 });
    assert.equal(result.content.length, 1);
  });
});

test("closeTaskSpace closes every tracked tab and removes the space", async () => {
  await withBridge(async ({ ego, registry, hostConnection }) => {
    const created = await selectFreshSpace(ego);
    await ego.createTab("https://example.com");
    await ego.closeTaskSpace();
    const closes = hostConnection.requests.filter(
      (request) => request.method === "Target.closeTarget",
    );
    assert.equal(closes.length, 2);
    assert.equal(registry.get(created.id), undefined);
  });
});

test("completeTaskSpace keeps the tabs and hands the space to the user", async () => {
  await withBridge(async ({ ego, registry, hostConnection }) => {
    const created = await selectFreshSpace(ego);
    await ego.completeTaskSpace();
    assert.equal(registry.get(created.id).ownership, "agentDelegatedToUser");
    const closes = hostConnection.requests.filter(
      (request) => request.method === "Target.closeTarget",
    );
    assert.equal(closes.length, 0);
  });
});

test("a raw Target.createTarget through the bridge is tracked into the space", async () => {
  await withBridge(async ({ ego, registry, agentConnection }) => {
    const created = await selectFreshSpace(ego);
    ego.sendCDPMessage(
      '{"id":7,"method":"Target.createTarget","params":{"url":"about:blank"}}',
    );
    agentConnection.emit('{"id":7,"result":{"targetId":"raw-created-tab"}}');
    const space = registry.get(created.id);
    assert.ok(space.targetIds.includes("raw-created-tab"));
    assert.equal(space.activeTargetId, "raw-created-tab");
  });
});

test("a raw Target.activateTarget updates the active tab", async () => {
  await withBridge(async ({ ego, registry }) => {
    const created = await selectFreshSpace(ego);
    const second = await ego.createTab("https://example.com");
    const first = registry.get(created.id).targetIds[0];
    assert.equal(registry.get(created.id).activeTargetId, second.targetId);
    ego.sendCDPMessage(
      `{"id":9,"method":"Target.activateTarget","params":{"targetId":${JSON.stringify(first)}}}`,
    );
    assert.equal(registry.get(created.id).activeTargetId, first);
  });
});

test("incoming CDP messages reach onCDPMessage verbatim", async () => {
  await withBridge(async ({ ego, agentConnection }) => {
    const seen = [];
    ego.onCDPMessage = (raw) => seen.push(raw);
    agentConnection.emit('{"method":"Page.loadEventFired","params":{}}');
    assert.equal(seen.length, 1);
    assert.match(seen[0], /loadEventFired/);
  });
});

test("getBrowserVersion reports no update so the notice stays silent", async () => {
  await withBridge(async ({ ego }) => {
    const version = await ego.getBrowserVersion();
    assert.equal(version.updateAvailable, false);
    assert.match(version.currentVersion, /ego-windows-host/);
  });
});
