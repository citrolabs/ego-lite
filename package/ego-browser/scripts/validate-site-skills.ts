#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

import { siteSkillsRoot, validateSiteSkills } from "../src/learning/index.js";

export { validateSiteSkills };

// Default the workspace to this checkout's skill directory. It used to be an
// inline `EGO_BROWSER_AGENT_WORKSPACE=... node ...` prefix in package.json,
// which cmd.exe parses as a command name on Windows. Anchored on this file
// rather than the cwd so it holds wherever npm is invoked from.
function defaultAgentWorkspace() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  return resolve(scriptDir, "..", "..", "..", "..", "skills", "ego-browser");
}

export async function main(argv = process.argv.slice(2)) {
  process.env.EGO_BROWSER_AGENT_WORKSPACE ??= defaultAgentWorkspace();
  const rootArg = argv[0] || siteSkillsRoot();
  const root = resolve(rootArg);
  const canonicalRoot = resolve(siteSkillsRoot());
  if (root !== canonicalRoot) {
    console.warn(
      `warning: validating ${root} which differs from siteSkillsRoot() ${canonicalRoot}`,
    );
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main();
}
