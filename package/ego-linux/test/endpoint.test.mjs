import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { waitForEndpoint } from "../src/chrome.mjs";

const PORT_FILE = "DevToolsActivePort";

/** Chrome's port file: the port on the first line, the browser path on the second. */
function portFile(port) {
  return `${port}\n/devtools/browser/8f1c0b7e-0000-4000-8000-000000000000\n`;
}

/** Stand in for Chrome's /json/version endpoint. */
async function startFakeDevTools() {
  const server = createServer((req, res) => {
    if (req.url !== "/json/version") {
      res.writeHead(404);
      res.end();
      return;
    }
    const { port } = server.address();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake` }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port };
}

/** A port number nothing listens on — bound to learn a free one, then released. */
async function deadPort() {
  const { server, port } = await startFakeDevTools();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe("waitForEndpoint", () => {
  it("keeps probing when Chrome rewrites its port file", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "ego-endpoint-"));
    // A launch that loses the ProcessSingleton race publishes a port that never
    // listens; the process that survives rewrites the file a beat later. Probing
    // only the first value read is the bug this guards.
    await writeFile(join(profileDir, PORT_FILE), portFile(await deadPort()));
    const live = await startFakeDevTools();
    const rewrite = setTimeout(() => {
      writeFile(join(profileDir, PORT_FILE), portFile(live.port)).catch(() => {});
    }, 400);

    try {
      const endpoint = await waitForEndpoint(profileDir, { timeoutMs: 8000 });
      assert.equal(endpoint.port, live.port, "returns the port that actually answers");
      assert.match(endpoint.wsUrl, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//);
    } finally {
      clearTimeout(rewrite);
      await new Promise((resolve) => live.server.close(resolve));
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  it("names the port it could not reach when it gives up", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "ego-endpoint-"));
    const dead = await deadPort();
    await writeFile(join(profileDir, PORT_FILE), portFile(dead));

    try {
      await assert.rejects(() => waitForEndpoint(profileDir, { timeoutMs: 1200 }), new RegExp(String(dead)));
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });
});
