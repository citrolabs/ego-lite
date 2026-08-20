/**
 * Daemon-side implementations of globalThis.ego methods.
 *
 * Enforces Task Space isolation (listTabs / createTab) and user-control
 * blocks on snapshot / page-domain CDP.
 */

import type { CdpBridge } from "./cdp-bridge.js";
import { makeEgoError } from "./errors.js";
import type { RpcEvent } from "./rpc.js";
import { snapshotPage, type SnapshotOptions } from "./snapshot-engine.js";
import type { SpaceManager } from "./space-manager.js";

/** Browser-level CDP domains that remain allowed under user control. */
function isBrowserLevelMethod(method: string): boolean {
  return method.startsWith("Target.") || method.startsWith("Browser.");
}

export type EgoRuntimeDeps = {
  spaceManager: SpaceManager;
  getCdp: () => CdpBridge;
  ensureSession: () => Promise<string>;
  /** Package version reported by ping when routed through runtime (optional). */
  version?: string;
};

export type EgoRuntime = {
  handle(method: string, params?: any): Promise<any>;
  /** Subscribe to runtime-pushed events (cdp.message, cdp.sendError). */
  onEvent(handler: (ev: RpcEvent) => void): () => void;
  /**
   * Forward all CDP messages from the current bridge to event subscribers.
   * Call after connect / reconnect. Returns unsubscribe.
   */
  attachCdpForwarding(): () => void;
};

function normalizeMethod(method: string): string {
  if (method.startsWith("ego.")) return method.slice(4);
  return method;
}

function publicSpace(space: {
  taskId: string;
  id: number;
  name: string;
  createdBy: string;
  ownership: string;
  recentTabTitles?: string[];
}) {
  return {
    taskId: space.taskId,
    id: space.id,
    name: space.name,
    createdBy: space.createdBy,
    ownership: space.ownership,
    ...(space.recentTabTitles
      ? { recentTabTitles: [...space.recentTabTitles] }
      : {}),
  };
}

/**
 * Create the ego method dispatcher used by the host daemon.
 */
