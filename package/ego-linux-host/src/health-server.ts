import { createServer, type Server } from "node:http";

export type HealthServerOptions = {
  host?: string;
  port: number;
  isReady: () => Promise<boolean>;
};

export type HealthServer = {
  host: string;
  port: number;
  close(): Promise<void>;
};

function writeJson(
  requestMethod: string | undefined,
  response: import("node:http").ServerResponse,
  status: number,
  payload: Record<string, unknown>,
): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(requestMethod === "HEAD" ? undefined : body);
}

export async function startHealthServer(
  options: HealthServerOptions,
): Promise<HealthServer> {
  const host = options.host ?? "::";
  const server: Server = createServer((request, response) => {
    void (async () => {
      const method = request.method;
      if (method !== "GET" && method !== "HEAD") {
        writeJson(method, response, 405, { ok: false });
        return;
      }
      const path = new URL(request.url ?? "/", "http://health.local").pathname;
      if (path === "/livez") {
        writeJson(method, response, 200, { ok: true, status: "live" });
        return;
      }
      if (path === "/readyz" || path === "/health") {
        let ready = false;
        try {
          ready = await options.isReady();
        } catch {
          ready = false;
        }
        writeJson(method, response, ready ? 200 : 503, {
          ok: ready,
          status: ready ? "ready" : "not_ready",
        });
        return;
      }
      writeJson(method, response, 404, { ok: false });
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("health server did not expose a TCP address");
  }

  let closed = false;
  return {
    host,
    port: address.port,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
