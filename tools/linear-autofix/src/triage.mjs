import { config } from "./config.mjs";
import { loadPrompt, renderPrompt, runClaude } from "./claude.mjs";
import * as linear from "./linear.mjs";
import { note, runDir, transition } from "./state.mjs";
import { FOOTER } from "./actions.mjs";

export const VERDICTS = Object.freeze([
  "fix",
  "browser_side",
  "needs_info",
  "ops_reply",
  "design_decision",
  "duplicate",
  "already_fixed",
]);

export const TRIAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "verdict",
    "confidence",
    "reason",
    "needs_windows",
    "size",
    "affected_paths",
    "repro_plan",
    "comment",
  ],
  properties: {
    verdict: { type: "string", enum: [...VERDICTS] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string" },
    needs_windows: { type: "boolean" },
    size: { type: "string", enum: ["S", "M", "L"] },
    affected_paths: { type: "array", items: { type: "string" } },
    repro_plan: { type: "string" },
    comment: { type: "string" },
  },
};

/** Validate and normalize a triage result. Throws on malformed input. */
export function validateTriage(raw) {
  if (!raw || typeof raw !== "object")
    throw new Error("triage result is not an object");
  if (!VERDICTS.includes(raw.verdict))
    throw new Error(`triage verdict invalid: ${raw.verdict}`);
  const confidence = Number(raw.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
    throw new Error(`triage confidence invalid: ${raw.confidence}`);
  if (typeof raw.reason !== "string" || !raw.reason.trim())
    throw new Error("triage reason missing");
  return {
    verdict: raw.verdict,
    confidence,
    reason: raw.reason.trim(),
    needs_windows: raw.needs_windows === true,
    size: ["S", "M", "L"].includes(raw.size) ? raw.size : "M",
    affected_paths: Array.isArray(raw.affected_paths)
      ? raw.affected_paths.map(String)
      : [],
    repro_plan: typeof raw.repro_plan === "string" ? raw.repro_plan.trim() : "",
    comment:
      typeof raw.comment === "string" && raw.comment.trim()
        ? raw.comment.trim()
        : raw.reason.trim(),
  };
}

export function renderTriageComment(t) {
  const lines = [
    `**自动分诊** · 结论 \`${t.verdict}\` · 置信度 ${t.confidence.toFixed(2)} · 规模 ${t.size}${t.needs_windows ? " · 需 Windows 验证" : ""}`,
    ``,
    t.comment,
  ];
  if (t.verdict === "fix" && t.repro_plan)
    lines.push(``, `**复现计划**`, ``, t.repro_plan);
  if (t.affected_paths.length)
    lines.push(
      ``,
      `涉及路径：${t.affected_paths.map((p) => `\`${p}\``).join(", ")}`,
    );
  lines.push(``, FOOTER);
  return lines.join("\n");
}

export async function triage(issue, record) {
  const dir = runDir(record.identifier, "triage");
  const prompt = renderPrompt(loadPrompt("triage"), {
    issue: linear.renderIssue(issue),
    baseBranch: `${config.remote}/${config.baseBranch}`,
  });
  const res = await runClaude({
    prompt,
    cwd: config.repoRoot,
    runDir: dir,
    label: "triage",
    allowedTools: [
      "Read",
      "Grep",
      "Glob",
      "Bash(git log *)",
      "Bash(git show *)",
      "Bash(git grep *)",
    ],
    budgetUsd: config.triageBudgetUsd,
    timeoutMs: config.triageTimeoutMs,
    schema: TRIAGE_SCHEMA,
  });
  if (res.isError)
    throw new Error(`triage run reported an error: ${res.text.slice(0, 500)}`);
  const triageResult = validateTriage(res.structured);
  record.triage = {
    ...triageResult,
    costUsd: res.costUsd,
    at: new Date().toISOString(),
    runDir: dir,
  };
  note(
    record,
    "triaged",
    `${triageResult.verdict} (${triageResult.confidence.toFixed(2)}) ${triageResult.reason}`,
  );

  await linear.comment(record, renderTriageComment(triageResult));
  if (triageResult.verdict === "fix") {
    await linear.addLabel(record, config.labels.fix);
    transition(record, "triaged");
  } else {
    await linear.addLabel(record, config.labels.skipped);
    record.lastSeenCommentCount = record.commentCount;
    transition(record, "skipped", triageResult.verdict);
  }
  return triageResult;
}
