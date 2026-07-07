import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { e2eCases } from "./cases/index.mjs";
import { egoSource } from "./ego-source.mjs";
import { closeFixtureServer, startFixtureServer } from "./fixture.mjs";
import { runCommand } from "./run-command.mjs";

const runnerDir = dirname(fileURLToPath(import.meta.url));
const packageDir = join(runnerDir, "..", "..");
const egoBrowserSdkPath = join(packageDir, "dist", "out", "index.js");
const egoBrowserArgs = ["nodejs", "--sdk-path", egoBrowserSdkPath];
const verboseCaseOutput =
  process.env.EGO_BROWSER_REAL_E2E_VERBOSE_CASE_OUTPUT === "1" ||
  process.env.EGO_BROWSER_REAL_E2E_VERBOSE_CASE_OUTPUT === "true";

export async function runRealBrowserE2e() {
  const keepTaskSpace =
    process.env.EGO_BROWSER_REAL_E2E_KEEP === "1" ||
    process.env.EGO_BROWSER_REAL_E2E_KEEP === "true";
  const onlyCases = new Set(
    (process.env.EGO_BROWSER_REAL_E2E_ONLY || "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
  const availableCaseNames = [
    "nodejs bridge smoke",
    "nodejs repl cell smoke",
    ...e2eCases.map((testCase) => testCase.name),
  ];
  const unknownOnlyCases = [...onlyCases].filter(
    (name) => !availableCaseNames.includes(name),
  );
  if (unknownOnlyCases.length > 0) {
    console.error(
      `Unknown EGO_BROWSER_REAL_E2E_ONLY case(s): ${unknownOnlyCases.join(", ")}`,
    );
    console.error(`Available cases: ${availableCaseNames.join(", ")}`);
    process.exitCode = 2;
    return;
  }

  let server;
  let tempDir;
  let passed = false;
  const context = {};
  const caseResults = [];

  function recordResult(name, status, durationMs, assertionCount, message) {
    caseResults.push({ name, status, durationMs, assertionCount, message });
  }

  async function runNodeBridgeSmoke(timeoutMs = 15000) {
    const name = "nodejs bridge smoke";
    console.log(`-- ${name}`);
    const startedAt = Date.now();
    const marker = `EGO_NODEJS_BRIDGE_SMOKE_${Date.now()}`;
    // The output channel is the overridden console.log. typeof console.log is always
    // "function" (it is a Node built-in), so it cannot prove the SDK wired its sink.
    // Two real signals cover it instead: the marker round-trip below proves console.log
    // output reaches stdout, and helperCount > 0 proves installEgoSdk ran (it sets the
    // console.log override and ego.helpers in the same call), so the override ran too.
    const source = `
      console.log(${JSON.stringify(marker)});
      console.log(JSON.stringify({
        egoType: typeof globalThis.ego,
        hasSendCDPMessage: typeof globalThis.ego?.sendCDPMessage,
        processVersion: process.version,
        helperCount: Object.keys(globalThis.ego?.helpers || {}).length
      }));
    `;
    try {
      const { stdout, stderr } = await runCommand(
        "ego-browser",
        egoBrowserArgs,
        {
          cwd: packageDir,
          egoBrowserSdkPath,
          echo: verboseCaseOutput,
          input: source,
          timeoutMs,
        },
      );
      const probe = parseNodeBridgeSmoke(`${stdout}\n${stderr}`, marker);
      if (
        probe.egoType !== "object" ||
        probe.hasSendCDPMessage !== "function" ||
        typeof probe.processVersion !== "string" ||
        probe.helperCount <= 0
      ) {
        throw new Error(
          `nodejs bridge smoke returned invalid runtime data: ${JSON.stringify(probe)}`,
        );
      }
      const durationMs = Date.now() - startedAt;
      recordResult(name, "pass", durationMs, 4);
      console.log(
        `-- ${name} passed (${formatDuration(durationMs)}, 4 assertions)`,
      );
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error?.message || String(error);
      recordResult(name, "fail", durationMs, 0, message);
      console.error(
        `[FAIL] ${name} (${formatDuration(durationMs)}): ${message}`,
      );
    }
  }

  async function maybeRunNodeBridgeSmoke() {
    await runNodeBridgeSmoke();
  }

  async function runNodeReplCellSmoke(timeoutMs = 15000) {
    const name = "nodejs repl cell smoke";
    console.log(`-- ${name}`);
    const startedAt = Date.now();
    const marker = `EGO_NODEJS_REPL_CELL_SMOKE_${Date.now()}`;
    const script = [
      "set timeout 15",
      `spawn ego-browser nodejs --sdk-path ${tclBrace(egoBrowserSdkPath)}`,
      'expect "repl> "',
      tclSend(".cell\r"),
      tclSend(`console.log(${JSON.stringify(marker)})\r`),
      tclSend("console.log(typeof snapshot)\r"),
      tclSend("21 + 21\r"),
      tclSend(".end\r"),
      `expect ${tclBrace(marker)}`,
      'expect "function"',
      'expect "42"',
      'expect "repl> "',
      tclSend(".exit\r"),
      "expect eof",
    ].join("\n");
    try {
      await runCommand("expect", ["-c", script], {
        cwd: packageDir,
        egoBrowserSdkPath,
        echo: verboseCaseOutput,
        timeoutMs,
      });
      const durationMs = Date.now() - startedAt;
      recordResult(name, "pass", durationMs, 3);
      console.log(
        `-- ${name} passed (${formatDuration(durationMs)}, 3 assertions)`,
      );
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error?.message || String(error);
      recordResult(name, "fail", durationMs, 0, message);
      console.error(
        `[FAIL] ${name} (${formatDuration(durationMs)}): ${message}`,
      );
    }
  }

  async function maybeRunNodeReplCellSmoke() {
    await runNodeReplCellSmoke();
  }

  async function runEgoCase(name, body, timeoutMs = 45000, options = {}) {
    const visible = options.visible !== false;
    if (visible) console.log(`-- ${name}`);
    const source = egoSource(body, {
      ...context,
      keepTaskSpace: keepTaskSpace && passed,
    });
    const startedAt = Date.now();
    await rm(caseResultPath(tempDir), { force: true });
    try {
      const { stdout } = await runCommand("ego-browser", egoBrowserArgs, {
        cwd: packageDir,
        egoBrowserSdkPath,
        echo: verboseCaseOutput,
        input: source,
        timeoutMs,
      });
      const durationMs = Date.now() - startedAt;
      const caseResult = await readCaseResult(tempDir, stdout);
      if (!caseResult.ok) {
        const error = new Error(caseResult.error);
        error.stdout = stdout;
        throw error;
      }
      const assertions = caseResult.assertions;
      recordResult(name, "pass", durationMs, assertions);
      if (visible) {
        console.log(
          `-- ${name} passed (${formatDuration(durationMs)}, ${assertions} assertions)`,
        );
      }
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const caseResult = await readCaseResult(tempDir, error?.stdout);
      const message = caseResult.error || error?.message || String(error);
      const assertions = caseResult.assertions;
      recordResult(name, "fail", durationMs, assertions, message);
      if (visible) {
        console.error(
          `[FAIL] ${name} (${formatDuration(durationMs)}): ${message}`,
        );
      } else {
        console.error(`[${name}] ${message}`);
      }
    }
  }

  async function maybeRunEgoCase(name, body, timeoutMs = 45000) {
    if (onlyCases.size > 0 && !onlyCases.has(name)) {
      console.log(`-- ${name} (skipped)`);
      recordResult(name, "skip", 0, 0);
      return;
    }
    await runEgoCase(name, body, timeoutMs);
  }

  async function cleanupTaskSpace() {
    const beforeFails = caseResults.filter((r) => r.status === "fail").length;
    await runEgoCase(
      "cleanup",
      `
        try {
          const result = await completeTaskSpace(taskName, { keep: keepTaskSpace });
          console.log(JSON.stringify({ cleanup: result }));
        } catch (error) {
          if (!String(error?.message || error).includes("task space not found")) {
            throw error;
          }
        }
      `,
      20000,
      { visible: false },
    );
    // Remove cleanup result and any failures it produced
    const cleanupResults = caseResults.filter((r) => r.name === "cleanup");
    for (const r of cleanupResults) {
      caseResults.splice(caseResults.indexOf(r), 1);
    }
  }

  const totalStartedAt = Date.now();

  try {
    console.log("== build ==");
    await runCommand("npm", ["run", "build"], { cwd: packageDir });
    await stat(egoBrowserSdkPath);

    tempDir = await mkdtemp(join(tmpdir(), "ego-browser-real-e2e-"));
    const artifactDir = join(tempDir, "artifacts");
    const uploadPath = join(tempDir, "fixture-upload.txt");
    const uploadPathTwo = join(tempDir, "fixture-upload-two.txt");
    const explicitScreenshotPath = join(artifactDir, "explicit-shot.png");
    const environmentScreenshotPath = join(artifactDir, "environment-shot.png");
    const metadataPath = join(tempDir, "metadata.json");
    const taskName = `ego-lite real browser e2e ${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;

    Object.assign(context, {
      artifactDir,
      explicitScreenshotPath,
      environmentScreenshotPath,
      metadataPath,
      taskName,
      tempDir,
      uploadPath,
      uploadPathTwo,
    });

    await mkdir(artifactDir, { recursive: true });
    await writeFile(uploadPath, "ego-browser upload fixture\n", "utf8");
    await writeFile(uploadPathTwo, "second upload fixture\n", "utf8");

    const fixture = await startFixtureServer(taskName);
    server = fixture.server;
    Object.assign(context, { baseUrl: fixture.baseUrl });
    await initializeE2eEnvironment(context, tempDir);

    console.log("== E2E (real browser helpers) ==");
    console.log(`fixture: ${context.baseUrl}`);
    console.log(`task: ${taskName}`);
    console.log(`sdk: ${egoBrowserSdkPath}`);

    await maybeRunNodeBridgeSmoke();
    await maybeRunNodeReplCellSmoke();
    if (
      caseResults.some(
        (r) =>
          (r.name === "nodejs bridge smoke" ||
            r.name === "nodejs repl cell smoke") &&
          r.status === "fail",
      )
    ) {
      context.skipCleanup = true;
      printSummary(caseResults, Date.now() - totalStartedAt);
      process.exitCode = 1;
      return;
    }

    for (const testCase of e2eCases) {
      await maybeRunEgoCase(testCase.name, testCase.body());
    }

    passed = caseResults.every((r) => r.status !== "fail");
    printSummary(caseResults, Date.now() - totalStartedAt);

    if (!passed) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = error?.code === "ENOENT" ? 127 : 1;
  } finally {
    if (context.taskName && !context.skipCleanup) {
      await cleanupTaskSpace().catch((error) => {
        console.error(`[cleanup] ${error?.message || error}`);
      });
    }
    if (server) {
      await closeFixtureServer(server);
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

async function initializeE2eEnvironment(context, tempDir) {
  const {
    artifactDir,
    baseUrl,
    metadataPath,
    taskName,
    uploadPath,
    uploadPathTwo,
  } = context;
  const healthUrl = `${baseUrl}/healthz`;
  const response = await fetch(healthUrl, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(`fixture health check failed: HTTP ${response.status}`);
  }
  const health = await response.json();
  if (health.taskName !== taskName || health.ok !== true) {
    throw new Error(
      `fixture health payload mismatch: ${JSON.stringify(health)}`,
    );
  }
  await stat(uploadPath);
  await stat(uploadPathTwo);
  await stat(artifactDir);
  await writeFile(
    metadataPath,
    JSON.stringify(
      {
        baseUrl,
        taskName,
        tempDir,
        artifactDir,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );
}

function parseNodeBridgeSmoke(stdout, marker) {
  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const markerIndex = lines.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(
      "nodejs bridge did not print the console.log smoke marker; ego-browser nodejs may have exited without executing stdin",
    );
  }
  const payload = lines[markerIndex + 1];
  if (!payload) {
    throw new Error("nodejs bridge smoke did not print runtime probe data");
  }
  try {
    return JSON.parse(payload);
  } catch (error) {
    throw new Error(
      `nodejs bridge smoke printed invalid runtime probe data: ${payload}`,
    );
  }
}

function tclBrace(value) {
  return `{${String(value).replace(/[\\{}]/g, "\\$&")}}`;
}

function tclSend(value) {
  return `send ${JSON.stringify(value)}`;
}

function caseResultPath(tempDir) {
  return join(tempDir, "case-result.json");
}

async function readCaseAssertionCount(tempDir, stdout) {
  return (await readCaseResult(tempDir, stdout)).assertions;
}

async function readCaseResult(tempDir, stdout) {
  const resultPath = caseResultPath(tempDir);
  try {
    const raw = await readFile(resultPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      ok: parsed.ok === true,
      assertions: typeof parsed.assertions === "number" ? parsed.assertions : 0,
      error: parsed.error || "case-result.json reported failure",
    };
  } catch (error) {
    return {
      ok: false,
      assertions: extractAssertionCount(stdout),
      error: `case-result.json was not written or readable; ego-browser nodejs may have exited without executing stdin (${error?.message || error})`,
    };
  }
}

function extractAssertionCount(stdout) {
  if (!stdout) return 0;
  // Find the last JSON line with "assertions" from console.log output
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("{") && line.includes("assertions")) {
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.assertions === "number") return parsed.assertions;
      } catch {
        // not valid JSON, keep looking
      }
    }
  }
  return 0;
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function printSummary(results, totalMs) {
  const total = results.length;
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;
  const executed = passed + failed;
  const totalAssertions = results.reduce((sum, r) => sum + r.assertionCount, 0);

  console.log("");
  console.log("== E2E Summary ==");
  console.log(
    `  Passed:   ${passed}/${executed}${executed > 0 ? `  (${Math.round((passed / executed) * 100)}%)` : ""}`,
  );
  if (failed > 0) console.log(`  Failed:   ${failed}/${total}`);
  if (skipped > 0) console.log(`  Skipped:  ${skipped}/${total}`);
  console.log(`  Total time: ${formatDuration(totalMs)}`);
  console.log(`  Assertions: ${totalAssertions}`);
  console.log("");

  // Per-case detail table
  const nameWidth = Math.max(...results.map((r) => r.name.length), 4);
  console.log("  Cases:");
  for (const result of results) {
    const statusLabel =
      result.status === "pass"
        ? "PASS"
        : result.status === "fail"
          ? "FAIL"
          : "SKIP";
    const timing =
      result.status === "skip"
        ? "       "
        : formatDuration(result.durationMs).padStart(7);
    const assertions =
      result.status === "skip"
        ? "  -"
        : `  ${result.assertionCount} assertions`;
    console.log(
      `    ${result.name.padEnd(nameWidth)}  ${timing}  ${assertions}  ${statusLabel}`,
    );
  }

  // Failure details
  const failedResults = results.filter((r) => r.status === "fail");
  if (failedResults.length > 0) {
    console.log("");
    console.log("  Failures:");
    for (const result of failedResults) {
      console.log(`    - ${result.name}: ${result.message}`);
    }
  }

  console.log("");
}
