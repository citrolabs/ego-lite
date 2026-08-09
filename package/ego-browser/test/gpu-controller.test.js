import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  GRAPHITE_DISABLED_EXPERIMENT,
  applyModeToLocalState,
  detectMode,
  launchArguments,
  unsupportedModesForAppVersion,
} from "../../../skills/ego-browser/gpu-controller/native-host/mode-state.mjs";
import { acquireRestartLock } from "../../../skills/ego-browser/gpu-controller/native-host/restart-lock.mjs";

const manifestPath = fileURLToPath(
  new URL(
    "../../../skills/ego-browser/gpu-controller/extension/manifest.json",
    import.meta.url,
  ),
);
const installerPath = fileURLToPath(
  new URL(
    "../../../skills/ego-browser/gpu-controller/install.sh",
    import.meta.url,
  ),
);
const applyScriptPath = fileURLToPath(
  new URL(
    "../../../skills/ego-browser/gpu-controller/native-host/apply-and-restart.mjs",
    import.meta.url,
  ),
);
const uninstallPath = fileURLToPath(
  new URL(
    "../../../skills/ego-browser/gpu-controller/uninstall.sh",
    import.meta.url,
  ),
);
const hostScriptPath = fileURLToPath(
  new URL(
    "../../../skills/ego-browser/gpu-controller/native-host/host.mjs",
    import.meta.url,
  ),
);
const watchdogScriptPath = fileURLToPath(
  new URL(
    "../../../skills/ego-browser/gpu-controller/native-host/low-power-watchdog.mjs",
    import.meta.url,
  ),
);

test("balanced mode persists the tested Graphite disabled experiment", () => {
  const current = {
    browser: {
      enabled_labs_experiments: ["existing-feature@1", "skia-graphite@2"],
    },
    unrelated: { value: true },
  };
  const next = applyModeToLocalState(current, "balanced");

  assert.deepEqual(next.browser.enabled_labs_experiments, [
    "existing-feature@1",
    GRAPHITE_DISABLED_EXPERIMENT,
  ]);
  assert.equal(next.hardware_acceleration_mode.enabled, true);
  assert.deepEqual(next.unrelated, { value: true });
  assert.notEqual(next, current);
});

test("software mode disables hardware acceleration and removes Graphite overrides", () => {
  const next = applyModeToLocalState(
    {
      browser: {
        enabled_labs_experiments: [
          GRAPHITE_DISABLED_EXPERIMENT,
          "existing-feature@1",
        ],
      },
    },
    "software",
  );

  assert.equal(next.hardware_acceleration_mode.enabled, false);
  assert.deepEqual(next.browser.enabled_labs_experiments, [
    "existing-feature@1",
  ]);
  assert.equal(detectMode(next), "software");
});

test("normal and low-power use the expected persistent and launch settings", () => {
  const normal = applyModeToLocalState({}, "normal");
  const lowPower = applyModeToLocalState({}, "low-power");

  assert.equal(detectMode(normal), "normal");
  assert.equal(lowPower.hardware_acceleration_mode.enabled, true);
  assert.deepEqual(launchArguments("normal"), []);
  assert.deepEqual(launchArguments("low-power"), []);
});

test("software mode is blocked on the ego lite version that crashes", () => {
  assert.deepEqual(unsupportedModesForAppVersion("0.4.6.12"), ["software"]);
  assert.deepEqual(unsupportedModesForAppVersion("0.4.6.13"), []);
});

test("saved low-power mode takes precedence over Local State inference", () => {
  assert.equal(
    detectMode(
      {
        browser: {
          enabled_labs_experiments: [GRAPHITE_DISABLED_EXPERIMENT],
        },
      },
      "low-power",
    ),
    "low-power",
  );
});

test("stale saved modes do not override persistent Chromium state", () => {
  assert.equal(detectMode({}, "software"), "normal");
  assert.equal(
    detectMode({ hardware_acceleration_mode: { enabled: false } }, "normal"),
    "software",
  );
});

test("manifest key produces the native host allowlisted extension id", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const digest = createHash("sha256")
    .update(Buffer.from(manifest.key, "base64"))
    .digest("hex")
    .slice(0, 32);
  const extensionId = digest.replace(/[0-9a-f]/g, (digit) =>
    String.fromCharCode(97 + Number.parseInt(digit, 16)),
  );

  assert.equal(extensionId, "iemmjhekmkccaghebaammoflapofhaik");
});

test("native host rejects messages larger than its protocol limit", async () => {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(64 * 1024 + 1);
  const response = await runNativeHost(header);

  assert.equal(response.ok, false);
  assert.match(response.error, /exceeds 65536 bytes/);
});

test("restart lock allows only one concurrent scheduler", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-gpu-controller-lock-"));
  const lockPath = join(root, "gpu_mode_restart.lock");
  const results = await Promise.all([
    acquireRestartLock(lockPath),
    acquireRestartLock(lockPath),
  ]);

  assert.deepEqual(results.sort(), [false, true]);
});

