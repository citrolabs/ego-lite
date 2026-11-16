import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.mjs";
import { run } from "./proc.mjs";

async function gh(args, opts = {}) {
  const { stdout } = await run("gh", args, {
    cwd: config.repoRoot,
    timeoutMs: 60_000,
    ...opts,
  });
  return stdout;
}

async function ghJson(args, opts) {
  return JSON.parse(await gh(args, opts));
}

let nwo;
export async function repoNameWithOwner() {
  nwo ??= (await ghJson(["repo", "view", "--json", "nameWithOwner"]))
    .nameWithOwner;
  return nwo;
}

/** Open PR for a branch, else the most recent closed/merged one, else null. */
export async function findPr(branch) {
  const prs = await ghJson([
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "all",
    "--limit",
    "10",
    "--json",
    "number,url,state,isDraft,baseRefName,createdAt",
  ]);
  return pickPr(prs, config.baseBranch);
}

/**
 * The PR the bot may resume for a branch: an open PR targeting the base
 * branch, else the most recent closed one, else null. An open PR that
 * targets another branch is not the bot's to touch, and pushing the branch
 * would modify it, so that case throws. Pure.
 */
export function pickPr(prs, baseBranch) {
  if (!prs?.length) return null;
  const open = prs.filter((p) => p.state === "OPEN");
  const mine = open.find((p) => p.baseRefName === baseBranch);
  if (mine) return mine;
  if (open.length) {
    throw new Error(
      `${open[0].url} is open against ${open[0].baseRefName}, not ${baseBranch}; the bot only works on PRs into ${baseBranch}`,
    );
  }
  return [...prs].sort((a, b) =>
    String(b.createdAt).localeCompare(String(a.createdAt)),
  )[0];
}

function dry(what) {
  console.log(`[dry-run] github: ${what}`);
}

export async function createPr({ branch, title, body, draft }) {
  if (config.dryRun) {
    dry(
      `create PR from ${branch} (${draft ? "draft" : "ready"}): ${title}\n${body}`,
    );
    return { number: 0, url: "(dry-run)", isDraft: !!draft };
  }
  const bodyFile = path.join(os.tmpdir(), `autofix-pr-${process.pid}.md`);
  fs.writeFileSync(bodyFile, body);
  try {
    const args = [
      "pr",
      "create",
      "--base",
      config.baseBranch,
      "--head",
      branch,
      "--title",
      title,
      "--body-file",
      bodyFile,
    ];
    if (draft) args.push("--draft");
    const out = await gh(args);
    const match = out.match(/\/pull\/(\d+)/);
    if (!match)
      throw new Error(`could not parse PR number from gh output: ${out}`);
    return {
      number: Number(match[1]),
      url: out.trim().split("\n").pop(),
      isDraft: !!draft,
    };
  } finally {
    fs.rmSync(bodyFile, { force: true });
  }
}

export async function viewPr(number) {
  return ghJson([
    "pr",
    "view",
    String(number),
    "--json",
    "number,url,state,isDraft,headRefOid,headRefName,mergedAt,comments,statusCheckRollup,reviewDecision,mergeable",
  ]);
}

/** `gh pr checks` output, used to show CI failures to the fixer. */
export async function checksText(number) {
  const { stdout, stderr } = await run("gh", ["pr", "checks", String(number)], {
    cwd: config.repoRoot,
    allowFailure: true,
    timeoutMs: 60_000,
  });
  return (stdout || stderr).trim();
}

/** Every review thread of the PR, following the connection's pages. */
export async function reviewThreads(number) {
  const [owner, name] = (await repoNameWithOwner()).split("/");
  const threads = [];
  let after = null;
  for (;;) {
    const data = await ghJson([
      "api",
      "graphql",
      "-f",
      `query=query($owner:String!,$name:String!,$number:Int!,$after:String){
        repository(owner:$owner,name:$name){ pullRequest(number:$number){
          reviewThreads(first:100, after:$after){
            pageInfo{ hasNextPage endCursor }
            nodes{
              id isResolved isOutdated path line
              comments(last:50){ nodes{ id body createdAt author{ login } } }
            }
          }
        } }
      }`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-F",
      `number=${number}`,
      ...(after ? ["-f", `after=${after}`] : []),
    ]);
    const page = data.data.repository.pullRequest.reviewThreads;
    threads.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return threads;
    after = page.pageInfo.endCursor;
  }
}

export async function replyToThread(threadId, body) {
  const text = `${config.botMarker}\n${body}`;
  if (config.dryRun) return dry(`reply to thread ${threadId}:\n${text}`);
  await gh([
    "api",
    "graphql",
    "-f",
    `query=mutation($id:ID!,$body:String!){
      addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id, body:$body}){ comment{ id } }
    }`,
    "-f",
    `id=${threadId}`,
    "-f",
    `body=${text}`,
  ]);
}

export async function resolveThread(threadId) {
  if (config.dryRun) return dry(`resolve thread ${threadId}`);
  await gh([
    "api",
    "graphql",
    "-f",
    `query=mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ id isResolved } } }`,
    "-f",
    `id=${threadId}`,
  ]);
}

export async function commentOnPr(number, body) {
  const text = `${config.botMarker}\n${body}`;
  if (config.dryRun) return dry(`comment on PR #${number}:\n${text}`);
  const bodyFile = path.join(os.tmpdir(), `autofix-comment-${process.pid}.md`);
  fs.writeFileSync(bodyFile, text);
  try {
    await gh(["pr", "comment", String(number), "--body-file", bodyFile]);
  } finally {
    fs.rmSync(bodyFile, { force: true });
  }
}

/** Summarize statusCheckRollup into success | pending | failure | none. */
export function ciStatus(rollup) {
  if (!rollup?.length) return "none";
  const states = rollup.map((c) =>
    (c.conclusion || c.state || "").toUpperCase(),
  );
  if (
    states.some((s) =>
      [
        "FAILURE",
        "ERROR",
        "TIMED_OUT",
        "CANCELLED",
        "ACTION_REQUIRED",
        "STARTUP_FAILURE",
      ].includes(s),
    )
  )
    return "failure";
  if (
    states.some((s) =>
      [
        "",
        "PENDING",
        "QUEUED",
        "IN_PROGRESS",
        "WAITING",
        "EXPECTED",
        "REQUESTED",
      ].includes(s),
    )
  )
    return "pending";
  return "success";
}
