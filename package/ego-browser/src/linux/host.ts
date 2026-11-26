import { createServer, type Socket } from "node:net";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { launchChrome, type ChromeInstance } from "./launcher.js";
import { LinuxTaskSpaces, egoError, invalid } from "./task-spaces.js";
import { LinuxSnapshot } from "./snapshot-ax.js";

type Session = {
  spaceId: number;
  targetId: string;
  parent?: string;
  internal?: boolean;
};
type Client = {
  socket: Socket;
  sessions: Map<string, Session>;
  discovery: Set<number>;
};
const sessionDomains = new Set([
  "Accessibility",
  "Animation",
  "Audits",
  "CSS",
  "Debugger",
  "DOM",
  "DOMDebugger",
  "DOMSnapshot",
  "Emulation",
  "Fetch",
  "Input",
  "Inspector",
  "Log",
  "Media",
  "Network",
  "Overlay",
  "Page",
  "Performance",
  "Profiler",
  "Runtime",
  "WebAudio",
  "WebAuthn",
]);

export class LinuxHost {
  readonly spaces: LinuxTaskSpaces;
  private clients = new Set<Client>();
  private targets = new Map<string, any>();
  private epochs = new Map<number, number>();
  private active = new Map<number, string>();
  private tail: Promise<unknown> = Promise.resolve();
  readonly instanceId = randomUUID();
  constructor(readonly chrome: ChromeInstance) {
    this.spaces = new LinuxTaskSpaces(chrome.bridge.call);
    chrome.bridge.onEvent = (event) => this.onEvent(event);
  }
  add(socket: Socket): Client {
    const client: Client = {
      socket,
      sessions: new Map(),
      discovery: new Set(),
    };
    this.clients.add(client);
    socket.on("close", () => {
      this.clients.delete(client);
      for (const sessionId of client.sessions.keys())
        void this.chrome.bridge
          .call("Target.detachFromTarget", { sessionId })
          .catch(() => {});
    });
    return client;
  }
  private send(client: Client, message: unknown) {
    if (!client.socket.destroyed)
      client.socket.write(JSON.stringify(message) + "\n");
  }
  private onEvent(event: any) {
    const info = event.params?.targetInfo;
    if (info?.targetId) this.targets.set(info.targetId, info);
    for (const client of this.clients) {
      if (event.sessionId) {
        const session = client.sessions.get(event.sessionId);
        if (!session || session.internal) continue;
        try {
          this.spaces.require(session.spaceId);
        } catch {
          continue;
        }
        if (event.method === "Target.attachedToTarget") {
          client.sessions.set(event.params.sessionId, {
            spaceId: session.spaceId,
            targetId: info.targetId,
            parent: event.sessionId,
          });
        }
        this.send(client, { event, spaceId: session.spaceId });
        if (event.method === "Target.detachedFromTarget")
          this.forgetSession(client, event.params.sessionId);
      } else if (event.method === "Target.detachedFromTarget") {
        const session = client.sessions.get(event.params.sessionId);
        if (!session) continue;
        try {
          this.spaces.require(session.spaceId);
          if (!session.internal)
            this.send(client, { event, spaceId: session.spaceId });
        } catch {}
        this.forgetSession(client, event.params.sessionId);
      } else if (
        [
          "Target.targetCreated",
          "Target.targetInfoChanged",
          "Target.targetDestroyed",
        ].includes(event.method)
      ) {
        const target = info ?? this.targets.get(event.params.targetId);
        if (!target) continue;
        for (const id of client.discovery) {
          try {
            if (
              this.spaces.require(id).browserContextId ===
              target.browserContextId
            )
              this.send(client, { event, spaceId: id });
          } catch {}
        }
      }
    }
    if (event.method === "Target.targetDestroyed") {
      this.targets.delete(event.params.targetId);
      for (const [id, targetId] of this.active)
        if (targetId === event.params.targetId) this.active.delete(id);
      for (const client of this.clients)
        for (const [id, session] of client.sessions)
          if (session.targetId === event.params.targetId)
            this.forgetSession(client, id);
    }
  }
  private forgetSession(client: Client, id: string) {
    for (const [child, value] of client.sessions)
      if (value.parent === id) this.forgetSession(client, child);
    client.sessions.delete(id);
  }
  private async targetsFor(spaceId: number) {
    const space = this.spaces.require(spaceId);
    const { targetInfos } = await this.chrome.bridge.call("Target.getTargets");
    for (const target of targetInfos) this.targets.set(target.targetId, target);
    return targetInfos.filter(
      (target: any) => target.browserContextId === space.browserContextId,
    );
  }
  private async target(spaceId: number, targetId: string) {
    const target = (await this.targetsFor(spaceId)).find(
      (target: any) => target.targetId === targetId,
    );
    if (!target)
      throw egoError(
        "EGO_WEB_CONTENTS_UNAVAILABLE",
        "Target does not belong to the selected task space",
      );
    return target;
  }
  private async captureFocusedTarget(spaceId: number) {
    const space = this.spaces.require(spaceId, false);
    if (this.chrome.headless) return;
    const { targetInfos } = await this.chrome.bridge.call("Target.getTargets");
    for (const target of targetInfos.filter(
      (t: any) =>
        t.type === "page" && t.browserContextId === space.browserContextId,
    )) {
      const { sessionId } = await this.chrome.bridge.call(
        "Target.attachToTarget",
        { targetId: target.targetId, flatten: true },
      );
      try {
        const { result } = await this.chrome.bridge.call(
          "Runtime.evaluate",
          {
            expression: "document.hasFocus()",
            returnByValue: true,
            timeout: 500,
          },
          sessionId,
          750,
        );
        if (result?.value === true) {
          this.active.set(spaceId, target.targetId);
          return;
        }
      } catch {
        // A modal dialog can prevent a focus probe; keep the last known tab.
      } finally {
        await this.chrome.bridge
          .call("Target.detachFromTarget", { sessionId })
          .catch(() => {});
      }
    }
  }
  private async revoke(spaceId: number) {
    this.epochs.set(spaceId, (this.epochs.get(spaceId) ?? 0) + 1);
    for (const client of this.clients) {
      for (const [sessionId, session] of client.sessions) {
        if (session.spaceId !== spaceId) continue;
        // Detaching releases paused auto-attached children before user control.
        await this.chrome.bridge
          .call("Target.detachFromTarget", { sessionId })
          .catch(() => {});
        this.forgetSession(client, sessionId);
      }
      client.discovery.delete(spaceId);
    }
  }
  async cdp(client: Client, spaceId: number, message: any) {
    const space = this.spaces.require(spaceId);
    const epoch = this.epochs.get(spaceId) ?? 0;
    const check = () => {
      this.spaces.require(spaceId);
      if ((this.epochs.get(spaceId) ?? 0) !== epoch)
        throw egoError(
          "EGO_TASK_SPACE_INACTIVE",
          "Task control changed during the command",
        );
      if (client.socket.destroyed)
        throw egoError("EGO_TASK_HOST_DISCONNECTED", "Client disconnected");
    };
    const { method, sessionId } = message;
    const params = { ...(message.params ?? {}) };
    if (typeof method !== "string") invalid("CDP method required");
    let session: Session | undefined;
    if (sessionId) {
      session = client.sessions.get(sessionId);
      if (!session || session.spaceId !== spaceId)
        throw egoError(
          "EGO_CDP_SEND_FAILED",
          "Session does not belong to the selected task space",
        );
    }
    if (method.startsWith("Target.") || method.startsWith("Browser.")) {
      if (method === "Browser.getVersion")
        return this.chrome.bridge.call(method);
      if (method === "Target.getTargets")
        return { targetInfos: await this.targetsFor(spaceId) };
      if (method === "Target.setDiscoverTargets") {
        if (params.discover) client.discovery.add(spaceId);
        else client.discovery.delete(spaceId);
        return {};
      }
      if (method === "Target.setAutoAttach" && session) {
        if (params.flatten !== true)
          invalid("Only flat sessions are supported");
        // Do not suspend pages in another CLI's background task. The runtime
        // supports waitingForDebugger=false and still initializes child sessions.
        return this.chrome.bridge.call(
          method,
          { ...params, waitForDebuggerOnStart: false },
          sessionId,
        );
      }
      if (method === "Target.detachFromTarget") {
        const owned = client.sessions.get(params.sessionId as string);
        if (!owned || owned.spaceId !== spaceId)
          throw egoError("EGO_CDP_SEND_FAILED", "Unknown task session");
        const result = await this.chrome.bridge.call(method, {
          sessionId: params.sessionId,
        });
        this.forgetSession(client, params.sessionId as string);
        return result;
      }
      if (method === "Browser.cancelDownload")
        return this.chrome.bridge.call(method, {
          guid: params.guid,
          browserContextId: space.browserContextId,
        });
      if (method === "Target.createTarget") {
        const result = await this.chrome.bridge.call(method, {
          url: params.url ?? "about:blank",
          browserContextId: space.browserContextId,
        });
        check();
        this.active.set(spaceId, result.targetId);
        return result;
      }
      if (
        [
          "Target.getTargetInfo",
          "Target.attachToTarget",
          "Target.activateTarget",
          "Target.closeTarget",
        ].includes(method)
      ) {
        const targetId = (params.targetId ?? session?.targetId) as string;
        await this.target(spaceId, targetId);
        check();
        const result = await this.chrome.bridge.call(method, {
          targetId,
          ...(method === "Target.attachToTarget" ? { flatten: true } : {}),
        });
        if (method === "Target.attachToTarget") {
          try {
            check();
          } catch (error) {
            await this.chrome.bridge
              .call("Target.detachFromTarget", { sessionId: result.sessionId })
              .catch(() => {});
            throw error;
          }
          client.sessions.set(result.sessionId, { spaceId, targetId });
        }
        if (method === "Target.activateTarget")
          this.active.set(spaceId, targetId);
        return result;
      }
      throw egoError(
        "EGO_CDP_SEND_FAILED",
        `Unsupported task-scoped CDP method: ${method}`,
      );
    }
    if (!session || !sessionDomains.has(method.split(".")[0]))
      throw egoError(
        "EGO_CDP_SEND_FAILED",
        `Unsupported task-scoped CDP method: ${method}`,
      );
    return this.chrome.bridge.call(method, params, sessionId);
  }
  enqueue(client: Client, request: any) {
    const job = this.tail.then(() => this.dispatch(client, request));
    // CDP responses may depend on a second command (dialogs, Fetch pauses).
    // Keep state transitions ordered, but never hold their queue for a response.
    if (!["cdp", "snapshot"].includes(request.method))
      this.tail = job.catch(() => {});
    return job;
  }
  private async dispatch(client: Client, request: any): Promise<any> {
    if (client.socket.destroyed)
      throw egoError("EGO_TASK_HOST_DISCONNECTED", "Client disconnected");
    const { method, spaceId, args = [] } = request;
    switch (method) {
      case "hello":
        return { instanceId: this.instanceId, headless: this.chrome.headless };
      case "listProfiles":
        return this.spaces.listProfiles();
      case "listTaskSpaces":
        return this.spaces.listTaskSpaces();
      case "createTaskSpace": {
        const space = await this.spaces.createTaskSpace(args[0], args[1]);
        try {
          await this.chrome.bridge.call("Target.createTarget", {
            url: "about:blank",
            browserContextId: space.browserContextId,
          });
        } catch (error) {
          await this.spaces.closeTaskSpace(space.id);
          throw error;
        }
        return space;
      }
      case "claimTaskSpace": {
        await this.captureFocusedTarget(args[0]);
        return this.spaces.claimTaskSpace(args[0], args[1]);
      }
      case "takeOverTaskSpace": {
        await this.captureFocusedTarget(spaceId);
        return this.spaces.takeOverTaskSpace(spaceId);
      }
      case "checkTaskSpaceCompletion": {
        this.spaces.require(spaceId);
        if (this.chrome.headless)
          throw egoError(
            "EGO_OPERATION_FAILED",
            "User handoff requires a headed Linux host",
          );
        return {};
      }
      case "listTabs": {
        const tabs = (await this.targetsFor(spaceId)).filter(
          (target: any) => target.type === "page",
        );
        return {
          tabs: tabs.map((t: any, index: number) => ({
            ...t,
            index,
            active:
              t.targetId === (this.active.get(spaceId) ?? tabs[0]?.targetId),
          })),
        };
      }
      case "createTab": {
        const space = this.spaces.require(spaceId);
        if (typeof args[0] !== "string") invalid("Tab URL must be a string");
        const result = await this.chrome.bridge.call("Target.createTarget", {
          url: args[0],
          browserContextId: space.browserContextId,
        });
        this.active.set(spaceId, result.targetId);
        return result;
      }
      case "cdp": {
        const epoch = this.epochs.get(spaceId) ?? 0;
        const result = await this.cdp(client, spaceId, args[0]);
        this.spaces.require(spaceId);
        if ((this.epochs.get(spaceId) ?? 0) !== epoch)
          throw egoError(
            "EGO_TASK_SPACE_INACTIVE",
            "Task control changed during the command",
          );
        return result;
      }
      case "snapshot": {
        const epoch = this.epochs.get(spaceId) ?? 0;
        const check = () => {
          this.spaces.require(spaceId);
          if ((this.epochs.get(spaceId) ?? 0) !== epoch)
            throw egoError(
              "EGO_TASK_SPACE_INACTIVE",
              "Task control changed during snapshot",
            );
          if (client.socket.destroyed)
            throw egoError("EGO_TASK_HOST_DISCONNECTED", "Client disconnected");
        };
        const tabs = (await this.targetsFor(spaceId)).filter(
          (target: any) => target.type === "page",
        );
        const targetId = this.active.get(spaceId) ?? tabs[0]?.targetId;
        if (!targetId)
          throw egoError(
            "EGO_WEB_CONTENTS_UNAVAILABLE",
            "No page in task space",
          );
        await this.target(spaceId, targetId);
        check();
        const { sessionId } = await this.chrome.bridge.call(
          "Target.attachToTarget",
          { targetId, flatten: true },
        );
        try {
          check();
          client.sessions.set(sessionId, { spaceId, targetId, internal: true });
          const result = await new LinuxSnapshot((method, params) => {
            check();
            return this.chrome.bridge.call(method, params, sessionId);
          }).snapshot(args[0]);
          check();
          return result;
        } finally {
          this.forgetSession(client, sessionId);
          await this.chrome.bridge
            .call("Target.detachFromTarget", { sessionId })
            .catch(() => {});
        }
      }

      case "handOffTaskSpace":
      case "completeTaskSpace": {
        this.spaces.require(spaceId);
        if (this.chrome.headless)
          throw egoError(
            "EGO_OPERATION_FAILED",
            "User handoff requires a headed Linux host; start with EGO_LINUX_HEADLESS=0 and a display",
          );
        const tabs = await this.targetsFor(spaceId);
        const targetId =
          this.active.get(spaceId) ??
          tabs.find((t: any) => t.type === "page")?.targetId;
        if (targetId)
          await this.chrome.bridge.call("Target.activateTarget", { targetId });
        await this.revoke(spaceId);
        return method === "handOffTaskSpace"
          ? this.spaces.handOffTaskSpace(spaceId)
          : this.spaces.completeTaskSpace(spaceId);
      }
      case "closeTaskSpace": {
        this.spaces.require(spaceId);
        await this.revoke(spaceId);
        return this.spaces.closeTaskSpace(spaceId);
      }
      default:
        invalid(`Unsupported Linux host operation: ${method}`);
    }
  }
}