export function createEgoRuntime(deps: EgoRuntimeDeps): EgoRuntime {
  const eventHandlers = new Set<(ev: RpcEvent) => void>();
  let detachCdp: (() => void) | undefined;

  function emit(ev: RpcEvent): void {
    for (const h of eventHandlers) {
      try {
        h(ev);
      } catch {
        // subscriber errors must not break the runtime
      }
    }
  }

  function onEvent(handler: (ev: RpcEvent) => void): () => void {
    eventHandlers.add(handler);
    return () => {
      eventHandlers.delete(handler);
    };
  }

  function attachCdpForwarding(): () => void {
    if (detachCdp) {
      detachCdp();
      detachCdp = undefined;
    }
    const cdp = deps.getCdp();
    const handler = (msg: any) => {
      emit({ event: "cdp.message", params: { payload: JSON.stringify(msg) } });
    };
    if (typeof cdp.onMessage === "function") {
      detachCdp = cdp.onMessage(handler);
    } else {
      // Fallback: events only (responses with id may be missed)
      detachCdp = cdp.onEvent(handler);
    }
    return () => {
      if (detachCdp) {
        detachCdp();
        detachCdp = undefined;
      }
    };
  }

  function emitSendError(message: string, error_code?: string): void {
    emit({
      event: "cdp.sendError",
      params: {
        message,
        ...(error_code ? { error_code } : {}),
      },
    });
  }

  async function listTabs(): Promise<{ tabs: any[] }> {
    const allowed = new Set(deps.spaceManager.targetsForSelected());
    const all = await deps.getCdp().listPageTargets();
    const filtered = all.filter((t) => allowed.has(t.targetId));
    const tabs = filtered.map((t, index) => ({
      targetId: t.targetId,
      title: t.title,
      url: t.url,
      active: index === filtered.length - 1,
      index,
    }));
    return { tabs };
  }

  async function createTab(params: { url?: string } = {}): Promise<{
    targetId: string;
  }> {
    const selected = deps.spaceManager.selected();
    if (!selected) {
      throw makeEgoError(
        "EGO_TASK_SPACE_NOT_SELECTED",
        "task space not selected",
      );
    }
    const url =
      typeof params?.url === "string" && params.url !== ""
        ? params.url
        : "about:blank";
    const targetId = await deps.getCdp().createTarget(url);
    deps.spaceManager.assignTarget(targetId);
    return { targetId };
  }

  async function snapshot(params: SnapshotOptions = {}): Promise<{
    content: string;
    refs: any[];
  }> {
    if (deps.spaceManager.isPageControlBlocked()) {
      throw makeEgoError(
        "EGO_TASK_SPACE_USER_IN_CONTROL",
        "task space is under user control; claim or takeOver before page ops",
      );
    }
    const sessionId = await deps.ensureSession();
    return snapshotPage(deps.getCdp(), sessionId, params);
  }

  async function sendCDPMessage(params: {
    payload?: string;
  }): Promise<{ ok: true }> {
    const raw = params?.payload;
    if (typeof raw !== "string" || raw === "") {
      throw makeEgoError(
        "EGO_INVALID_ARGUMENT",
        "sendCDPMessage requires { payload: string }",
      );
    }

    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      emitSendError(
        `invalid CDP payload JSON: ${err instanceof Error ? err.message : String(err)}`,
        "EGO_INVALID_ARGUMENT",
      );
      return { ok: true };
    }

    const method = typeof msg?.method === "string" ? msg.method : "";
    const pageDomain = method ? !isBrowserLevelMethod(method) : true;

    if (pageDomain && deps.spaceManager.isPageControlBlocked()) {
      emitSendError(
        "task space is under user control; claim or takeOver before page ops",
        "EGO_TASK_SPACE_USER_IN_CONTROL",
      );
      return { ok: true };
    }

    try {
      deps.getCdp().sendRaw(msg);
    } catch (err) {
      const code =
        err &&
        typeof err === "object" &&
        typeof (err as { error_code?: string }).error_code === "string"
          ? (err as { error_code: string }).error_code
          : "EGO_CDP_SEND_FAILED";
      const message =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : String(err);
      emitSendError(message, code);
    }
    return { ok: true };
  }

  async function listTaskSpaces() {
    return { taskSpaces: deps.spaceManager.listPublic() };
  }

  async function createTaskSpace(params: { name?: string } = {}) {
    const name =
      typeof params?.name === "string" && params.name !== ""
        ? params.name
        : "untitled";
    const space = deps.spaceManager.createAgentSpace(name);
    return publicSpace(space);
  }

  async function useTaskSpace(params: { id?: number } = {}) {
    const id = Number(params?.id);
    if (!Number.isFinite(id)) {
      return {
        error: "useTaskSpace requires { id: number }",
        error_code: "EGO_INVALID_ARGUMENT",
      };
    }
    const result = deps.spaceManager.use(id);
    if (result.ok === false) {
      return { error: result.error, error_code: result.error_code };
    }
    return publicSpace(result.space);
  }

  async function claimTaskSpace(params: { id?: number; name?: string } = {}) {
    const id = Number(params?.id);
    if (!Number.isFinite(id)) {
      throw makeEgoError(
        "EGO_INVALID_ARGUMENT",
        "claimTaskSpace requires { id: number }",
      );
    }
    try {
      const space = deps.spaceManager.claim(
        id,
        typeof params?.name === "string" ? params.name : undefined,
      );
      return publicSpace(space);
    } catch (err) {
      if (
        err &&
        typeof err === "object" &&
        (err as { error_code?: string }).error_code
      ) {
        throw err;
      }
      throw makeEgoError(
        "EGO_OPERATION_FAILED",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async function completeTaskSpace() {
    if (!deps.spaceManager.selected()) {
      throw makeEgoError(
        "EGO_TASK_SPACE_NOT_SELECTED",
        "task space not selected",
      );
    }
    deps.spaceManager.completeKeep();
    return { ok: true };
  }

  async function closeTaskSpace() {
    if (!deps.spaceManager.selected()) {
      throw makeEgoError(
        "EGO_TASK_SPACE_NOT_SELECTED",
        "task space not selected",
      );
    }
    const targetIds = deps.spaceManager.closeSelected();
    // Best-effort close page targets in Chrome
    const cdp = deps.getCdp();
    for (const targetId of targetIds) {
      try {
        await cdp.send("Target.closeTarget", { targetId });
      } catch {
        // ignore close failures
      }
    }
    return { ok: true };
  }

  async function handOffTaskSpace() {
    if (!deps.spaceManager.selected()) {
      throw makeEgoError(
        "EGO_TASK_SPACE_NOT_SELECTED",
        "task space not selected",
      );
    }
    deps.spaceManager.handOff();
    return { ok: true };
  }

  async function takeOverTaskSpace() {
    if (!deps.spaceManager.selected()) {
      throw makeEgoError(
        "EGO_TASK_SPACE_NOT_SELECTED",
        "task space not selected",
      );
    }
    deps.spaceManager.takeOver();
    return { ok: true };
  }

  async function handle(method: string, params: any = {}): Promise<any> {
    const name = normalizeMethod(method);
    switch (name) {
      case "listTaskSpaces":
        return listTaskSpaces();
      case "createTaskSpace":
        return createTaskSpace(params);
      case "useTaskSpace":
        return useTaskSpace(params);
      case "claimTaskSpace":
        return claimTaskSpace(params);
      case "completeTaskSpace":
        return completeTaskSpace();
      case "closeTaskSpace":
        return closeTaskSpace();
      case "handOffTaskSpace":
        return handOffTaskSpace();
      case "takeOverTaskSpace":
        return takeOverTaskSpace();
      case "listTabs":
        return listTabs();
      case "createTab":
        return createTab(params);
      case "snapshot":
        return snapshot(params);
      case "sendCDPMessage":
        return sendCDPMessage(params);
      default:
        throw makeEgoError(
          "EGO_INVALID_ARGUMENT",
          `unknown ego method: ${method}`,
        );
    }
  }

  return { handle, onEvent, attachCdpForwarding };
}
