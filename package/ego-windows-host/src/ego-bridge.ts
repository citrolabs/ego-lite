import { CdpConnection } from "./cdp-connection.js";
import { TaskSpaceRegistry, TaskSpace } from "./task-spaces.js";
import { renderAxTree } from "./ax-snapshot.js";

/**
 * The globalThis.ego contract the ego-browser runtime expects, implemented
 * against a stock Chromium browser over two dedicated CDP connections:
 *
 *   - agentConnection: verbatim passthrough for the runtime's own CDP traffic
 *     (sendCDPMessage / onCDPMessage / onSendCDPMessageError).
 *   - hostConnection: host-internal calls (tab bookkeeping, snapshots), so the
 *     runtime's flattened sessions never mix with the host's.
 *
 * Error behavior mirrors the native bindings the runtime is written against
 * (see package/ego-browser/src/ego-errors.ts): task-space methods RESOLVE
 * with { error, error_code } shapes, snapshot REJECTS with an Error carrying
 * .error_code, and local send failures surface through onSendCDPMessageError.
 */

const NOT_SELECTED = {
  error: "no task space is selected; call taskSpaces.useOrCreate(name) first",
  error_code: "EGO_TASK_SPACE_NOT_SELECTED",
};

const USER_IN_CONTROL = {
  error: "the user is controlling this task space",
  error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
};

function notFound(id: unknown) {
  return {
    error: `task space not found: ${JSON.stringify(id)}`,
    error_code: "EGO_TASK_SPACE_NOT_FOUND",
  };
}

function egoError(shape: { error: string; error_code: string }) {
  const error: Error & { error_code?: string } = new Error(shape.error);
  error.error_code = shape.error_code;
  return error;
}

function shapeSpace(space: TaskSpace) {
  return {
    taskId: String(space.id),
    id: space.id,
    name: space.name,
    createdBy: space.createdBy,
    ownership: space.ownership,
    recentTabTitles: [],
  };
}

type BridgeOptions = {
  hostConnection: CdpConnection;
  agentConnection: CdpConnection;
  registry: TaskSpaceRegistry;
  browserVersion?: string;
};

