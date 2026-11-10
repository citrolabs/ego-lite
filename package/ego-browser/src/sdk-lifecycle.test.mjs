import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("disposeEgoSdk releases native callbacks and rejects pending CDP work", () => {
  const sdkUrl = new URL("../dist/src/index.js", import.meta.url).href;
  const runtimeUrl = new URL("../dist/src/browser-runtime.js", import.meta.url)
    .href;
  const downloadsUrl = new URL(
    "../dist/src/driver/downloads.js",
    import.meta.url,
  ).href;
  const script = `
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    globalThis.ego = {
      respond: true,
      sendCDPMessage(payload) {
        const request = JSON.parse(payload);
        if (!this.respond) return;
        queueMicrotask(() => this.onCDPMessage(JSON.stringify({
          id: request.id,
          result: { targetInfos: [] },
        })));
      },
    };
    const sdk = await import(${JSON.stringify(sdkUrl)});
    const runtime = await import(${JSON.stringify(runtimeUrl)});
    const downloads = await import(${JSON.stringify(downloadsUrl)});
    await runtime.browserCdp("Target.getTargets", {}, undefined, 1_000);
    if (typeof ego.onCDPMessage !== "function") {
      throw new Error("CDP callbacks were not installed");
    }
    ego.respond = false;
    const pending = runtime.browserCdp("Target.getTargets", {}, undefined, 10_000);
    let downloadPath;
    const downloadWait = downloads.preparePageDownload({
      async cdp(method, params) {
        if (params.downloadPath) downloadPath = params.downloadPath;
        return {};
      },
      subscribePageEvents() { return () => {}; },
    }, "target-download", { timeoutMs: 10_000 });
    void downloadWait.event.catch(() => {});
    await downloadWait.ready("session-download");
    if (!existsSync(downloadPath)) throw new Error("download directory was not created");
    const waiterMarker = join(downloadPath, "waiters", String(process.pid));
    if (!existsSync(waiterMarker)) throw new Error("download waiter marker was not created");
    await sdk.disposeEgoSdk();
    if (ego.onCDPMessage !== undefined || ego.onSendCDPMessageError !== undefined) {
      throw new Error("disposeEgoSdk left native callbacks installed");
    }
    if (existsSync(waiterMarker)) {
      throw new Error("disposeEgoSdk left its download waiter marker behind");
    }
    await pending.then(
      () => { throw new Error("pending CDP work unexpectedly resolved"); },
      (error) => {
        if (!/disposed/.test(error.message)) throw error;
      },
    );
    process.stderr.write("sdk lifecycle ok");
  `;
  const stateDir = mkdtempSync(join(tmpdir(), "ego-sdk-lifecycle-state-"));
  try {
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      {
        encoding: "utf8",
        env: { ...process.env, EGO_BROWSER_STATE_DIR: stateDir },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /sdk lifecycle ok/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("the SDK follows a host's program lifecycle events and drains each program's output at its end", () => {
  const sdkUrl = new URL("../dist/src/index.js", import.meta.url).href;
  const script = `
    const chunks = [];
    let phase = "before";
    process.stdout.write = (chunk) => { chunks.push([phase, String(chunk)]); return true; };
    globalThis.ego = { sendCDPMessage() {} };
    await import(${JSON.stringify(sdkUrl)});
    // A second copy of the SDK (bundled plus --sdk-path) must not double the listeners.
    await import(${JSON.stringify(sdkUrl + "?second-copy")});
    const end = async (id, thrown) => {
      for (const listener of process.listeners("ego:script-end")) await listener({ id, thrown });
    };
    process.emit("ego:script-start", { id: 1 });
    phase = "in-1";
    console.log("in program 1");
    phase = "ending-1";
    await end(1, false);
    phase = "between";
    console.log("stray output between programs");
    process.emit("ego:script-start", { id: 2 });
    phase = "in-2";
    console.log("in program 2");
    phase = "ending-2";
    await end(2, true);
    process.stderr.write(JSON.stringify({
      chunks,
      starts: process.listenerCount("ego:script-start"),
      ends: process.listenerCount("ego:script-end"),
    }));
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stderr.trim().split("\n").pop());
  assert.equal(report.starts, 1, "one start listener for two SDK copies");
  assert.equal(report.ends, 1, "one end listener for two SDK copies");
  const text = (phase) =>
    report.chunks
      .filter(([p]) => p === phase)
      .map(([, c]) => c)
      .join("");
  assert.equal(
    text("in-1"),
    "",
    "a program's console output is held until its end",
  );
  assert.match(text("ending-1"), /in program 1/);
  assert.doesNotMatch(report.chunks.map(([, c]) => c).join(""), /stray output/);
  assert.match(text("ending-2"), /in program 2/);
});

test("the embedded SDK explains that browser globals belong inside Page.evaluate", () => {
  const sdkUrl = new URL("../dist/src/index.js", import.meta.url).href;
  const script = `
    globalThis.ego = {};
    await import(${JSON.stringify(sdkUrl)});
    const checks = [
      ["document", () => document.body],
      ["location", () => location.href],
      ["scrollY", () => scrollY],
    ];
    for (const [name, read] of checks) {
      try {
        read();
        throw new Error(name + " guard did not run");
      } catch (error) {
        if (!error.message.includes(name + " is not defined")) throw error;
        if (!/heredoc runs in Node\.js, not in the Page/i.test(error.message)) throw error;
        if (!/page\\.evaluate\\(\\)/i.test(error.message)) throw error;
      }
    }
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
});
