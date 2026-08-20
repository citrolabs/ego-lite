import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultCdpPort,
  defaultDataDir,
  defaultRuntimeDir,
  defaultSocketPath,
} from "./paths.js";

test("defaultDataDir uses EGO_DATA_DIR", () => {
  assert.equal(defaultDataDir({ EGO_DATA_DIR: "/tmp/ego-x" }), "/tmp/ego-x");
});

test("defaultSocketPath nests under data dir", () => {
  const sock = defaultSocketPath({ EGO_DATA_DIR: "/tmp/ego-x" });
  assert.equal(sock, "/tmp/ego-x/host.sock");
});

test("runtime override keeps sockets off persistent storage", () => {
  const env = {
    EGO_DATA_DIR: "/data/ego-lite",
    EGO_RUNTIME_DIR: "/run/ego-lite",
  };
  assert.equal(defaultRuntimeDir(env), "/run/ego-lite");
  assert.equal(defaultSocketPath(env), "/run/ego-lite/host.sock");
});

test("defaultCdpPort parses env", () => {
  assert.equal(defaultCdpPort({ EGO_CDP_PORT: "9333" }), 9333);
  assert.equal(defaultCdpPort({}), 9222);
});
