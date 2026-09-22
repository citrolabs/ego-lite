import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const canonicalPath = join(packageRoot, "skill/GUIDE.md");
const translationPath = join(packageRoot, "skill/workbench/GUIDE.zh.md");

let translation;
try {
  translation = await readFile(translationPath, "utf8");
} catch (error) {
  if (error?.code === "ENOENT") process.exit(0);
  throw error;
}

const canonical = await readFile(canonicalPath);
const actual = createHash("sha256").update(canonical).digest("hex");
const expected = translation.match(
  /<!-- source-skill-sha256: ([a-f0-9]{64}) -->/,
)?.[1];

if (expected !== actual) {
  throw new Error(
    `Local Chinese Skill is out of sync with ${canonicalPath}. ` +
      `Update the translation and set source-skill-sha256 to ${actual}.`,
  );
}
