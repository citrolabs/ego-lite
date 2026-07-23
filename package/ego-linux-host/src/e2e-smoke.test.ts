/**
 * Opt-in end-to-end smoke (example.com via scripts/smoke.sh).
 *
 * Skipped unless EGO_LINUX_E2E=1 so default `npm test` stays Chrome-free.
 * Full smoke needs Chrome/Chromium + a display (or EGO_HEADLESS=1) and a
 * built ego-browser harness at ../ego-browser/dist/src/run.js.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const enabled = process.env.EGO_LINUX_E2E === "1";

/** package root: dist/e2e-smoke.test.js → ../ */
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const smokeScript = join(packageRoot, "scripts", "smoke.sh");

function runSmoke(
  script: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [script], {
      cwd: packageRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("e2e smoke example.com", { skip: !enabled }, async () => {
  assert.ok(existsSync(smokeScript), `smoke script missing: ${smokeScript}`);
  const result = await runSmoke(smokeScript);
  assert.equal(
    result.code,
    0,
    [
      `smoke.sh exited ${result.code}`,
      result.stdout ? `--- stdout ---\n${result.stdout}` : "",
      result.stderr ? `--- stderr ---\n${result.stderr}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  assert.match(result.stdout, /title/i, "expected smoke JSON with title");
});
