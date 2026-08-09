import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const launcher = fileURLToPath(
  new URL(
    "../../../skills/ego-browser/scripts/launch-gpu-mode.sh",
    import.meta.url,
  ),
);

async function createFixture({ running = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ego-gpu-launcher-"));
  const bin = join(root, "bin");
  const appPath = join(root, "ego lite.app");
  const capturePath = join(root, "open-args.txt");
  const watchdogCapturePath = join(root, "watchdog-args.txt");
  const watchdogPath = join(root, "watchdog.mjs");
  await mkdir(bin);
  await mkdir(appPath);
  await writeExecutable(join(bin, "uname"), "#!/bin/sh\nprintf 'Darwin\\n'\n");
  await writeExecutable(
    join(bin, "pgrep"),
    running ? "#!/bin/sh\nexit 0\n" : "#!/bin/sh\nexit 1\n",
  );
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
    capturePath,
    watchdogCapturePath,
    env: {
      ...process.env,
      EGO_LITE_APP_PATH: appPath,
      EGO_LITE_WATCHDOG_PATH: watchdogPath,
      OPEN_CAPTURE: capturePath,
      WATCHDOG_CAPTURE: watchdogCapturePath,
      PATH: `${bin}:${process.env.PATH}`,
    },
  };
}

async function writeExecutable(path, contents) {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

async function runLauncher(mode, options) {
  const fixture = await createFixture(options);
  const result = spawnSync("sh", [launcher, mode], {
    env: fixture.env,
    encoding: "utf8",
  });
  let args = [];
  let watchdogArgs = [];
  try {
    args = (await readFile(fixture.capturePath, "utf8")).trim().split(/\r?\n/);
  } catch {}
  try {
    watchdogArgs = (await readFile(fixture.watchdogCapturePath, "utf8"))
      .trim()
      .split(/\r?\n/);
  } catch {}
  return { ...fixture, result, args, watchdogArgs };
}

for (const [mode, flag] of [
  ["balanced", "--disable-features=SkiaGraphite"],
  ["software", "--disable-gpu"],
]) {
  test(`${mode} launches ego lite with the expected Chromium flag`, async () => {
    const { appPath, result, args } = await runLauncher(mode);
    assert.equal(result.status, 0);
    assert.deepEqual(args, ["-n", appPath, "--args", flag]);
  });
}

test("low-power launches normally and starts the background watchdog", async () => {
  const { appPath, result, args, watchdogArgs } =
    await runLauncher("low-power");
  assert.equal(result.status, 0);
  assert.deepEqual(args, ["-n", appPath]);
  assert.deepEqual(watchdogArgs, ["stop", "start"]);
});

test("normal launches ego lite without Chromium flags", async () => {
  const { appPath, result, args } = await runLauncher("normal");
  assert.equal(result.status, 0);
  assert.deepEqual(args, [appPath]);
});

test("launcher refuses to change graphics mode while ego lite is running", async () => {
  const { result, args } = await runLauncher("low-power", { running: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already running/);
  assert.deepEqual(args, []);
});

test("launcher rejects unknown modes", async () => {
  const { result, args } = await runLauncher("turbo");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
  assert.deepEqual(args, []);
});
