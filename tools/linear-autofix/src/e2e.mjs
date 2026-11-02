import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "./config.mjs";
import * as git from "./git.mjs";
import * as github from "./github.mjs";
import { ProcessError, run } from "./proc.mjs";
import { save } from "./state.mjs";

const E2E_SCOPE = /^(package\/ego-browser\/|skills\/ego-browser\/)/;
const MAX_FAILURE_CHARS = 1500;

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
 * The failed cases in the runner's results file, or null when no case passed.
 * Nothing passing means the host could not run the suite (CLI missing, browser
 * down) or the build is unusable, not a list worth reporting case by case. Pure.
 */
export function failedCases(results) {
  const cases = results?.cases ?? [];
  if (!cases.some((c) => c.status === "pass")) return null;
  return cases
    .filter((c) => c.status === "fail")
    .map((c) => ({ name: c.name, message: String(c.message ?? "") }));
}

/**
 * Run the suite and return the failed cases. Throws when it gave no usable
 * verdict (build error, timeout, no case passing): that is for a human to look
 * at on the host, not something to report on a PR as case failures.
 */
async function runSuite(dir, excluded, only) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autofix-e2e-"));
  const resultsFile = path.join(tmp, "results.json");
  try {
    const result = await run("npm", ["run", "e2e"], {
      cwd: path.join(dir, config.packageDir),
      timeoutMs: config.pushTimeoutMs,
      allowFailure: true,
      env: {
        EGO_BROWSER_REAL_E2E_RESULTS: resultsFile,
        // Without exclusions it stays a full run, which can skip an unchanged
        // build and records a full pass.
        ...(excluded.length
          ? { EGO_BROWSER_REAL_E2E_ONLY: JSON.stringify(only) }
          : {}),
      },
    });
    if (result.code === 0) return [];
    const failures = fs.existsSync(resultsFile)
      ? failedCases(JSON.parse(fs.readFileSync(resultsFile, "utf8")))
      : null;
    if (!failures?.length) {
      throw new ProcessError(
        `E2E suite exited ${result.code} without a usable result (it did not finish, or no case passed)`,
        result,
      );
    }
    return failures;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Push the worktree branch through the E2E gate.
 *
 * When the diff is inside the E2E scope the bot runs the suite itself, leaving
 * out `AUTOFIX_E2E_KNOWN_FAILURES`, and pushes with the hook excluded. Failed
 * cases do not stop the push: they come back in `failures` for the PR comment.
 */
export async function gatedPush(dir, branch) {
  const base = `${config.remote}/${config.baseBranch}`;
  const changed = await git.changedFiles(dir, base);
  if (!touchesE2eScope(changed)) {
    await git.push(dir, branch);
    return { ran: "not needed", excluded: [], failures: [] };
  }
  const { only, excluded, unknown } = selectE2eCases(
    await listE2eCases(dir),
    config.e2eKnownFailures,
  );
  if (unknown.length)
    console.warn(
      `AUTOFIX_E2E_KNOWN_FAILURES names unknown cases: ${unknown.join(", ")}`,
    );
  if (!only.length)
    throw new Error("AUTOFIX_E2E_KNOWN_FAILURES excludes every E2E case");
  let failures = [];
  if (config.dryRun) {
    console.log(`[dry-run] would run E2E without: ${excluded.join(", ")}`);
  } else {
    failures = await runSuite(dir, excluded, only);
  }
  await git.push(dir, branch, { skipHookE2e: true });
  return { ran: "bot", excluded, failures };
}

/** The sentence the PR body carries about how E2E was run. Pure. */
export function e2eNote(gate) {
  if (gate.ran === "not needed")
    return "No E2E-scoped files changed; the real-browser E2E suite did not run.";
  const excluded = gate.excluded.length
    ? `, excluding known-failing cases: ${gate.excluded.map((n) => `\`${n}\``).join(", ")} (AUTOFIX_E2E_KNOWN_FAILURES)`
    : "";
  const outcome = gate.failures.length
    ? ` ${gate.failures.length} case(s) failed; a PR comment lists them.`
    : "";
  return `The real-browser E2E suite ran on the bot machine before this push${excluded}.${outcome}`;
}

/**
 * PR comment naming the failed cases. The repository is public and the runner's
 * messages can carry local paths, so the home directory is shortened. Pure.
 */
export function e2eFailureComment(gate, sha, home = os.homedir()) {
  const cases = gate.failures.map(({ name, message }) => {
    const text = message
      .replaceAll(home, "~")
      .replaceAll("```", "'''")
      .slice(0, MAX_FAILURE_CHARS);
    return `#### \`${name}\`\n\n\`\`\`text\n${text}\n\`\`\``;
  });
  const excluded = gate.excluded.length
    ? `\n\nNot run (known failures on this host): ${gate.excluded.map((n) => `\`${n}\``).join(", ")}.`
    : "";
  return `### Real-browser E2E: ${gate.failures.length} case(s) failed on \`${sha.slice(0, 8)}\`\n\nThe bot pushed anyway, since a failed case does not block the PR. Check whether these failures come from this change before merging.${excluded}\n\n${cases.join("\n\n")}`;
}

/**
 * Remember what E2E said about this head, and the PR comment that goes with it.
 * The comment is kept on the record until it is posted, so a failed `gh` call
 * cannot leave a PR that looks clean: the next review check posts it. A pass
 * only needs saying when it replaces an earlier failure comment.
 */
export function recordE2e(record, gate, sha) {
  let unposted;
  if (gate.failures.length) {
    unposted = e2eFailureComment(gate, sha);
  } else if (gate.ran === "bot" && record.e2e?.failures?.length) {
    unposted = `### Real-browser E2E: passes on \`${sha.slice(0, 8)}\`\n\nThe failures reported in earlier comments no longer occur.`;
  }
  record.e2e = {
    sha,
    failures: gate.failures.map((f) => f.name),
    ...(unposted ? { unposted } : {}),
  };
  save(record);
}

export async function flushE2eComment(record, prNumber) {
  if (!record.e2e?.unposted) return;
  await github.commentOnPr(prNumber, record.e2e.unposted);
  delete record.e2e.unposted;
  save(record);
}

/** Warning for Linear comments that would otherwise read as all green. Pure. */
export function e2eWarning(record, sha) {
  const failures = record.e2e?.sha === sha ? (record.e2e.failures ?? []) : [];
  if (!failures.length) return "";
  return `\n\n⚠️ 这个提交上有 ${failures.length} 个 E2E 用例失败（${failures.join(", ")}），详情见 PR 评论，合并前请确认是否由本次改动引起。`;
}
