import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SKILL_GUIDE_MAX_CHARS,
  SKILL_GUIDE_WARN_BYTES,
  listSkillTopics,
  renderSkillGuide,
} from "../dist/src/skill-guide.js";

// Measure the bundled guide exactly as `ego-browser skill [topic]` prints it.
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const bundledSkillDir = join(packageRoot, "dist", "out", "ego-browser");

const outputs = [
  ["ego-browser skill", renderSkillGuide(bundledSkillDir)],
  ...listSkillTopics(bundledSkillDir).map(({ name }) => [
    `ego-browser skill ${name}`,
    renderSkillGuide(bundledSkillDir, name),
  ]),
];

const failures = [];
for (const [command, output] of outputs) {
  const chars = output.length;
  const bytes = Buffer.byteLength(output);
  const lines = output.split("\n").length - 1;
  console.log(`${command}: ${chars} chars, ${bytes} bytes, ${lines} lines`);
  if (chars > SKILL_GUIDE_MAX_CHARS) {
    failures.push(
      `${command} prints ${chars} characters; the limit is ${SKILL_GUIDE_MAX_CHARS}. ` +
        "Move situational content into a topic under skill/topics/.",
    );
  } else if (bytes > SKILL_GUIDE_WARN_BYTES) {
    console.warn(
      `warning: ${command} exceeds ${SKILL_GUIDE_WARN_BYTES} bytes; ` +
        "hosts with a 10 KiB output limit keep only its beginning and end.",
    );
  }
}

if (failures.length) {
  throw new Error(failures.join("\n"));
}