test("low-power watchdog hides ego lite after it loses focus", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-gpu-watchdog-"));
  const osascript = join(root, "osascript");
  const pidPath = join(root, "watchdog.pid");
  const errorPath = join(root, "watchdog-error.log");
  const startLockPath = join(root, "watchdog-start.lock");
  const restartLockPath = join(root, "restart.lock");
  const eventsPath = join(root, "events.txt");
  await writeExecutable(
    osascript,
    `#!/bin/sh
case "$*" in
  *'return "running|"'*) printf 'running|true|false\\n' ;;
  *) printf 'hide\\n' >> "$WATCHDOG_EVENTS" ;;
esac
`,
  );
  const env = {
    ...process.env,
    EGO_LITE_OSASCRIPT_PATH: osascript,
    EGO_LITE_WATCHDOG_PID_PATH: pidPath,
    EGO_LITE_WATCHDOG_ERROR_PATH: errorPath,
    EGO_LITE_WATCHDOG_START_LOCK_PATH: startLockPath,
    EGO_LITE_RESTART_LOCK_PATH: restartLockPath,
    EGO_LITE_WATCHDOG_POLL_MS: "20",
    EGO_LITE_WATCHDOG_UNFOCUSED_MS: "30",
    WATCHDOG_EVENTS: eventsPath,
  };

  try {
    const start = spawnSync(process.execPath, [watchdogScriptPath, "start"], {
      env,
      encoding: "utf8",
    });
    assert.equal(start.status, 0, start.stderr);
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        await access(eventsPath);
        break;
      } catch {
        await delay(40);
      }
    }
    assert.match(await readFile(eventsPath, "utf8"), /hide/);
    const status = spawnSync(process.execPath, [watchdogScriptPath, "status"], {
      env,
      encoding: "utf8",
    });
    assert.equal(status.stdout.trim(), "running");
  } finally {
    spawnSync(process.execPath, [watchdogScriptPath, "stop"], { env });
  }
});

test("installer writes the native host to the configured compatibility directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-gpu-controller-install-"));
  const bin = join(root, "bin");
  const userData = join(root, "user-data");
  const nativeHosts = join(root, "native-hosts");
  await mkdir(bin);
  await writeExecutable(join(bin, "open"), "#!/bin/sh\nexit 0\n");

  const result = spawnSync("sh", [installerPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      EGO_LITE_NATIVE_MESSAGING_DIR: nativeHosts,
      EGO_LITE_USER_DATA_DIR: userData,
      PATH: `${bin}:${process.env.PATH}`,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(
    await readFile(
      join(nativeHosts, "com.citrolabs.ego.gpu_mode.json"),
      "utf8",
    ),
  );
  assert.equal(manifest.name, "com.citrolabs.ego.gpu_mode");
  assert.deepEqual(manifest.allowed_origins, [
    "chrome-extension://iemmjhekmkccaghebaammoflapofhaik/",
  ]);
  assert.match(manifest.path, /GpuModeController\/native-host\/host$/);
});

test("uninstaller removes controller files after normal mode is restored", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-gpu-controller-uninstall-"));
  const userData = join(root, "user-data");
  const nativeHosts = join(root, "native-hosts");
  const installDir = join(userData, "GpuModeController");
  const manifestPath = join(nativeHosts, "com.citrolabs.ego.gpu_mode.json");
  await mkdir(installDir, { recursive: true });
  await mkdir(nativeHosts);
  await writeFile(
    join(userData, "Local State"),
    JSON.stringify({ hardware_acceleration_mode: { enabled: true } }),
  );
  await writeFile(join(userData, "gpu_mode.json"), '{"mode":"normal"}');
  await writeFile(join(userData, "gpu_mode_error.log"), "old error");
  await writeFile(join(userData, "gpu_mode_restart.lock"), "old lock");
  await writeFile(join(installDir, "installed.txt"), "fixture");
  await writeFile(manifestPath, "{}");

  const result = spawnSync("sh", [uninstallPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      EGO_LITE_NATIVE_MESSAGING_DIR: nativeHosts,
      EGO_LITE_USER_DATA_DIR: userData,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  await assertMissing(manifestPath);
  await assertMissing(installDir);
  await assertMissing(join(userData, "gpu_mode.json"));
  await assertMissing(join(userData, "gpu_mode_error.log"));
  await assertMissing(join(userData, "gpu_mode_restart.lock"));
});

test("uninstaller refuses to remove a non-normal persistent mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-gpu-controller-uninstall-"));
  const userData = join(root, "user-data");
  const nativeHosts = join(root, "native-hosts");
  const manifestPath = join(nativeHosts, "com.citrolabs.ego.gpu_mode.json");
  await mkdir(userData);
  await mkdir(nativeHosts);
  await writeFile(
    join(userData, "Local State"),
    JSON.stringify({
      browser: { enabled_labs_experiments: [GRAPHITE_DISABLED_EXPERIMENT] },
    }),
  );
  await writeFile(manifestPath, "{}");

  const result = spawnSync("sh", [uninstallPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      EGO_LITE_NATIVE_MESSAGING_DIR: nativeHosts,
      EGO_LITE_USER_DATA_DIR: userData,
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /switch ego GPU Mode to Normal/);
  await access(manifestPath);
});

