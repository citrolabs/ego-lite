import assert from "node:assert/strict";
import { createConnection, createServer } from "node:net";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  connectHost,
  hostDirectory,
  LinuxClient,
} from "../../dist/src/linux/client.js";

test("headed startup without a display fails before starting a host", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-no-display-"));
  const originalEnv = process.env;
  process.env = {
    ...originalEnv,
    EGO_LINUX_STATE_DIR: root,
    EGO_LINUX_HEADLESS: "0",
    DISPLAY: "",
    WAYLAND_DISPLAY: "",
  };
  try {
    await assert.rejects(
      connectHost(),
      /DISPLAY or WAYLAND_DISPLAY.*EGO_LINUX_HEADLESS=1/,
    );
    assert.deepEqual(await readdir(hostDirectory()), []);
  } finally {
    process.env = originalEnv;
    await rm(root, { recursive: true, force: true });
  }
});

test("an unrelated host disconnect keeps its transport error", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-disconnect-"));
  const server = createServer((socket) =>
    socket.once("data", () => socket.destroy()),
  );
  let client;
  try {
    await new Promise((resolve) =>
      server.listen(join(root, "host.sock"), resolve),
    );
    client = new LinuxClient(createConnection(join(root, "host.sock")));
    await assert.rejects(client.call("hello"), {
      error_code: "EGO_TASK_HOST_DISCONNECTED",
      message: "Linux host disconnected",
    });
  } finally {
    client?.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
