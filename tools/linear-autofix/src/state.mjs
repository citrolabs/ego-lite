import fs from "node:fs";
import path from "node:path";
import { config } from "./config.mjs";

export const STAGES = Object.freeze([
  "new", // seen, not yet triaged
  "triaged", // verdict fix, waiting for an implementation slot
  "implementing", // worktree + Claude run in progress (crash marker)
  "in_review", // PR open, review loop active
  "done", // review loop finished; a human merges
  "escalated", // bot gave up, human attention needed
  "skipped", // verdict was not fix
]);

const issuesDir = () => path.join(config.stateDir, "issues");
const lockPath = () => path.join(config.stateDir, "tick.lock");
const stopPath = () => path.join(config.stateDir, "STOP");

export function ensureStateDir() {
  fs.mkdirSync(issuesDir(), { recursive: true });
  fs.mkdirSync(path.join(config.stateDir, "worktrees"), { recursive: true });
  fs.mkdirSync(path.join(config.stateDir, "runs"), { recursive: true });
}

export function recordPath(identifier) {
  return path.join(issuesDir(), `${identifier}.json`);
}

export function load(identifier) {
  try {
    return JSON.parse(fs.readFileSync(recordPath(identifier), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export function loadAll() {
  ensureStateDir();
  return fs
    .readdirSync(issuesDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(issuesDir(), f), "utf8")));
}

export function save(record) {
  ensureStateDir();
  record.updatedAt = new Date().toISOString();
  const file = recordPath(record.identifier);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(record, null, 2));
  fs.renameSync(`${file}.tmp`, file);
  return record;
}

/** Append a history event and persist. */
export function note(record, event, detail) {
  record.history ??= [];
  record.history.push({
    at: new Date().toISOString(),
    event,
    ...(detail ? { detail } : {}),
  });
  if (record.history.length > 200)
    record.history.splice(0, record.history.length - 200);
  console.log(
    `[${record.identifier}] ${event}${detail ? `: ${truncate(detail)}` : ""}`,
  );
  return save(record);
}

export function transition(record, stage, detail) {
  if (!STAGES.includes(stage)) throw new Error(`unknown stage ${stage}`);
  const from = record.stage;
  record.stage = stage;
  return note(record, `stage ${from} -> ${stage}`, detail);
}

/** Create or refresh the record for a Linear issue. Pure apart from I/O. */
export function upsertFromIssue(issue) {
  const existing = load(issue.identifier);
  const base = existing ?? {
    id: issue.id,
    identifier: issue.identifier,
    stage: "new",
    history: [],
    createdAt: new Date().toISOString(),
  };
  base.title = issue.title;
  base.url = issue.url;
  base.branch = issue.branchName;
  base.teamId = issue.team?.id;
  base.teamKey = issue.team?.key;
  base.linearState = issue.state?.name;
  base.linearUpdatedAt = issue.updatedAt;
  base.labels = (issue.labels?.nodes ?? []).map((l) => l.name);
  const commentCount = issue.comments?.nodes?.length ?? 0;
  base.lastSeenCommentCount ??= commentCount;
  base.commentCount = commentCount;
  return save(base);
}

export function acquireLock() {
  ensureStateDir();
  try {
    fs.writeFileSync(lockPath(), String(process.pid), { flag: "wx" });
    return true;
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    const pid = Number(fs.readFileSync(lockPath(), "utf8"));
    if (pid && isAlive(pid)) return false;
    fs.writeFileSync(lockPath(), String(process.pid));
    return true;
  }
}

export function releaseLock() {
  try {
    fs.unlinkSync(lockPath());
  } catch {}
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function stopRequested() {
  return fs.existsSync(stopPath());
}

export function setStop(on) {
  ensureStateDir();
  if (on) fs.writeFileSync(stopPath(), new Date().toISOString());
  else fs.rmSync(stopPath(), { force: true });
}

export function runDir(identifier, stage) {
  const dir = path.join(
    config.stateDir,
    "runs",
    identifier,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${stage}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function worktreePath(identifier) {
  return path.join(config.stateDir, "worktrees", identifier);
}

export function truncate(text, max = 160) {
  const s = String(text).replace(/\s+/g, " ");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
