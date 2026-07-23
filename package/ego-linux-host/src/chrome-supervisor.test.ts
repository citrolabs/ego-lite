import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFile, chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveChromePath,
  isCdpUp,
  ensureChrome,
} from "./chrome-supervisor.js";
import type { HostConfig } from "./config.js";

function baseConfig(overrides: Partial<HostConfig> = {}): HostConfig {
  return {
    chromePath: null,
    userDataDir: join(tmpdir(), `ego-chrome-profile-${process.pid}`),
    cdpPort: 1,
    headless: true,
    hostSocket: "/tmp/ego-test.sock",
    dataDir: join(tmpdir(), `ego-chrome-data-${process.pid}`),
    seedFromChrome: false,
    ...overrides,
  };
}

test("resolveChromePath prefers EGO_CHROME_PATH when executable", async () => {
  const dir = join(tmpdir(), `ego-chrome-${process.pid}`);
  await mkdir(dir, { recursive: true });
  const bin = join(dir, "fake-chrome");
  await writeFile(bin, "#!/bin/sh\nexit 0\n");
  await chmod(bin, 0o755);
  try {
    assert.equal(resolveChromePath({ EGO_CHROME_PATH: bin }), bin);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveChromePath prefers explicit over env", async () => {
  const dir = join(tmpdir(), `ego-chrome-explicit-${process.pid}`);
  await mkdir(dir, { recursive: true });
  const envBin = join(dir, "from-env");
  const explicitBin = join(dir, "from-explicit");
  await writeFile(envBin, "#!/bin/sh\nexit 0\n");
  await writeFile(explicitBin, "#!/bin/sh\nexit 0\n");
  await chmod(envBin, 0o755);
  await chmod(explicitBin, 0o755);
  try {
    assert.equal(
      resolveChromePath({ EGO_CHROME_PATH: envBin }, explicitBin),
      explicitBin,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveChromePath returns null when nothing executable", () => {
  // Empty candidates: do not probe host absolute paths (/usr/bin/google-chrome, etc.).
  assert.equal(
    resolveChromePath(
      {
        EGO_CHROME_PATH: "/nonexistent/ego-chrome-xyz",
        PATH: "/nonexistent/empty-path-dir",
      },
      "/also/missing/chrome",
      { candidates: [] },
    ),
    null,
  );
});

test("isCdpUp is false for closed port", async () => {
  assert.equal(await isCdpUp(1), false);
});

test("isCdpUp is true when /json/version responds", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/json/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ Browser: "Test/1.0" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  try {
    assert.equal(await isCdpUp(addr.port), true);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});

test("ensureChrome attaches when CDP already up", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/json/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const userDataDir = join(tmpdir(), `ego-attach-profile-${process.pid}`);
  try {
    const handle = await ensureChrome(
      baseConfig({
        cdpPort: addr.port,
        userDataDir,
        chromePath: "/nonexistent/should-not-matter",
      }),
    );
    assert.equal(handle.cdpPort, addr.port);
    assert.equal(handle.userDataDir, userDataDir);
    assert.equal(typeof handle.kill, "function");
    await handle.kill();
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});

test("ensureChrome throws EGO_BROWSER_UNAVAILABLE when chrome missing", async () => {
  const prevPath = process.env.PATH;
  const prevChrome = process.env.EGO_CHROME_PATH;
  process.env.PATH = "/nonexistent/empty-path-dir";
  process.env.EGO_CHROME_PATH = "/nonexistent/ego-chrome-xyz";
  try {
    await assert.rejects(
      () =>
        ensureChrome(
          baseConfig({
            chromePath: "/nonexistent/ego-chrome-xyz",
            cdpPort: 1,
            headless: true,
          }),
          // Empty candidates: isolate from host /usr/bin/google-chrome etc.
          { candidates: [] },
        ),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(
          (err as Error & { error_code?: string }).error_code,
          "EGO_BROWSER_UNAVAILABLE",
        );
        return true;
      },
    );
  } finally {
    if (prevPath !== undefined) process.env.PATH = prevPath;
    else delete process.env.PATH;
    if (prevChrome !== undefined) process.env.EGO_CHROME_PATH = prevChrome;
    else delete process.env.EGO_CHROME_PATH;
  }
});

test("ensureChrome throws when headed without display", async () => {
  const prevDisplay = process.env.DISPLAY;
  const prevWayland = process.env.WAYLAND_DISPLAY;
  delete process.env.DISPLAY;
  delete process.env.WAYLAND_DISPLAY;
  try {
    await assert.rejects(
      () =>
        ensureChrome(
          baseConfig({
            chromePath: "/usr/bin/true",
            cdpPort: 1,
            headless: false,
          }),
        ),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(
          (err as Error & { error_code?: string }).error_code,
          "EGO_BROWSER_UNAVAILABLE",
        );
        assert.match(err.message, /display|DISPLAY|WAYLAND|headed/i);
        return true;
      },
    );
  } finally {
    if (prevDisplay !== undefined) process.env.DISPLAY = prevDisplay;
    else delete process.env.DISPLAY;
    if (prevWayland !== undefined) process.env.WAYLAND_DISPLAY = prevWayland;
    else delete process.env.WAYLAND_DISPLAY;
  }
});
