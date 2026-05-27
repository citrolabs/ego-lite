#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { siteSkillsRoot, validateSiteSkills } from "../src/learning/index.js";

export { validateSiteSkills };

export async function main(argv = process.argv.slice(2)) {
  const rootArg = argv[0] || siteSkillsRoot();
  const root = resolve(rootArg);
  const canonicalRoot = resolve(siteSkillsRoot());
  if (root !== canonicalRoot) {
    console.warn(`warning: validating ${root} which differs from siteSkillsRoot() ${canonicalRoot}`);
  }
  const errors = await validateSiteSkills(root);
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    return 1;
  }
  console.log(`site skills ok: ${root}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
