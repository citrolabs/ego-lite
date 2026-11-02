import fs from "node:fs";
import path from "node:path";
import { config } from "./config.mjs";
import { run, tail } from "./proc.mjs";

/**
 * Run `claude -p` headless. The prompt goes in on stdin. Returns
 * { text, structured, costUsd, turns, raw }. Throws on timeout or a non-zero
 * exit; a Claude-side `is_error` result is returned with `isError: true`.
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
  allowedTools = [],
  restricted = false,
  budgetUsd,
  timeoutMs,
  schema,
  addDirs = [],
}) {
  const args = [
    "-p",
    "--output-format",
    "json",
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
  let result;
  try {
    result = await run(config.claudeBin, args, {
      cwd,
      input: prompt,
      timeoutMs,
      env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
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
    throw err;
  }
  if (runDir)
    fs.writeFileSync(path.join(runDir, `${label}.stdout.json`), result.stdout);

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `claude returned non-JSON output:\n${tail(result.stdout)}\n${tail(result.stderr)}`,
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
