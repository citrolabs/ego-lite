import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_URL = new URL("../../skills/ego-browser/SKILL.md", import.meta.url);
const SKILL_PATH = fileURLToPath(SKILL_URL);
const SKILL_DIRECTORY = dirname(SKILL_PATH);
const INVOCATION = Object.freeze({
  modelInvocable: true,
  userInvocable: true,
});

function scalar(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readPackagedSkill() {
  const source = readFileSync(SKILL_URL, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
  if (!match) throw new Error(`Invalid Skill frontmatter: ${SKILL_PATH}`);

  const frontmatter = match[1];
  const field = (name) => {
    const value = new RegExp(`^${name}:\\s*(.+)$`, "m").exec(frontmatter)?.[1];
    if (!value) throw new Error(`Skill frontmatter requires ${name}`);
    return scalar(value);
  };

  return Object.freeze({
    name: field("name"),
    description: field("description"),
    content: match[2].trimStart(),
  });
}

const PACKAGED_SKILL = readPackagedSkill();
const RESOURCE_BASE = Object.freeze({
  kind: "directory",
  path: SKILL_DIRECTORY,
});
const SKILL_CANDIDATE = Object.freeze({
  name: PACKAGED_SKILL.name,
  description: PACKAGED_SKILL.description,
  invocation: INVOCATION,
  provider: "ego",
  source: "bundled",
  resourceBase: RESOURCE_BASE,
  rank: 600,
  locator: SKILL_PATH,
  path: SKILL_PATH,
});
const SKILL_PROVIDER = Object.freeze({
  name: "ego",
  async list() {
    return [SKILL_CANDIDATE];
  },
  async get(candidate) {
    if (
      candidate?.name !== SKILL_CANDIDATE.name ||
      candidate?.locator !== SKILL_CANDIDATE.locator
    ) {
      return undefined;
    }
    return {
      name: PACKAGED_SKILL.name,
      description: PACKAGED_SKILL.description,
      invocation: INVOCATION,
      provider: "ego",
      source: "bundled",
      resourceBase: RESOURCE_BASE,
      path: SKILL_PATH,
      content: PACKAGED_SKILL.content,
    };
  },
});

export const name = "ego";
export const inject = ["skills"];

export function apply(ctx) {
  ctx.skills.registerProvider(() => SKILL_PROVIDER);
}
