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
 * Make sure a worktree for `branch` exists at `dir`.
 *
 * A branch that exists on the remote (checked with ls-remote, never with the
 * local remote-tracking ref, which survives the remote branch's deletion) or
 * locally is resumed; otherwise the branch is cut from `origin/<base>`. A
 * stale remote-tracking ref is deleted first: one left behind by a deleted
 * branch once seeded a worktree with the wrong history (#631). A freshly
 * created worktree must start inside `origin/<base>`, or the call fails.
 */
export async function ensureWorktree(dir, branch) {
  const base = `${config.remote}/${config.baseBranch}`;
  await assertMainCheckoutNotOn(branch);
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
  const trackingRef = `refs/remotes/${config.remote}/${branch}`;
  if (await remoteBranchExists(branch)) {
    await git([
      "fetch",
      "--quiet",
      config.remote,
      `+refs/heads/${branch}:${trackingRef}`,
    ]);
  } else {
    await git(["update-ref", "-d", trackingRef], { allowFailure: true });
  }
  if (await refExists(`refs/heads/${branch}`)) {
    await git(["worktree", "add", dir, branch]);
  } else if (await refExists(trackingRef)) {
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
    const { code } = await gitIn(
      dir,
      ["merge-base", "--is-ancestor", "HEAD", base],
      {
        allowFailure: true,
      },
    );
    if (code !== 0) {
      throw new Error(`new worktree ${dir} does not start inside ${base}`);
    }
  }
  return { created: true };
}

/**
 * Bring the worktree to the remote branch's state when they diverged: a
 * human may have rewritten the PR branch (for example to drop commits). The
 * remote is the truth for a PR branch. Returns what happened.
 */
export async function syncWorktreeToRemote(dir, branch) {
  if (!(await remoteBranchExists(branch))) return "no-remote";
  await git([
    "fetch",
    "--quiet",
    config.remote,
    `+refs/heads/${branch}:refs/remotes/${config.remote}/${branch}`,
  ]);
  const remote = `${config.remote}/${branch}`;
  const local = await headSha(dir);
  const remoteHead = (await gitIn(dir, ["rev-parse", remote])).stdout.trim();
  if (local === remoteHead) return "in-sync";
  if (await isDirty(dir))
    throw new Error(`worktree ${dir} is dirty; cannot sync to ${remote}`);
  const { code: remoteIsBehind } = await gitIn(
    dir,
    ["merge-base", "--is-ancestor", remote, "HEAD"],
    {
      allowFailure: true,
    },
  );
  if (remoteIsBehind === 0) return "ahead"; // local commits not pushed yet; keep them
  await gitIn(dir, ["reset", "--hard", remote]);
  return "reset-to-remote";
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
 * itself, so failed cases can be reported instead of stopping the push (see
 * e2e.mjs).
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

/** Drop whatever a run left in the worktree: commits after `sha` and untracked files (ignored ones stay). */
export async function discardTo(dir, sha) {
  await gitIn(dir, ["reset", "--hard", sha]);
  await gitIn(dir, ["clean", "-fd"]);
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

/**
 * The bot derives everything from `origin/<base>`; the main checkout's own
 * branch is irrelevant, with one exception: if a human switched it onto the
 * ticket branch, any pull or reset there moves the branch the bot is about to
 * push (that is how #630 came to carry the wrong commits). Refuse early.
 */
export async function assertMainCheckoutNotOn(branch) {
  const { stdout } = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (stdout.trim() === branch) {
    throw new Error(
      `the main checkout ${config.repoRoot} has ${branch} checked out; switch it to another branch (for example ${config.baseBranch}) before the bot touches this ticket`,
    );
  }
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

/** Drop the local remote-tracking ref for a branch (stale after the remote branch was deleted). */
export async function deleteTrackingRef(branch) {
  await git(["update-ref", "-d", `refs/remotes/${config.remote}/${branch}`], {
    allowFailure: true,
  });
}
