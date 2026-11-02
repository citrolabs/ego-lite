import fs from "node:fs";
import path from "node:path";
import { config } from "./config.mjs";
import { run, tail } from "./proc.mjs";
import { setUsagePause, truncate, usagePausedUntil } from "./state.mjs";

// How long to wait when a usage limit did not come with a reset time.
const USAGE_RETRY_MS = 30 * 60_000;
// Resume just after the reset, not at the instant the server may still refuse.
const USAGE_RESET_MARGIN_MS = 60_000;
const USAGE_LIMIT_TEXT =
  /you've hit your .*(limit|budget)|usage limit reached|out of usage credits/i;

/** The account is out of Claude usage; retrying before `until` (ms) is pointless. */
export class UsageLimitError extends Error {
  constructor(until, { reason, duringRun = false } = {}) {
    super(
      `Claude usage limit: paused until ${new Date(until).toISOString()}${reason ? ` (${reason})` : ""}`,
    );
    this.name = "UsageLimitError";
    this.until = until;
    // False when the run was refused before starting, so it changed nothing.
    this.duringRun = duringRun;
  }
}

/**
 * Pick the final result and the last rejected rate-limit event out of
 * `--output-format stream-json` output. Pure.
 */
export function parseClaudeStream(stdout) {
  let result = null;
  let rejected = null;
  for (const line of String(stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.type === "result") result = message;
    if (
      message.type === "rate_limit_event" &&
      message.rate_limit_info?.status === "rejected"
    ) {
      rejected = message.rate_limit_info;
    }
  }
  return { result, rejected };
}

/**
 * Whether a run stopped because the account ran out of usage, and when to try
 * again (ms). A rejected event alone is not enough: a run can finish normally
 * after one, and the run's own `--max-budget-usd` is a different limit. `stderr`
 * is only consulted without a result; assistant text never is, since a ticket
 * can talk about limits. Pure. Returns { until, reason } or null.
 */
export function detectUsageLimit({ result, rejected, stderr = "", now }) {
  if (result && result.is_error !== true) return null;
  if (/budget/i.test(result?.subtype ?? "")) return null;
  const text = result ? String(result.result ?? "") : String(stderr);
  if (
    !rejected &&
    result?.api_error_status !== 429 &&
    !USAGE_LIMIT_TEXT.test(text)
  ) {
    return null;
  }
  const resetsAt = Number(rejected?.resetsAt) * 1000;
  return {
    until:
      resetsAt > now ? resetsAt + USAGE_RESET_MARGIN_MS : now + USAGE_RETRY_MS,
    reason: text.trim().slice(0, 200),
  };
}

function pauseIfUsageLimit(stdout, stderr) {
  const limit = detectUsageLimit({
    ...parseClaudeStream(stdout),
    stderr,
    now: Date.now(),
  });
  if (!limit) return;
  setUsagePause(limit.until, limit.reason);
  throw new UsageLimitError(limit.until, {
    reason: limit.reason,
    duringRun: true,
  });
}

/**
 * What one stream-json line says Claude is doing, for the log: each tool call
 * and the first line of each text block. Pure. Returns a list of short strings.
 */
export function describeClaudeLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return [];
  }
  if (message.type !== "assistant") return [];
  const steps = [];
  for (const block of message.message?.content ?? []) {
    if (block.type === "tool_use") {
      const input = block.input ?? {};
      const target = input.command ?? input.file_path ?? input.pattern ?? "";
      steps.push(truncate(`${block.name}${target ? `: ${target}` : ""}`, 200));
    } else if (block.type === "text" && block.text?.trim()) {
      steps.push(truncate(block.text.trim().split("\n")[0], 200));
    }
  }
  return steps;
}

