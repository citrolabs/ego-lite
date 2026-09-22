import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const SKILL_GUIDE_PREFIX = "[ego-browser:skill]";
export const SKILL_DIR_ENV = "EGO_BROWSER_SKILL_DIR";

// Agent hosts cut long command output: Claude Code keeps 30,000 characters and
// older Codex builds keep 10 KiB. The hard limit leaves headroom below the
// larger one; crossing the soft limit is reported but does not fail the build.
export const SKILL_GUIDE_MAX_CHARS = 25_000;
export const SKILL_GUIDE_WARN_BYTES = 10 * 1024;

const GUIDE_FILE = "GUIDE.md";
const TOPICS_DIR = "topics";
const TOPIC_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type GuideDocument = {
  attributes: Record<string, string>;
  body: string;
};

export type SkillTopic = {
  name: string;
  description: string;
};

export class SkillTopicError extends Error {
  constructor(topic: string, topics: SkillTopic[]) {
    const available = topics.length
      ? topics.map((item) => item.name).join(", ")
      : "(none)";
    super(
      `${SKILL_GUIDE_PREFIX} Unknown topic: ${topic}. ` +
        `Topics in this version: ${available}. ` +
        "Run `ego-browser skill` for the main guide.",
    );
    this.name = "SkillTopicError";
  }
}

/**
 * Pick the guide directory: an explicit `--skill-dir`, then
 * `EGO_BROWSER_SKILL_DIR`, then the guide bundled next to the running SDK.
 */
export function resolveSkillDir(options: {
  flag?: string;
  env?: string;
  bundledDir: string;
}): string {
  return resolve(options.flag || options.env || options.bundledDir);
}

/** List the topics shipped with the guide in `dir`, sorted by name. */
export function listSkillTopics(dir: string): SkillTopic[] {
  const topicsDir = join(dir, TOPICS_DIR);
  if (!existsSync(topicsDir)) return [];
  return readdirSync(topicsDir)
    .filter((file) => file.endsWith(".md"))
    .map((file) => file.slice(0, -".md".length))
    .filter((name) => TOPIC_NAME.test(name))
    .sort()
    .map((name) => {
      const path = join(topicsDir, `${name}.md`);
      const description = readGuideDocument(path).attributes.description;
      if (!description) {
        throw new Error(`Skill topic requires a description: ${path}`);
      }
      return { name, description };
    });
}

/**
 * Render what `ego-browser skill [topic]` prints: the main guide with its topic
 * index, or one topic. Both start with the version and source directory and end
 * with a marker, so an agent can tell when its host truncated the output.
 */
export function renderSkillGuide(dir: string, topic?: string): string {
  const guide = readGuideDocument(join(dir, GUIDE_FILE));
  const version = guide.attributes.version;
  if (!version) {
    throw new Error(`Skill guide requires a version: ${join(dir, GUIDE_FILE)}`);
  }
  const topics = listSkillTopics(dir);

  if (topic === undefined) {
    return [
      `${SKILL_GUIDE_PREFIX} ego-browser guide v${version} from ${dir}`,
      guide.body,
      topicIndex(topics),
      `${SKILL_GUIDE_PREFIX} end of guide v${version}`,
    ]
      .filter(Boolean)
      .join("\n\n")
      .concat("\n");
  }

  if (!topics.some((item) => item.name === topic)) {
    throw new SkillTopicError(topic, topics);
  }
  const document = readGuideDocument(join(dir, TOPICS_DIR, `${topic}.md`));
  return [
    `${SKILL_GUIDE_PREFIX} topic ${topic} v${version} from ${dir}`,
    document.body,
    `${SKILL_GUIDE_PREFIX} end of topic ${topic} v${version}`,
  ]
    .join("\n\n")
    .concat("\n");
}

function topicIndex(topics: SkillTopic[]): string {
  if (!topics.length) return "";
  return [
    "## Topics",
    "Run `ego-browser skill <topic>` when its description applies:",
    topics.map((item) => `- \`${item.name}\`: ${item.description}`).join("\n"),
  ].join("\n\n");
}

function readGuideDocument(path: string): GuideDocument {
  const source = readFileSync(path, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
  if (!match) return { attributes: {}, body: source.trim() };

  const attributes: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (field) attributes[field[1]] = unquote(field[2]);
  }
  return { attributes, body: match[2].trim() };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
