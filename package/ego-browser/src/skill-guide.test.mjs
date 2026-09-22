import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SKILL_GUIDE_PREFIX,
  SkillTopicError,
  listSkillTopics,
  renderSkillGuide,
  resolveSkillDir,
} from "../dist/src/skill-guide.js";
import { parseSkillArgs } from "../dist/src/skill-cli.js";

const bundledCli = fileURLToPath(
  new URL("../dist/out/skill.js", import.meta.url),
);
const bundledSkill = fileURLToPath(
  new URL("../dist/out/ego-browser/", import.meta.url),
);

function bundledVersion() {
  return renderSkillGuide(bundledSkill).match(/ guide v(\S+) /)[1];
}

function makeGuide({ version = "9.9.9", topics = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ego-skill-guide-"));
  writeFileSync(
    join(dir, "GUIDE.md"),
    `---\nversion: "${version}"\n---\n\n# Guide\n\nMain body.\n`,
  );
  mkdirSync(join(dir, "topics"));
  for (const [name, description] of Object.entries(topics)) {
    writeFileSync(
      join(dir, "topics", `${name}.md`),
      `---\ndescription: ${description}\n---\n\n# ${name}\n\nTopic body.\n`,
    );
  }
  return dir;
}

test("the main guide carries its version, source, topic index, and end marker", () => {
  const dir = makeGuide({
    topics: { zeta: "Read last.", alpha: "Read first." },
  });
  const output = renderSkillGuide(dir);
  const lines = output.trimEnd().split("\n");

  assert.equal(
    lines[0],
    `${SKILL_GUIDE_PREFIX} ego-browser guide v9.9.9 from ${dir}`,
  );
  assert.equal(lines.at(-1), `${SKILL_GUIDE_PREFIX} end of guide v9.9.9`);
  assert.doesNotMatch(output, /^version:/m);
  assert.match(output, /# Guide\n\nMain body\./);
  assert.match(output, /- `alpha`: Read first\.\n- `zeta`: Read last\./);
});

test("a topic prints only its body between the version header and end marker", () => {
  const dir = makeGuide({ topics: { windows: "Read on Windows." } });
  const output = renderSkillGuide(dir, "windows");

  assert.ok(
    output.startsWith(
      `${SKILL_GUIDE_PREFIX} topic windows v9.9.9 from ${dir}\n`,
    ),
  );
  assert.ok(
    output.endsWith(`${SKILL_GUIDE_PREFIX} end of topic windows v9.9.9\n`),
  );
  assert.match(output, /# windows\n\nTopic body\./);
  assert.doesNotMatch(output, /Main body|description:/);
});

test("an unknown topic lists the topics of the installed version", () => {
  const dir = makeGuide({ topics: { windows: "Read on Windows." } });

  for (const topic of ["missing", "../GUIDE"]) {
    assert.throws(
      () => renderSkillGuide(dir, topic),
      (error) =>
        error instanceof SkillTopicError &&
        error.message.includes(`Unknown topic: ${topic}`) &&
        error.message.includes("Topics in this version: windows"),
    );
  }
});

test("a guide without topics renders without an index", () => {
  const dir = makeGuide();
  assert.deepEqual(listSkillTopics(dir), []);
  assert.doesNotMatch(renderSkillGuide(dir), /## Topics/);
});

test("topics must describe when to read them", () => {
  const dir = makeGuide();
  writeFileSync(join(dir, "topics", "bare.md"), "# Bare\n");
  assert.throws(() => listSkillTopics(dir), /requires a description/);
});

test("the guide directory prefers the flag, then the environment, then the bundle", () => {
  assert.equal(
    resolveSkillDir({ flag: "/flag", env: "/env", bundledDir: "/sdk" }),
    "/flag",
  );
  assert.equal(resolveSkillDir({ env: "/env", bundledDir: "/sdk" }), "/env");
  assert.equal(resolveSkillDir({ bundledDir: "/sdk" }), "/sdk");
});

test("CLI arguments accept one topic and the guide directory override", () => {
  assert.deepEqual(parseSkillArgs([]), { help: false });
  assert.deepEqual(parseSkillArgs(["windows", "--skill-dir", "/dir"]), {
    help: false,
    topic: "windows",
    skillDir: "/dir",
  });
  assert.equal(parseSkillArgs(["--skill-dir=/dir"]).skillDir, "/dir");
  assert.throws(() => parseSkillArgs(["a", "b"]), /Unexpected argument: b/);
  assert.throws(() => parseSkillArgs(["--skill-dir"]), /requires a directory/);
  assert.throws(() => parseSkillArgs(["--path"]), /Unknown option: --path/);
});

test("the bundled CLI reads the guide next to itself unless overridden", () => {
  const bundled = execFileSync(process.execPath, [bundledCli], {
    encoding: "utf8",
    env: { ...process.env, EGO_BROWSER_SKILL_DIR: "" },
  });
  assert.equal(
    bundled.split("\n")[0],
    `[ego-browser:skill] ego-browser guide v${bundledVersion()} from ${join(bundledSkill, ".")}`,
  );

  const dir = makeGuide({ version: "0.0.1" });
  const fromEnv = execFileSync(process.execPath, [bundledCli], {
    encoding: "utf8",
    env: { ...process.env, EGO_BROWSER_SKILL_DIR: dir },
  });
  assert.match(fromEnv, new RegExp(`guide v0\\.0\\.1 from ${dir}`));

  const other = makeGuide({ version: "0.0.2" });
  const fromFlag = execFileSync(
    process.execPath,
    [bundledCli, "--skill-dir", other],
    { encoding: "utf8", env: { ...process.env, EGO_BROWSER_SKILL_DIR: dir } },
  );
  assert.match(fromFlag, /guide v0\.0\.2 from /);
});

test("the bundled CLI exits with status 2 for an unknown topic", () => {
  const result = spawnSync(process.execPath, [bundledCli, "missing"], {
    encoding: "utf8",
    env: { ...process.env, EGO_BROWSER_SKILL_DIR: "" },
  });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Unknown topic: missing/);
});
