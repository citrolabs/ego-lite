import test from "node:test";
import assert from "node:assert/strict";
import { defaultDataDir, defaultSocketPath, defaultCdpPort } from "./paths.js";

test("defaultDataDir uses EGO_DATA_DIR", () => {
  assert.equal(defaultDataDir({ EGO_DATA_DIR: "/tmp/ego-x" }), "/tmp/ego-x");
});

test("defaultSocketPath nests under data dir", () => {
  const sock = defaultSocketPath({ EGO_DATA_DIR: "/tmp/ego-x" });
  assert.equal(sock, "/tmp/ego-x/host.sock");
});

test("defaultCdpPort parses env", () => {
  assert.equal(defaultCdpPort({ EGO_CDP_PORT: "9333" }), 9333);
  assert.equal(defaultCdpPort({}), 9222);
});