test("apply script updates Local State atomically and launches balanced mode", async () => {
  const fixture = await createApplyFixture({
    localState: {
      browser: {
        enabled_labs_experiments: ["existing-feature@1"],
      },
      unrelated: { value: true },
    },
  });
  const result = runApplyScript(fixture, "balanced");

  assert.equal(result.status, 0, result.stderr);
  const localState = JSON.parse(
    await readFile(join(fixture.userData, "Local State"), "utf8"),
  );
  assert.deepEqual(localState.browser.enabled_labs_experiments, [
    "existing-feature@1",
    GRAPHITE_DISABLED_EXPERIMENT,
  ]);
  assert.equal(localState.hardware_acceleration_mode.enabled, true);
  assert.deepEqual(localState.unrelated, { value: true });
  assert.deepEqual(
    (await readFile(fixture.openCapture, "utf8")).trim().split(/\r?\n/),
    ["-na", fixture.appPath],
  );
  assert.equal(
    (await readFile(fixture.watchdogCapture, "utf8")).trim(),
    "stop",
  );
});

test("apply script starts the background watchdog for low-power mode", async () => {
  const fixture = await createApplyFixture({ localState: {} });
  const result = runApplyScript(fixture, "low-power");

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    (await readFile(fixture.openCapture, "utf8")).trim().split(/\r?\n/),
    ["-na", fixture.appPath],
  );
  assert.deepEqual(
    (await readFile(fixture.watchdogCapture, "utf8")).trim().split(/\r?\n/),
    ["stop", "start"],
  );
});

test("apply script preserves malformed Local State and still reopens ego lite", async () => {
  const fixture = await createApplyFixture({ localState: "{not-json" });
  const result = runApplyScript(fixture, "normal");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    await readFile(join(fixture.userData, "Local State"), "utf8"),
    "{not-json",
  );
  assert.match(
    await readFile(join(fixture.userData, "gpu_mode_error.log"), "utf8"),
    /SyntaxError/,
  );
  assert.deepEqual(
    (await readFile(fixture.openCapture, "utf8")).trim().split(/\r?\n/),
    ["-na", fixture.appPath],
  );
});

async function createApplyFixture({ localState }) {
  const root = await mkdtemp(join(tmpdir(), "ego-gpu-controller-apply-"));
  const bin = join(root, "bin");
  const userData = join(root, "user-data");
  const openCapture = join(root, "open-args.txt");
  const watchdogCapture = join(root, "watchdog-args.txt");
  const watchdogPath = join(root, "watchdog.mjs");
  const appPath = join(root, "ego lite.app");
  await mkdir(bin);
  await mkdir(userData);
  await mkdir(appPath);
  await writeFile(
    join(userData, "Local State"),
    typeof localState === "string" ? localState : JSON.stringify(localState),
  );
  await writeExecutable(join(bin, "osascript"), "#!/bin/sh\nexit 0\n");
  await writeExecutable(join(bin, "pgrep"), "#!/bin/sh\nexit 1\n");
  await writeExecutable(join(bin, "pkill"), "#!/bin/sh\nexit 0\n");
  await writeExecutable(
    join(bin, "open"),
    '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$OPEN_CAPTURE"\n',
  );
  await writeFile(
    watchdogPath,
    'import { appendFileSync } from "node:fs"; appendFileSync(process.env.WATCHDOG_CAPTURE, `${process.argv[2]}\\n`);\n',
  );
  return {
    appPath,
    bin,
    openCapture,
    root,
    userData,
    watchdogCapture,
    watchdogPath,
  };
}

function runApplyScript(fixture, mode) {
  return spawnSync(process.execPath, [applyScriptPath, mode], {
    encoding: "utf8",
    env: {
      ...process.env,
      EGO_LITE_APP_PATH: fixture.appPath,
      EGO_LITE_OPEN_PATH: join(fixture.bin, "open"),
      EGO_LITE_OSASCRIPT_PATH: join(fixture.bin, "osascript"),
      EGO_LITE_PGREP_PATH: join(fixture.bin, "pgrep"),
      EGO_LITE_PKILL_PATH: join(fixture.bin, "pkill"),
      EGO_LITE_USER_DATA_DIR: fixture.userData,
      EGO_LITE_APP_VERSION: "test",
      EGO_LITE_WATCHDOG_PATH: fixture.watchdogPath,
      OPEN_CAPTURE: fixture.openCapture,
      WATCHDOG_CAPTURE: fixture.watchdogCapture,
    },
  });
}

function runNativeHost(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hostScriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = Buffer.alloc(0);
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      output = Buffer.concat([output, chunk]);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", () => {
      if (output.length < 4) {
        reject(new Error(stderr || "native host returned no response"));
        return;
      }
      const length = output.readUInt32LE(0);
      resolve(JSON.parse(output.subarray(4, 4 + length).toString("utf8")));
    });
    child.stdin.end(input);
  });
}

async function assertMissing(path) {
  await assert.rejects(access(path), { code: "ENOENT" });
}

async function writeExecutable(path, contents) {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}
