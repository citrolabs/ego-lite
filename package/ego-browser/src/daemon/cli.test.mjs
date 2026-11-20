import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { main } from "../../dist/src/daemon/cli.js";

test(
  "the daemon-less fallback enforces --timeout-ms",
  { skip: process.platform === "win32" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "ego-run-cli-"));
    // Stands in for `ego-browser nodejs`: reads the program, then never ends.
    const bin = join(dir, "fake-ego-browser");
    writeFileSync(bin, "#!/bin/sh\ncat > /dev/null\nexec sleep 30\n");
    chmodSync(bin, 0o755);
    const env = { ...process.env };
    Object.assign(process.env, {
      EGO_RUN_STATE_DIR: join(dir, "state"), // no daemon there
      EGO_RUN_FALLBACK: "1",
      EGO_BROWSER_BIN: bin,
    });
    const stderr = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
      stderr.push(String(chunk));
      return true;
    };
    const started = Date.now();
    try {
      const code = await main([
        "--session",
        "s",
        "--timeout-ms",
        "1000",
        "-e",
        "await new Promise(() => {})",
      ]);
      assert.equal(code, 1);
      assert.ok(
        Date.now() - started < 5_000,
        "the fallback was ended at its deadline",
      );
      assert.match(stderr.join(""), /running once with ego-browser nodejs/);
      assert.match(
        stderr.join(""),
        /EGO_RUN_DEADLINE: the program ran longer than 1000 ms/,
      );
    } finally {
      process.stderr.write = write;
      for (const key of [
        "EGO_RUN_STATE_DIR",
        "EGO_RUN_FALLBACK",
        "EGO_BROWSER_BIN",
      ]) {
        if (key in env) process.env[key] = env[key];
        else delete process.env[key];
      }
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
