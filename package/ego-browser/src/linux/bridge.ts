/**
 * Linux bridge — connects to Chrome via DevTools HTTP + WebSocket.
 * Uses raw node:http for /json so it never collides with the agent
 * helper facade that overwrites globalThis.fetch.
 */
import { request as httpRequest } from "node:http";

export interface LinuxBridgeTarget {
  send(message: string): void;
  close(): void;
}

export interface LinuxBridgeOptions {
  port?: number;
  timeoutMs?: number;
}

async function fetchJson<T>(url: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const req = httpRequest(url, (res) => {
      let data = "";
      res.on("data", (c: Buffer) => (data += c.toString()));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data) as T);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

export async function connectLinuxBridge(
  options: LinuxBridgeOptions = {},
): Promise<LinuxBridgeTarget> {
  const port = options.port ?? 9222;
  const timeoutMs = options.timeoutMs ?? 5000;

  const targets = await fetchJson<Array<{ webSocketDebuggerUrl: string }>>(
    `http://127.0.0.1:${port}/json`,
  );

  const page = targets.find((t) => t.webSocketDebuggerUrl);
  if (!page) {
    throw new Error(
      `No page target found on port ${port}. Is Chrome running with --remote-debugging-port=${port}?`,
    );
  }

  const ws = await connectWithTimeout(page.webSocketDebuggerUrl, timeoutMs);

  const send = (message: string): void => {
    if (ws.readyState !== ws.OPEN) {
      throw new Error("WebSocket is not open");
    }
    ws.send(message);
  };

  const close = (): void => {
    ws.close();
  };

  return { send, close };
}

async function connectWithTimeout(
  url: string,
  timeoutMs: number,
): Promise<import("ws").WebSocket> {
  const { WebSocket } = await import("ws");

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(
        new Error(
          `WebSocket connection to ${url} timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);

    ws.on("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });

    ws.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
