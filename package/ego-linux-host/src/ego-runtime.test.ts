import test from "node:test";
import assert from "node:assert/strict";
import type { CdpBridge, CdpPageTarget } from "./cdp-bridge.js";
import { createEgoRuntime } from "./ego-runtime.js";
import { SpaceManager } from "./space-manager.js";

type FakeCdp = CdpBridge & {
  targets: CdpPageTarget[];
  rawSent: object[];
  closedTargets: string[];
  messageHandlers: Set<(msg: any) => void>;
  eventHandlers: Set<(msg: any) => void>;
  deliverMessage(msg: any): void;
};

function makeFakeCdp(initial: CdpPageTarget[] = []): FakeCdp {
  let nextTarget = 1;
  const fake: FakeCdp = {
    targets: [...initial],
    rawSent: [],
    closedTargets: [],
    messageHandlers: new Set(),
    eventHandlers: new Set(),
    deliverMessage(msg: any) {
      for (const h of fake.messageHandlers) h(msg);
      if (msg && typeof msg.method === "string") {
        for (const h of fake.eventHandlers) h(msg);
      }
    },
    async send(method: string, params?: object) {
      if (method === "Target.closeTarget") {
        const tid = (params as { targetId?: string })?.targetId;
        if (tid) fake.closedTargets.push(tid);
        return { success: true };
      }
      if (method === "Accessibility.enable") return {};
      if (method === "Accessibility.getFullAXTree") {
        return {
          nodes: [
            {
              role: { value: "button" },
              name: { value: "Go" },
              backendDOMNodeId: 42,
            },
          ],
        };
      }
      return {};
    },
    sendRaw(payload: object) {
      fake.rawSent.push(payload);
    },
    onEvent(handler) {
      fake.eventHandlers.add(handler);
      return () => fake.eventHandlers.delete(handler);
    },
    onMessage(handler) {
      fake.messageHandlers.add(handler);
      return () => fake.messageHandlers.delete(handler);
    },
    async close() {},
    async listPageTargets() {
      return fake.targets.map((t) => ({ ...t }));
    },
    async createTarget(url: string) {
      const targetId = `T${nextTarget++}`;
      fake.targets.push({
        targetId,
        title: "",
        url,
        type: "page",
      });
      return targetId;
    },
    async attach(targetId: string) {
      return `session-${targetId}`;
    },
  };
  return fake;
}

function setup(opts?: { targets?: CdpPageTarget[] }) {
  const sm = new SpaceManager();
  const fakeCdp = makeFakeCdp(opts?.targets);
  const ensureSession = async () => "sess-1";
  const runtime = createEgoRuntime({
    spaceManager: sm,
    getCdp: () => fakeCdp,
    ensureSession,
  });
  return { sm, fakeCdp, runtime, ensureSession };
}

test("snapshot rejects under user control", async () => {
  const { sm, fakeCdp, runtime } = setup();
  sm.use(1); // user
  await assert.rejects(
    () => runtime.handle("snapshot", {}),
    (err: any) => err.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL",
  );
  void fakeCdp;
});

test("snapshot rejects when no space selected", async () => {
  const { runtime } = setup();
  await assert.rejects(
    () => runtime.handle("snapshot", {}),
    (err: any) => err.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL",
  );
});

test("snapshot works for agent-owned space", async () => {
  const { sm, runtime } = setup();
  const space = sm.createAgentSpace("job");
  sm.use(space.id);
  const result = await runtime.handle("snapshot", {
    includeActionMarks: true,
  });
  assert.ok(result.content.includes("button"));
  assert.ok(Array.isArray(result.refs));
  assert.equal(result.refs[0]?.backendNodeId, 42);
});

test("listTabs filters to selected space only", async () => {
  const { sm, fakeCdp, runtime } = setup({
    targets: [
      { targetId: "user-tab", title: "User", url: "https://u.example", type: "page" },
      { targetId: "agent-tab", title: "Agent", url: "https://a.example", type: "page" },
    ],
  });
  sm.adoptOrphanTargets(["user-tab"]);
  const agent = sm.createAgentSpace("agent-job");
  sm.use(agent.id);
  sm.assignTarget("agent-tab");

  const result = await runtime.handle("listTabs", {});
  assert.equal(result.tabs.length, 1);
  assert.equal(result.tabs[0].targetId, "agent-tab");
  assert.equal(result.tabs[0].url, "https://a.example");
  void fakeCdp;
});

test("listTabs returns empty for agent space with no tabs (not user tabs)", async () => {
  const { sm, runtime } = setup({
    targets: [
      {
        targetId: "user-only",
        title: "Mine",
        url: "https://user.example",
        type: "page",
      },
    ],
  });
  sm.adoptOrphanTargets(["user-only"]);
  const agent = sm.createAgentSpace("empty-agent");
  sm.use(agent.id);

  const result = await runtime.handle("listTabs", {});
  assert.deepEqual(result.tabs, []);
});

test("createTab creates target and assigns to selected space", async () => {
  const { sm, runtime } = setup();
  const agent = sm.createAgentSpace("tabs");
  sm.use(agent.id);

  const created = await runtime.handle("createTab", {
    url: "https://example.com",
  });
  assert.ok(created.targetId);
  assert.deepEqual(sm.targetsForSelected(), [created.targetId]);

  const listed = await runtime.handle("listTabs", {});
  assert.equal(listed.tabs.length, 1);
  assert.equal(listed.tabs[0].targetId, created.targetId);
  assert.equal(listed.tabs[0].url, "https://example.com");
});

