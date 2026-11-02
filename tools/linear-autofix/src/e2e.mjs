import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "./config.mjs";
import * as git from "./git.mjs";
import { run } from "./proc.mjs";

const E2E_SCOPE = /^(package\/ego-browser\/|skills\/ego-browser\/)/;

/** Paths whose change makes the pre-push hook run the real-browser E2E suite. */
export function touchesE2eScope(changedFiles) {
  return changedFiles.some((f) => E2E_SCOPE.test(f));
}

/**
 * Split the suite into the cases to run and the known-failing names that do
 * not exist (a typo, or a case that was renamed). Pure.
 */
export function selectE2eCases(allCases, knownFailures) {
  const known = new Set(knownFailures);
  const all = new Set(allCases);
  return {
    only: allCases.filter((name) => !known.has(name)),
    excluded: allCases.filter((name) => known.has(name)),
    unknown: knownFailures.filter((name) => !all.has(name)),
  };
}

async function listE2eCases(dir) {
  const file = path.join(
    dir,
    config.packageDir,
    "scripts/real-browser-e2e/cases/index.mjs",
  );
  if (!fs.existsSync(file))
    throw new Error(`E2E case index not found at ${file}`);
  const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
  return mod.e2eCases.map((c) => c.name);
}

/**
 * Push the worktree branch through the E2E gate.
 *
 * Without known-failing cases the pre-push hook runs the full suite as usual.
 * With `AUTOFIX_E2E_KNOWN_FAILURES` set and the diff inside the E2E scope, the
 * bot runs the suite itself with those cases left out and pushes with the hook
 * excluded, so one browser-side bug does not block every PR. Returns the
 * excluded case names (empty when the hook ran the full suite).
 */
export async function gatedPush(dir, branch) {
  const base = `${config.remote}/${config.baseBranch}`;
  const changed = await git.changedFiles(dir, base);
  const known = config.e2eKnownFailures;
  if (!known.length || !touchesE2eScope(changed)) {
    await git.push(dir, branch);
    return { excluded: [], ran: known.length ? "not needed" : "hook" };
  }
  const { only, excluded, unknown } = selectE2eCases(
    await listE2eCases(dir),
    known,
  );
  if (unknown.length)
    console.warn(
      `AUTOFIX_E2E_KNOWN_FAILURES names unknown cases: ${unknown.join(", ")}`,
    );
  if (!only.length)
    throw new Error("AUTOFIX_E2E_KNOWN_FAILURES excludes every E2E case");
  if (config.dryRun) {
    console.log(`[dry-run] would run E2E without: ${excluded.join(", ")}`);
  } else {
    await run("npm", ["run", "e2e"], {
      cwd: path.join(dir, config.packageDir),
      timeoutMs: config.pushTimeoutMs,
      env: { EGO_BROWSER_REAL_E2E_ONLY: JSON.stringify(only) },
    });
  }
  await git.push(dir, branch, { skipHookE2e: true });
  return { excluded, ran: "bot" };
}

/** The sentence the PR body carries about how E2E was run. */
export function e2eNote(gate) {
  if (gate.ran === "bot") {
    return `The real-browser E2E suite ran on the bot machine before this push, excluding known-failing cases: ${gate.excluded.map((n) => `\`${n}\``).join(", ")} (AUTOFIX_E2E_KNOWN_FAILURES).`;
  }
  if (gate.ran === "not needed")
    return "No E2E-scoped files changed; the pre-push E2E hook did not run.";
  return "The pre-push real-browser E2E suite ran on the bot machine before this push.";
}
