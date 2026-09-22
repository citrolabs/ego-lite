#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  SKILL_DIR_ENV,
  SkillTopicError,
  renderSkillGuide,
  resolveSkillDir,
} from "./skill-guide.js";

// Built to dist/out/skill.js next to the SDK bundle. `ego-browser skill` runs
// the copy beside whichever SDK it selected, so the guide follows `--sdk-path`
// and the debug SDK entry without a separate switch.
const USAGE = `Usage:
  ego-browser skill [topic] [--skill-dir <dir>]

Print the ego-browser guide for this version, or one of its topics.

Options:
  --skill-dir <dir>  Read the guide from <dir> instead of the bundled copy
                     (${SKILL_DIR_ENV} sets the same override)
  -h, --help         Show this help
`;

type ParsedArgs = { help: boolean; skillDir?: string; topic?: string };

export function parseSkillArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      parsed.help = true;
    } else if (arg === "--skill-dir") {
      parsed.skillDir = argv[++index];
      if (!parsed.skillDir) throw new Error("--skill-dir requires a directory");
    } else if (arg.startsWith("--skill-dir=")) {
      parsed.skillDir = arg.slice("--skill-dir=".length);
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (parsed.topic === undefined) {
      parsed.topic = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return parsed;
}

export function runSkillCli(argv: string[]): number {
  try {
    const args = parseSkillArgs(argv);
    if (args.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    const dir = resolveSkillDir({
      flag: args.skillDir,
      env: process.env[SKILL_DIR_ENV],
      bundledDir: join(dirname(fileURLToPath(import.meta.url)), "ego-browser"),
    });
    process.stdout.write(renderSkillGuide(dir, args.topic));
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    return error instanceof SkillTopicError ? 2 : 1;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  process.exitCode = runSkillCli(process.argv.slice(2));
}
