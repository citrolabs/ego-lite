import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const dshPluginUrl = new URL(
  "../../../plugins/ego/dsh/src/index.js",
  import.meta.url,
);
const packagedSkillUrl = new URL(
  "../../../plugins/ego/skills/ego-browser/SKILL.md",
  import.meta.url,
);

function forbiddenService(name) {
  throw new Error(`Skill-only DSH plugin must not access ctx.${name}`);
}

function skillOnlyContext() {
  const providers = [];
  const ctx = {
    skills: {
      register() {
        throw new Error("Packaged Skill must use bundled provider precedence");
      },
      registerProvider(create) {
        providers.push(
          create({
            signal: new AbortController().signal,
            invalidate() {},
          }),
        );
        return () => {};
      },
    },
    get tools() {
      return forbiddenService("tools");
    },
    get subprocess() {
      return forbiddenService("subprocess");
    },
    get commands() {
      return forbiddenService("commands");
    },
    get agents() {
      return forbiddenService("agents");
    },
    on() {
      return forbiddenService("on");
    },
    effect() {
      return forbiddenService("effect");
    },
  };
  return { ctx, providers };
}

test("DSH plugin exposes only the Skill service contract", async () => {
  const plugin = await import(dshPluginUrl);

  assert.equal(plugin.name, "ego");
  assert.deepEqual(plugin.inject, ["skills"]);
  assert.equal(
    Object.hasOwn(plugin, "createDshToolDefinitions"),
    false,
    "Skill-only DSH plugin must not expose native REPL tool builders",
  );
});

test("packaged plugin Skill uses heredoc and contains no repl tools", () => {
  const skill = readFileSync(packagedSkillUrl, "utf8");

  assert.match(skill, /ego-browser nodejs <<'EOF'/);
  assert.doesNotMatch(
    skill,
    /\brepl_(?:start|eval|read|status|interrupt|stop)\b/,
  );
});

test("DSH registers only the packaged Skill as a bundled provider", async () => {
  const { apply } = await import(dshPluginUrl);
  const harness = skillOnlyContext();

  apply(harness.ctx);

  assert.equal(harness.providers.length, 1);
  const provider = harness.providers[0];
  assert.equal(provider.name, "ego");

  const expectedPath = fileURLToPath(packagedSkillUrl);
  const resourceBase = {
    kind: "directory",
    path: dirname(expectedPath),
  };
  const invocation = {
    modelInvocable: true,
    userInvocable: true,
  };
  const candidates = await provider.list({ cwd: "/tmp/project" });
  assert.equal(candidates.length, 1);
  const candidate = candidates[0];
  assert.equal(candidate.name, "ego-browser");
  const canonical = readFileSync(
    new URL("../../../skills/ego-browser/SKILL.md", import.meta.url),
    "utf8",
  );
  assert.equal(
    candidate.description,
    canonical.match(/^description: (.+)$/m)[1],
  );
  assert.equal(candidate.provider, "ego");
  assert.equal(candidate.source, "bundled");
  assert.equal(candidate.rank, 600);
  assert.deepEqual(candidate.invocation, invocation);
  assert.deepEqual(candidate.resourceBase, resourceBase);

  const skill = await provider.get(candidate, { cwd: "/tmp/project" });
  assert.equal(skill.name, "ego-browser");
  assert.equal(skill.description, candidate.description);
  assert.equal(skill.provider, "ego");
  assert.equal(skill.source, "bundled");
  assert.match(skill.content, /^# ego-browser\b/);
  assert.equal(
    skill.content,
    canonical.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trimStart(),
  );
  assert.match(skill.content, /ego-browser nodejs <<'EOF'/);
  assert.doesNotMatch(
    skill.content,
    /\brepl_(?:start|eval|read|status|interrupt|stop)\b/,
  );
  assert.equal(skill.path, expectedPath);
  assert.deepEqual(skill.resourceBase, resourceBase);
  assert.deepEqual(skill.invocation, invocation);
});
