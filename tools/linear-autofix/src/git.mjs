import fs from "node:fs";
import { config } from "./config.mjs";
import { run } from "./proc.mjs";

const git = (args, opts = {}) =>
  run("git", args, { cwd: config.repoRoot, timeoutMs: 120_000, ...opts });
const gitIn = (cwd, args, opts = {}) =>
  run("git", args, { cwd, timeoutMs: 120_000, ...opts });

export async function fetchBase() {
  await git(["fetch", "--quiet", "--prune", config.remote, config.baseBranch]);
}

async function refExists(ref) {
  const { code } = await git(["show-ref", "--verify", "--quiet", ref], {
    allowFailure: true,
  });
  return code === 0;
}

/**
 * Make sure a worktree for `branch` exists at `dir`, based on the remote base
 * branch. Reuses a local or remote branch of that name when present so a
 * crashed run or a pre-existing PR branch is picked up rather than clobbered.
 */
export async function ensureWorktree(dir, branch) {
  const base = `${config.remote}/${config.baseBranch}`;
  await fetchBase();
  if (fs.existsSync(dir)) {
    const { stdout } = await git(["worktree", "list", "--porcelain"]);
    if (stdout.includes(`worktree ${dir}\n`)) {
      const { stdout: cur } = await gitIn(dir, [
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ]);
      if (cur.trim() !== branch)
        throw new Error(
          `worktree ${dir} is on ${cur.trim()}, expected ${branch}`,
        );
      return { created: false };
    }
    throw new Error(`${dir} exists but is not a registered worktree`);
  }
  await git(
    [
      "fetch",
      "--quiet",
      config.remote,
      `+refs/heads/${branch}:refs/remotes/${config.remote}/${branch}`,
    ],
    {
      allowFailure: true,
    },
  );
  if (await refExists(`refs/heads/${branch}`)) {
    await git(["worktree", "add", dir, branch]);
  } else if (await refExists(`refs/remotes/${config.remote}/${branch}`)) {
    await git([
      "worktree",
      "add",
      "--track",
      "-b",
      branch,
      dir,
      `${config.remote}/${branch}`,
    ]);
  } else {
    await git(["worktree", "add", "-b", branch, dir, base]);
  }
  return { created: true };
}

export async function removeWorktree(dir) {
  await git(["worktree", "remove", "--force", dir], { allowFailure: true });
}

/** Bring origin/<base> into the branch with a merge commit (never a rebase: the bot never force-pushes). */
export async function mergeBase(dir) {
  await fetchBase();
  const { code, stdout, stderr } = await gitIn(
    dir,
    ["merge", "--no-edit", `${config.remote}/${config.baseBranch}`],
    {
      allowFailure: true,
    },
  );
  if (code !== 0) {
    await gitIn(dir, ["merge", "--abort"], { allowFailure: true });
    throw new Error(
      `merge of ${config.remote}/${config.baseBranch} conflicts:\n${stdout}\n${stderr}`,
    );
  }
}

export async function headSha(dir) {
  return (await gitIn(dir, ["rev-parse", "HEAD"])).stdout.trim();
}

export async function commitsAhead(dir, ref) {
  return Number(
    (await gitIn(dir, ["rev-list", "--count", `${ref}..HEAD`])).stdout.trim(),
  );
}

export async function isDirty(dir) {
  return (await gitIn(dir, ["status", "--porcelain"])).stdout.trim() !== "";
}

export async function recentLog(dir, ref) {
  return (await gitIn(dir, ["log", "--oneline", `${ref}..HEAD`])).stdout.trim();
}

/** Files changed on the branch relative to `ref`. */
export async function changedFiles(dir, ref) {
  const { stdout } = await gitIn(dir, ["diff", "--name-only", `${ref}...HEAD`]);
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Push the branch. The pre-push hook runs the real-browser E2E suite here
 * unless `skipHookE2e` is set, which the E2E gate does after running the suite
 * itself (see e2e.mjs).
 */
export async function push(dir, branch, { skipHookE2e = false } = {}) {
  if (config.dryRun) {
    console.log(
      `[dry-run] git push ${config.remote} ${branch} (from ${dir}${skipHookE2e ? ", hook E2E excluded" : ""})`,
    );
    return;
  }
  await gitIn(dir, ["push", "--set-upstream", config.remote, branch], {
    timeoutMs: config.pushTimeoutMs,
    env: skipHookE2e ? { LEFTHOOK_EXCLUDE: "e2e-test" } : {},
  });
}

export async function remoteSha(dir, branch) {
  const { stdout, code } = await gitIn(
    dir,
    ["rev-parse", `${config.remote}/${branch}`],
    { allowFailure: true },
  );
  return code === 0 ? stdout.trim() : null;
}

export async function installDeps(dir) {
  const pkg = `${dir}/${config.packageDir}`;
  if (fs.existsSync(`${pkg}/node_modules/.bin/prettier`)) return;
  await run("npm", ["ci", "--no-audit", "--no-fund"], {
    cwd: pkg,
    timeoutMs: 15 * 60_000,
  });
}

/** Delete the local branch unless a worktree still has it checked out. */
export async function deleteLocalBranch(branch) {
  const { code, stderr } = await git(["branch", "-D", branch], {
    allowFailure: true,
  });
  if (code !== 0 && !/not found/.test(stderr)) throw new Error(stderr.trim());
  return code === 0;
}

/** Delete the branch on the remote. Human-invoked only (`reset --remote`). */
export async function deleteRemoteBranch(branch) {
  if (config.dryRun) {
    console.log(`[dry-run] git push ${config.remote} --delete ${branch}`);
    return;
  }
  await git(["push", config.remote, "--delete", branch], { timeoutMs: 60_000 });
}

export async function remoteBranchExists(branch) {
  const { stdout } = await git(
    ["ls-remote", "--heads", config.remote, branch],
    { timeoutMs: 60_000 },
  );
  return stdout.trim() !== "";
}
