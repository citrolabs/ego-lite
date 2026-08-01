/**
 * Opt-in profile persistence proof against a real Chrome/Chromium process.
 *
 * The test uses a controlled loopback origin, writes a cookie, localStorage,
 * and IndexedDB, gracefully closes the daemon/browser, then starts a new
 * browser process with the same user-data-dir and verifies all three values.
 *
 * Run only when explicitly requested:
 *   EGO_LINUX_PERSISTENCE_E2E=1 node --test dist/persistence-e2e.test.js
 *
 * Set EGO_PERSISTENCE_PHASE=write/read plus a shared
 * EGO_PERSISTENCE_TOKEN and fixed EGO_PERSISTENCE_FIXTURE_PORT to prove the
 * same mounted profile across two separate containers.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { connectCdp, type CdpBridge } from "./cdp-bridge.js";
import type { HostConfig } from "./config.js";
import { startManagedDaemon } from "./host-control.js";

const enabled = process.env.EGO_LINUX_PERSISTENCE_E2E === "1";

async function listen(server: Server, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture server did not expose a TCP port");
  }
  return address.port;
}

async function reservePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("port reservation did not expose a TCP port");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function openControlledPage(
  cdp: CdpBridge,
  url: string,
): Promise<string> {
  const targetId = await cdp.createTarget("about:blank");
  const sessionId = await cdp.attach(targetId);
  await cdp.send("Page.enable", {}, sessionId);

  const loaded = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      detach();
      reject(new Error(`timed out loading controlled fixture: ${url}`));
    }, 10_000);
    const detach = cdp.onEvent((message) => {
      if (
        message?.method === "Page.loadEventFired" &&
        message?.sessionId === sessionId
      ) {
        clearTimeout(timer);
        detach();
        resolve();
      }
    });
  });

  await cdp.send("Page.navigate", { url }, sessionId);
  await loaded;
  return sessionId;
}

async function evaluate(
  cdp: CdpBridge,
  sessionId: string,
  expression: string,
): Promise<unknown> {
  const result = await cdp.send(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
    },
    sessionId,
  );
  if (result?.exceptionDetails) {
    throw new Error(
      `fixture evaluation failed: ${JSON.stringify(result.exceptionDetails)}`,
    );
  }
  return result?.result?.value;
}

test(
  "cookie, localStorage, and IndexedDB survive a browser process restart",
  { skip: !enabled, timeout: 90_000 },
  async (t) => {
    const phase = process.env.EGO_PERSISTENCE_PHASE ?? "roundtrip";
    assert.ok(
      phase === "roundtrip" || phase === "write" || phase === "read",
      `unsupported EGO_PERSISTENCE_PHASE: ${phase}`,
    );
    const suppliedToken = process.env.EGO_PERSISTENCE_TOKEN;
    if (phase !== "roundtrip") {
      assert.ok(
        suppliedToken,
        "EGO_PERSISTENCE_TOKEN is required for split write/read phases",
      );
    }
    const token = suppliedToken ?? randomUUID();
    const generatedRoot = join(
      "/tmp",
      `ego-persist-${process.pid}-${Date.now()}`,
    );
    const dataDir = process.env.EGO_DATA_DIR || join(generatedRoot, "data");
    const runtimeDir =
      process.env.EGO_RUNTIME_DIR || join(generatedRoot, "run");
    const userDataDir =
      process.env.EGO_USER_DATA_DIR || join(dataDir, "profile");
    const cdpPort = process.env.EGO_CDP_PORT
      ? Number(process.env.EGO_CDP_PORT)
      : await reservePort();
    assert.ok(Number.isInteger(cdpPort) && cdpPort > 0 && cdpPort <= 65535);
    const fixture = createHttpServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end("<!doctype html><title>Ego persistence fixture</title>");
    });
    const requestedFixturePort = process.env.EGO_PERSISTENCE_FIXTURE_PORT
      ? Number(process.env.EGO_PERSISTENCE_FIXTURE_PORT)
      : 0;
    assert.ok(
      Number.isInteger(requestedFixturePort) &&
        requestedFixturePort >= 0 &&
        requestedFixturePort <= 65535,
    );
    const fixturePort = await listen(fixture, requestedFixturePort);
    const fixtureUrl = `http://127.0.0.1:${fixturePort}/`;

    const config: HostConfig = {
      chromePath: process.env.EGO_CHROME_PATH || null,
      userDataDir,
      cdpPort,
      headless: true,
      hostSocket: join(runtimeDir, "host.sock"),
      dataDir,
      runtimeDir,
      seedFromChrome: false,
      noSandbox: process.env.EGO_CHROME_NO_SANDBOX === "1",
    };

    let daemon: Awaited<ReturnType<typeof startManagedDaemon>> | null = null;
    let cdp: CdpBridge | null = null;
    t.after(async () => {
      if (cdp) await cdp.close().catch(() => {});
      if (daemon) await daemon.close().catch(() => {});
      await closeServer(fixture).catch(() => {});
      await rm(generatedRoot, { recursive: true, force: true });
    });

    const startBrowser = async () => {
      daemon = await startManagedDaemon({ config });
      cdp = await connectCdp(cdpPort);
    };
    const stopBrowser = async () => {
      if (cdp) await cdp.close();
      cdp = null;
      if (daemon) await daemon.close();
      daemon = null;
    };

    if (phase !== "read") {
      await startBrowser();
      const firstSession = await openControlledPage(cdp!, fixtureUrl);
      const writeResult = await evaluate(
        cdp!,
        firstSession,
        `(async () => {
          document.cookie = ${JSON.stringify(`ego_persist=${token}; Max-Age=3600; Path=/; SameSite=Lax`)};
          localStorage.setItem("ego-persist", ${JSON.stringify(token)});
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open("ego-persistence", 1);
            request.onupgradeneeded = () => request.result.createObjectStore("state");
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          await new Promise((resolve, reject) => {
            const transaction = db.transaction("state", "readwrite");
            transaction.objectStore("state").put(${JSON.stringify(token)}, "token");
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error);
          });
          db.close();
          return { cookie: document.cookie, localStorage: localStorage.getItem("ego-persist") };
        })()`,
      );
      assert.deepEqual(writeResult, {
        cookie: `ego_persist=${token}`,
        localStorage: token,
      });
      await stopBrowser();
      if (phase === "write") return;
    }

    await startBrowser();
    const secondSession = await openControlledPage(cdp!, fixtureUrl);
    const persisted = await evaluate(
      cdp!,
      secondSession,
      `(async () => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open("ego-persistence", 1);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const indexedDb = await new Promise((resolve, reject) => {
          const transaction = db.transaction("state", "readonly");
          const request = transaction.objectStore("state").get("token");
          request.onsuccess = () => resolve(request.result ?? null);
          request.onerror = () => reject(request.error);
        });
        db.close();
        return {
          cookie: document.cookie,
          localStorage: localStorage.getItem("ego-persist"),
          indexedDb,
        };
      })()`,
    );

    assert.deepEqual(persisted, {
      cookie: `ego_persist=${token}`,
      localStorage: token,
      indexedDb: token,
    });
  },
);