/**
 * Run `claude -p` headless. The prompt goes in on stdin. Returns
 * { text, structured, costUsd, turns, raw }. Throws on timeout or a non-zero
 * exit, and throws UsageLimitError (after recording the pause) when the account
 * is out of usage; any other Claude-side `is_error` result is returned with
 * `isError: true`. stream-json is used because only it carries the reset time.
 *
 * Permission model: `dontAsk` denies every tool call outside `allowedTools`,
 * which is how the orchestrator keeps `git push` and `gh` in its own hands.
 */
let processCostUsd = 0;
/** Total `claude -p` cost of this process so far. */
export function claudeCostUsd() {
  return processCostUsd;
}

export async function runClaude({
  prompt,
  cwd,
  runDir,
  label,
  identifier,
  allowedTools = [],
  restricted = false,
  budgetUsd,
  timeoutMs,
  schema,
  addDirs = [],
}) {
  const pausedUntil = usagePausedUntil();
  if (pausedUntil) throw new UsageLimitError(pausedUntil);

  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--strict-mcp-config",
  ];
  args.push("--permission-mode", "dontAsk");
  if (restricted) args.push("--restricted");
  if (allowedTools.length) args.push("--allowedTools", allowedTools.join(","));
  if (budgetUsd) args.push("--max-budget-usd", String(budgetUsd));
  if (schema) args.push("--json-schema", JSON.stringify(schema));
  if (config.claudeModel) args.push("--model", config.claudeModel);
  for (const dir of addDirs) args.push("--add-dir", dir);

  if (runDir) fs.writeFileSync(path.join(runDir, `${label}.prompt.md`), prompt);
  const started = Date.now();
  const tag = `[${identifier ? `${identifier} ` : ""}${label}]`;
  console.log(
    `${tag} claude started${budgetUsd ? `, budget $${budgetUsd}` : ""}${timeoutMs ? `, limit ${Math.round(timeoutMs / 60_000)} min` : ""}`,
  );
  let result;
  try {
    result = await run(config.claudeBin, args, {
      cwd,
      input: prompt,
      timeoutMs,
      env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
      onLine: (line) => {
        for (const step of describeClaudeLine(line))
          console.log(`${tag} ${step}`);
      },
    });
  } catch (err) {
    if (runDir && err.stdout !== undefined) {
      fs.writeFileSync(
        path.join(runDir, `${label}.stdout.txt`),
        err.stdout ?? "",
      );
      fs.writeFileSync(
        path.join(runDir, `${label}.stderr.txt`),
        err.stderr ?? "",
      );
    }
    pauseIfUsageLimit(err.stdout, err.stderr);
    throw err;
  }
  if (runDir)
    fs.writeFileSync(path.join(runDir, `${label}.stdout.jsonl`), result.stdout);

  pauseIfUsageLimit(result.stdout, result.stderr);
  const { result: parsed } = parseClaudeStream(result.stdout);
  if (!parsed) {
    throw new Error(
      `claude returned no result message:\n${tail(result.stdout)}\n${tail(result.stderr)}`,
    );
  }
  const text =
    typeof parsed.result === "string"
      ? parsed.result
      : JSON.stringify(parsed.result ?? "");
  let structured = parsed.structured_output ?? null;
  if (schema && !structured) structured = parseJsonBlock(text);
  if (typeof parsed.total_cost_usd === "number")
    processCostUsd += parsed.total_cost_usd;
  return {
    text,
    structured,
    isError: !!parsed.is_error,
    costUsd: parsed.total_cost_usd ?? null,
    turns: parsed.num_turns ?? null,
    durationMs: Date.now() - started,
    raw: parsed,
  };
}

/** Best-effort JSON extraction from model text (first balanced object). */
export function parseJsonBlock(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf("{");
    const end = c.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(c.slice(start, end + 1));
    } catch {}
  }
  return null;
}

export function renderPrompt(template, vars) {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    if (!(key in vars)) throw new Error(`prompt variable ${key} is missing`);
    return String(vars[key]);
  });
}

export function loadPrompt(name) {
  return fs.readFileSync(
    new URL(`./prompts/${name}.md`, import.meta.url),
    "utf8",
  );
}