export function createEgoBridge(options: BridgeOptions) {
  const { hostConnection, agentConnection, registry } = options;
  // Runtime requests worth reacting to on their response (Target.createTarget
  // returns the new targetId asynchronously, under the runtime's own id).
  const sniffedCreates = new Set<number>();

  const bridge: Record<string, any> = {
    onCDPMessage: null,
    onSendCDPMessageError: null,

    sendCDPMessage(payload: string) {
      const space = registry.current();
      const blocked = !space
        ? NOT_SELECTED
        : space.ownership !== "agent"
          ? USER_IN_CONTROL
          : null;
      if (blocked) {
        const callback = bridge.onSendCDPMessageError;
        if (typeof callback === "function") {
          queueMicrotask(() => callback(blocked.error, blocked.error_code));
        }
        return;
      }
      // Keep the space's tab bookkeeping consistent when the runtime manages
      // tabs through raw CDP instead of ego.createTab.
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        parsed = null;
      }
      if (
        parsed?.method === "Target.activateTarget" &&
        parsed.params?.targetId
      ) {
        registry.setActive(parsed.params.targetId);
      } else if (parsed?.method === "Target.createTarget" && parsed.id) {
        sniffedCreates.add(parsed.id);
      } else if (
        parsed?.method === "Target.closeTarget" &&
        parsed.params?.targetId
      ) {
        registry.untrackTarget(parsed.params.targetId);
      }
      agentConnection.sendRaw(payload);
    },

    async listTabs() {
      const space = registry.current();
      if (!space) {
        return NOT_SELECTED;
      }
      if (space.ownership !== "agent") {
        return USER_IN_CONTROL;
      }
      const { targetInfos } = await hostConnection.request("Target.getTargets");
      const pages = (targetInfos || []).filter((t) => t.type === "page");
      registry.pruneTargets(pages.map((p) => p.targetId));
      const tracked = new Set(registry.current()?.targetIds || []);
      const tabs = pages
        .filter((p) => tracked.has(p.targetId))
        .map((p, index) => ({
          targetId: p.targetId,
          title: p.title || "",
          url: p.url || "",
          active: p.targetId === registry.current()?.activeTargetId,
          index,
        }));
      if (tabs.length > 0 && !tabs.some((tab) => tab.active)) {
        tabs[tabs.length - 1].active = true;
      }
      return { tabs };
    },

    async createTab(url = "about:blank") {
      const space = registry.current();
      if (!space) {
        return NOT_SELECTED;
      }
      if (space.ownership !== "agent") {
        return USER_IN_CONTROL;
      }
      const created = await hostConnection.request("Target.createTarget", {
        url,
      });
      registry.trackTarget(created.targetId);
      registry.setActive(created.targetId);
      return { targetId: created.targetId };
    },

    async listTaskSpaces() {
      return { taskSpaces: registry.list().map(shapeSpace) };
    },

    async createTaskSpace(name: string) {
      if (typeof name !== "string" || name === "") {
        return {
          error: "createTaskSpace requires a non-empty name",
          error_code: "EGO_INVALID_ARGUMENT",
        };
      }
      const space = registry.create(name);
      // A fresh space starts with one blank tab so the runtime always has a
      // target to attach its session to.
      const created = await hostConnection.request("Target.createTarget", {
        url: "about:blank",
      });
      registry.trackTarget(created.targetId, space.id);
      registry.setActive(created.targetId, space.id);
      return shapeSpace(registry.get(space.id));
    },

    async useTaskSpace(id: number) {
      const space = registry.select(Number(id));
      if (!space) {
        return notFound(id);
      }
      return {};
    },

    async claimTaskSpace(id: number, _name?: string) {
      const space = registry.setOwnership(Number(id), "agent");
      if (!space) {
        return notFound(id);
      }
      return shapeSpace(space);
    },

    async handOffTaskSpace() {
      const space = registry.current();
      if (!space) {
        return NOT_SELECTED;
      }
      registry.setOwnership(space.id, "agentDelegatedToUser");
      return {};
    },

    async takeOverTaskSpace() {
      const space = registry.current();
      if (!space) {
        return NOT_SELECTED;
      }
      registry.setOwnership(space.id, "agent");
      return {};
    },

    async completeTaskSpace() {
      // keep:true — the page stays open for the user; control moves to them.
      const space = registry.current();
      if (!space) {
        return NOT_SELECTED;
      }
      registry.setOwnership(space.id, "agentDelegatedToUser");
      return {};
    },

    async closeTaskSpace() {
      const space = registry.current();
      if (!space) {
        return NOT_SELECTED;
      }
      for (const targetId of [...space.targetIds]) {
        await hostConnection
          .request("Target.closeTarget", { targetId })
          .catch(() => {});
      }
      registry.remove(space.id);
      return {};
    },

    async snapshot(snapshotOptions: any = {}) {
      const space = registry.current();
      if (!space) {
        throw egoError(NOT_SELECTED);
      }
      if (space.ownership !== "agent") {
        // Rejecting with the stable code is the contract probeAgentControl
        // relies on while polling for control to come back.
        throw egoError(USER_IN_CONTROL);
      }
      const targetId = space.activeTargetId ?? space.targetIds.at(-1);
      if (!targetId) {
        throw egoError({
          error: "the task space has no tab to snapshot",
          error_code: "EGO_SNAPSHOT_FAILED",
        });
      }
      const attached = await hostConnection.request("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      const sessionId = attached.sessionId;
      try {
        await hostConnection.request("Accessibility.enable", {}, sessionId);
        const tree = await hostConnection.request(
          "Accessibility.getFullAXTree",
          {},
          sessionId,
        );
        return renderAxTree(tree.nodes || [], {
          maxResultLength: snapshotOptions.maxResultLength,
        });
      } finally {
        hostConnection
          .request("Target.detachFromTarget", { sessionId })
          .catch(() => {});
      }
    },

    async getBrowserVersion() {
      return {
        currentVersion: options.browserVersion || "ego-windows-host",
        updateAvailable: false,
      };
    },
  };

  agentConnection.onMessage((raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
    if (data?.id && sniffedCreates.has(data.id)) {
      sniffedCreates.delete(data.id);
      const targetId = data.result?.targetId;
      if (targetId) {
        registry.trackTarget(targetId);
        registry.setActive(targetId);
      }
    }
    const callback = bridge.onCDPMessage;
    if (typeof callback === "function") {
      callback(raw);
    }
  });

  return bridge;
}