export async function runLinuxHost(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || stat.mode & 0o077)
    throw new Error(
      "Linux host directory must be owned by this user with mode 0700",
    );
  const socketPath = join(directory, "host.sock");
  let chrome: ChromeInstance | undefined;
  let host: LinuxHost;
  let lastActivity = Date.now();
  let stopping = false;
  let resolveReady: () => void;
  let rejectReady: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    let buffer = "";
    let client: Client;
    const clientReady = ready.then(() => (client = host.add(socket)));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 8 * 1024 * 1024) {
        socket.destroy();
        return;
      }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let request: any;
        try {
          request = JSON.parse(line);
        } catch {
          socket.destroy();
          return;
        }
        lastActivity = Date.now();
        void clientReady
          .then(async () => {
            if (request.method === "stop") {
              stopping = true;
              await chrome.close();
              socket.end(
                JSON.stringify({ id: request.id, result: {} }) + "\n",
                () => void close(),
              );
              return;
            }
            const result = await host.enqueue(client, request);
            if (!socket.destroyed)
              socket.write(JSON.stringify({ id: request.id, result }) + "\n");
          })
          .catch((error) => {
            if (!socket.destroyed)
              socket.write(
                JSON.stringify({
                  id: request.id,
                  error: {
                    message: error.message,
                    code: error.code,
                    error_code:
                      error.error_code ??
                      (request.method === "cdp"
                        ? undefined
                        : "EGO_OPERATION_FAILED"),
                  },
                }) + "\n",
              );
          });
      }
    });
  });
  // Binding is the startup lock. A competing host exits before spawning Chrome.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      stopping = true;
      clearInterval(idle);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await chrome?.close();
      await unlink(socketPath).catch(() => {});
    })());
  const idle = setInterval(() => {
    if (!sockets.size && Date.now() - lastActivity > 30 * 60_000) void close();
  }, 60_000);
  const signal = () => void close();
  process.once("SIGTERM", signal);
  process.once("SIGINT", signal);
  void (async () => {
    chrome = await launchChrome(directory);
    if (stopping) {
      await chrome.close();
      throw new Error("Linux host stopped during startup");
    }
    host = new LinuxHost(chrome);
    chrome.process.once("exit", () => {
      if (!stopping) void close();
    });
    await chrome.bridge.call("Target.setDiscoverTargets", { discover: true });
  })().then(resolveReady, rejectReady);
  try {
    await ready;
  } catch (error) {
    await close();
    throw error;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  runLinuxHost(process.argv[2]).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