test("createTab fails without selected space", async () => {
  const { runtime } = setup();
  await assert.rejects(
    () => runtime.handle("createTab", { url: "https://x" }),
    (err: any) => err.error_code === "EGO_TASK_SPACE_NOT_SELECTED",
  );
});

test("task space create / use / claim / handOff / takeOver", async () => {
  const { sm, runtime } = setup();

  const listed0 = await runtime.handle("listTaskSpaces", {});
  assert.ok(listed0.taskSpaces.some((s: any) => s.id === 1));

  const created = await runtime.handle("createTaskSpace", { name: "work" });
  assert.equal(created.name, "work");
  assert.equal(created.ownership, "agent");
  assert.equal("targetIds" in created, false);

  const used = await runtime.handle("useTaskSpace", { id: created.id });
  assert.equal(used.id, created.id);
  assert.equal(sm.selected()?.id, created.id);

  await runtime.handle("handOffTaskSpace", {});
  assert.equal(sm.selected()?.ownership, "agentDelegatedToUser");
  assert.equal(sm.isPageControlBlocked(), true);

  await runtime.handle("takeOverTaskSpace", {});
  assert.equal(sm.selected()?.ownership, "agent");
  assert.equal(sm.isPageControlBlocked(), false);

  sm.use(1);
  const claimed = await runtime.handle("claimTaskSpace", {
    id: 1,
    name: "claimed-user",
  });
  assert.equal(claimed.ownership, "agent");
  assert.equal(claimed.name, "claimed-user");
});

test("useTaskSpace missing returns error object", async () => {
  const { runtime } = setup();
  const result = await runtime.handle("useTaskSpace", { id: 999 });
  assert.equal(result.error_code, "EGO_TASK_SPACE_NOT_FOUND");
  assert.ok(result.error);
});

test("completeTaskSpace keeps tabs under user ownership", async () => {
  const { sm, runtime } = setup();
  const a = sm.createAgentSpace("done");
  sm.use(a.id);
  sm.assignTarget("t-keep");
  await runtime.handle("completeTaskSpace", {});
  assert.equal(sm.list().find((s) => s.id === a.id)?.ownership, "user");
  assert.deepEqual(sm.list().find((s) => s.id === a.id)?.targetIds, ["t-keep"]);
});

test("closeTaskSpace removes agent space and closes targets", async () => {
  const { sm, fakeCdp, runtime } = setup();
  const a = sm.createAgentSpace("close-me");
  sm.use(a.id);
  sm.assignTarget("t-close");
  await runtime.handle("closeTaskSpace", {});
  assert.equal(
    sm.list().find((s) => s.id === a.id),
    undefined,
  );
  assert.deepEqual(fakeCdp.closedTargets, ["t-close"]);
});

test("sendCDPMessage forwards when agent controls space", async () => {
  const { sm, fakeCdp, runtime } = setup();
  const a = sm.createAgentSpace("cdp");
  sm.use(a.id);

  const ack = await runtime.handle("sendCDPMessage", {
    payload: JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression: "1" },
      sessionId: "s1",
    }),
  });
  assert.deepEqual(ack, { ok: true });
  assert.equal(fakeCdp.rawSent.length, 1);
  assert.equal((fakeCdp.rawSent[0] as any).method, "Runtime.evaluate");
});

test("sendCDPMessage page domain blocked under user control emits cdp.sendError", async () => {
  const { sm, fakeCdp, runtime } = setup();
  sm.use(1);

  const events: any[] = [];
  runtime.onEvent((ev) => events.push(ev));

  const ack = await runtime.handle("sendCDPMessage", {
    payload: JSON.stringify({
      id: 2,
      method: "Page.navigate",
      params: { url: "https://evil" },
      sessionId: "s1",
    }),
  });
  assert.deepEqual(ack, { ok: true });
  assert.equal(fakeCdp.rawSent.length, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "cdp.sendError");
  assert.equal(events[0].params.error_code, "EGO_TASK_SPACE_USER_IN_CONTROL");
});

test("sendCDPMessage allows Target.* under user control", async () => {
  const { sm, fakeCdp, runtime } = setup();
  sm.use(1);

  await runtime.handle("sendCDPMessage", {
    payload: JSON.stringify({
      id: 3,
      method: "Target.getTargets",
      params: {},
    }),
  });
  assert.equal(fakeCdp.rawSent.length, 1);
  assert.equal((fakeCdp.rawSent[0] as any).method, "Target.getTargets");
});

test("attachCdpForwarding pushes cdp.message events", async () => {
  const { fakeCdp, runtime } = setup();
  const events: any[] = [];
  runtime.onEvent((ev) => events.push(ev));
  runtime.attachCdpForwarding();

  fakeCdp.deliverMessage({ id: 9, result: { value: 1 } });
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "cdp.message");
  assert.equal(
    JSON.parse(events[0].params.payload).result.value,
    1,
  );
});

test("handle accepts ego. prefix methods", async () => {
  const { sm, runtime } = setup();
  const a = sm.createAgentSpace("prefixed");
  sm.use(a.id);
  const result = await runtime.handle("ego.listTabs", {});
  assert.deepEqual(result.tabs, []);
});
