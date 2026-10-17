import { createConnection, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, lstat, unlink, open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { egoError } from "./task-spaces.js";

export function hostDirectory(): string {
  const hostFile = fileURLToPath(new URL("./host.js", import.meta.url));
  const key = createHash("sha256")
    .update(readFileSync(hostFile))
    .update(
      JSON.stringify([
        process.env.EGO_CHROME_BIN,
        process.env.EGO_LINUX_HEADLESS,
        process.env.DISPLAY,
        process.env.WAYLAND_DISPLAY,
      ]),
    )
    .digest("hex")
    .slice(0, 16);
  return join(
    resolve(
      process.env.EGO_LINUX_STATE_DIR ??
        join(
          process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
          "ego-lite",
          "linux",
        ),
    ),
    key,
  );
}

async function connect(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(
      () => socket.destroy(new Error("Linux host connection timed out")),
      1000,
    );
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
  });
}

export class LinuxClient {
  private nextId = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private buffer = "";
  onEvent: (event: any, spaceId: number) => void = () => {};
  instanceId = "";
  constructor(private socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      this.buffer += chunk;
      let end: number;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          socket.destroy(new Error("Invalid Linux host response"));
          return;
        }
        if (message.event) {
          this.onEvent(message.event, message.spaceId);
          continue;
        }
        const request = this.pending.get(message.id);
        if (!request) continue;
        clearTimeout(request.timer);
        this.pending.delete(message.id);
        if (message.error)
          request.reject(
            message.error.error_code
              ? egoError(message.error.error_code, message.error.message)
              : Object.assign(new Error(message.error.message), {
                  code: message.error.code,
                }),
          );
        else request.resolve(message.result);
        if (!this.pending.size) socket.unref();
      }
    });
    const fail = () => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(
          egoError("EGO_TASK_HOST_DISCONNECTED", "Linux host disconnected"),
        );
      }
      this.pending.clear();
    };
    socket.on("error", fail);
    socket.on("close", fail);
  }
  call(
    method: string,
    spaceId: number | null = null,
    args: unknown[] = [],
  ): Promise<any> {
    if (this.socket.destroyed)
      return Promise.reject(
        egoError(
          "EGO_TASK_HOST_DISCONNECTED",
          "Linux host disconnected; start a new CLI round",
        ),
      );
    this.socket.ref();
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (!this.pending.size) this.socket.unref();
        reject(
          egoError("EGO_OPERATION_FAILED", `Linux host ${method} timed out`),
        );
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ id, method, spaceId, args }) + "\n");
    });
  }
  close() {
    this.socket.destroy();
  }
}

export async function connectHost(start = true): Promise<LinuxClient> {
  const directory = hostDirectory();
  await mkdir(directory, { mode: 0o700, recursive: true });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || stat.mode & 0o077)
    throw new Error(
      "Linux host directory must be owned by this user with mode 0700",
    );
  const socketPath = join(directory, "host.sock");
  if (Buffer.byteLength(socketPath) > 103)
    throw new Error(
      "EGO_LINUX_STATE_DIR is too long for a Unix socket; choose a shorter path",
    );
  let socket: Socket;
  try {
    socket = await connect(socketPath);
  } catch (error) {
    if (!start || !["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error;
    if (error.code === "ECONNREFUSED") {
      const stale = await lstat(socketPath).catch(() => undefined);
      if (stale && (!stale.isSocket() || stale.uid !== process.getuid()))
        throw new Error("Refusing to remove an unowned host socket");
      const current = await lstat(socketPath).catch(() => undefined);
      if (stale && current?.ino === stale.ino)
        await unlink(socketPath).catch(() => {});
    }
    const log = await open(join(directory, "startup.log"), "w", 0o600);
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./host.js", import.meta.url)), directory],
      { detached: true, stdio: ["ignore", "ignore", log.fd], env: process.env },
    );
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.unref();
    await log.close();
    const deadline = Date.now() + 20_000;
    while (!socket!) {
      if (spawnError) throw spawnError;
      try {
        socket = await connect(socketPath);
      } catch (error) {
        if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error;
        if (Date.now() >= deadline)
          throw new Error(
            `Linux host did not start: ${(await readFile(join(directory, "startup.log"), "utf8")).slice(-2000)}`,
          );
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
  const client = new LinuxClient(socket);
  try {
    client.instanceId = (await client.call("hello")).instanceId;
  } catch (error) {
    client.close();
    throw error;
  }
  return client;
}
