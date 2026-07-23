/**
 * CLI-side host connection and globalThis.ego client.
 *
 * Speaks NDJSON RPC over a Unix domain socket with ego-linux-hostd.
 */

import { createConnection, type Socket } from "node:net";
import {
  decodeLine,
  encodeRequest,
  isRpcEvent,
  isRpcResponse,
  LineBuffer,
} from "./rpc.js";
import { makeEgoError } from "./errors.js";

export type HostConnection = {
  request(method: string, params?: any): Promise<any>;
  /** Subscribe to all RPC events; returns unsubscribe. */
  onEvent(handler: (event: string, params?: any) => void): () => void;
  close(): void;
};

type Pending = {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
};

/**
 * Connect to the host daemon Unix socket and return a request/event API.
 */
export async function connectHost(socketPath: string): Promise<HostConnection> {
  const socket = await openSocket(socketPath);
  const lineBuf = new LineBuffer();
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const eventHandlers = new Set<(event: string, params?: any) => void>();
  let closed = false;

  function failAll(err: Error): void {
    for (const [, p] of pending) {
      p.reject(err);
    }
    pending.clear();
  }

  function onData(chunk: Buffer | string): void {
    for (const line of lineBuf.push(chunk)) {
      let msg: unknown;
      try {
        msg = decodeLine(line);
      } catch {
        continue;
      }
      if (isRpcResponse(msg)) {
        const p = pending.get(msg.id);
        if (!p) continue;
        pending.delete(msg.id);
        if (msg.error) {
          p.reject(makeEgoError(msg.error.code, msg.error.message));
        } else {
          p.resolve(msg.result);
        }
        continue;
      }
      if (isRpcEvent(msg)) {
        for (const h of eventHandlers) {
          try {
            h(msg.event, msg.params);
          } catch {
            // subscriber errors must not break the connection
          }
        }
      }
    }
  }

  socket.on("data", onData);
  socket.on("error", (err) => {
    if (closed) return;
    failAll(err instanceof Error ? err : new Error(String(err)));
  });
  socket.on("close", () => {
    if (closed) return;
    closed = true;
    failAll(
      makeEgoError(
        "EGO_TASK_HOST_DISCONNECTED",
        "host daemon socket closed",
      ),
    );
  });

  return {
    request(method: string, params?: any): Promise<any> {
      if (closed || socket.destroyed) {
        return Promise.reject(
          makeEgoError(
            "EGO_TASK_HOST_DISCONNECTED",
            "host daemon socket is closed",
          ),
        );
      }
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          socket.write(encodeRequest({ id, method, params }));
        } catch (err) {
          pending.delete(id);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
    onEvent(handler: (event: string, params?: any) => void): () => void {
      eventHandlers.add(handler);
      return () => {
        eventHandlers.delete(handler);
      };
    },
    close(): void {
      if (closed) return;
      closed = true;
      pending.clear();
      eventHandlers.clear();
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    },
  };
}

function openSocket(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(socketPath);
    const onError = (err: Error) => {
      sock.removeListener("connect", onConnect);
      reject(err);
    };
    const onConnect = () => {
      sock.removeListener("error", onError);
      resolve(sock);
    };
    sock.once("error", onError);
    sock.once("connect", onConnect);
  });
}

/**
 * Quick liveness check: connect, send ping, expect { ok: true }.
 */
export async function pingSocket(
  socketPath: string,
  timeoutMs = 1500,
): Promise<boolean> {
  let conn: HostConnection | undefined;
  try {
    conn = await Promise.race([
      connectHost(socketPath),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("ping connect timeout")),
          timeoutMs,
        ),
      ),
    ]);
    const result = await Promise.race([
      conn.request("ping"),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("ping timeout")), timeoutMs),
      ),
    ]);
    return Boolean(result && result.ok === true);
  } catch {
    return false;
  } finally {
    conn?.close();
  }
}

type EgoClient = {
  listTabs: () => Promise<any>;
  createTab: (url?: string) => Promise<any>;
  listTaskSpaces: () => Promise<any>;
  createTaskSpace: (name: string) => Promise<any>;
  useTaskSpace: (id: number) => Promise<any>;
  claimTaskSpace: (id: number, name?: string) => Promise<any>;
  completeTaskSpace: () => Promise<any>;
  closeTaskSpace: () => Promise<any>;
  handOffTaskSpace: () => Promise<any>;
  takeOverTaskSpace: () => Promise<any>;
  snapshot: (options?: any) => Promise<any>;
  sendCDPMessage: (payload: string) => void | Promise<any>;
  onCDPMessage?: (payload: string) => void;
  onSendCDPMessageError?: (message: string, error_code?: string) => void;
  animationHighlightMouseToPosition?: (x: number, y: number) => Promise<void>;
  setAgentTaskState?: (label: string) => Promise<void>;
  [key: string]: unknown;
};

/**
 * Install globalThis.ego that proxies to the host daemon via HostConnection.
 * Wires cdp.message → ego.onCDPMessage and cdp.sendError → ego.onSendCDPMessageError.
 */
export function installEgoClient(conn: HostConnection): void {
  const ego: EgoClient = {
    listTabs: () => conn.request("ego.listTabs", {}),
    createTab: (url?: string) =>
      conn.request(
        "ego.createTab",
        typeof url === "string" ? { url } : ((url as any) ?? {}),
      ),
    listTaskSpaces: () => conn.request("ego.listTaskSpaces", {}),
    createTaskSpace: (name: string) =>
      conn.request("ego.createTaskSpace", { name }),
    useTaskSpace: (id: number) => conn.request("ego.useTaskSpace", { id }),
    claimTaskSpace: (id: number, name?: string) =>
      conn.request("ego.claimTaskSpace", {
        id,
        ...(name !== undefined ? { name } : {}),
      }),
    completeTaskSpace: () => conn.request("ego.completeTaskSpace", {}),
    closeTaskSpace: () => conn.request("ego.closeTaskSpace", {}),
    handOffTaskSpace: () => conn.request("ego.handOffTaskSpace", {}),
    takeOverTaskSpace: () => conn.request("ego.takeOverTaskSpace", {}),
    snapshot: (options: any = {}) =>
      conn.request("ego.snapshot", options ?? {}),
    sendCDPMessage: (payload: string) => {
      const p = conn.request("ego.sendCDPMessage", { payload });
      // browser-runtime does not await; surface local failures via callback
      if (p && typeof (p as Promise<any>).then === "function") {
        (p as Promise<any>).catch((err: any) => {
          if (typeof ego.onSendCDPMessageError === "function") {
            ego.onSendCDPMessageError(
              err?.message ?? String(err),
              err?.error_code,
            );
          }
        });
      }
      return p;
    },
    animationHighlightMouseToPosition: async () => {},
    setAgentTaskState: async () => {},
  };

  conn.onEvent((event, params) => {
    if (event === "cdp.message") {
      const payload = params?.payload;
      if (typeof payload === "string" && typeof ego.onCDPMessage === "function") {
        try {
          ego.onCDPMessage(payload);
        } catch {
          // ignore listener errors
        }
      }
      return;
    }
    if (event === "cdp.sendError") {
      if (typeof ego.onSendCDPMessageError === "function") {
        try {
          ego.onSendCDPMessageError(params?.message, params?.error_code);
        } catch {
          // ignore
        }
      }
    }
  });

  (globalThis as any).ego = ego;
}
