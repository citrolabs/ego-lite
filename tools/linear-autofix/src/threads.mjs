import { config } from "./config.mjs";

/**
 * Split the unresolved review threads into the ones that need the bot's
 * attention (`fresh`: the latest comment is not a bot reply) and the ones the
 * bot already answered without resolving (`awaitingHuman`). Both kinds keep
 * the PR from being done; only `fresh` ones trigger a fix round. Human
 * comments made from the bot's own GitHub account are indistinguishable by
 * author, so bot replies are recognized by the marker they carry.
 */
export function splitThreads(threads, marker = config.botMarker) {
  const fresh = [];
  const awaitingHuman = [];
  for (const t of threads ?? []) {
    if (t.isResolved) continue;
    const comments = t.comments?.nodes ?? [];
    if (!comments.length) continue;
    const last = newestComment(comments);
    (String(last.body ?? "").includes(marker) ? awaitingHuman : fresh).push(t);
  }
  return { fresh, awaitingHuman };
}

/** The comment with the latest createdAt; falls back to array order when timestamps are missing. */
function newestComment(comments) {
  return comments.reduce((best, c) =>
    String(c.createdAt ?? "") >= String(best.createdAt ?? "") ? c : best,
  );
}

/** Unresolved threads that need the bot's attention. */
export function actionableThreads(threads, marker = config.botMarker) {
  return splitThreads(threads, marker).fresh;
}

export function renderThreads(threads) {
  return threads
    .map((t) => {
      const where = t.path
        ? `${t.path}${t.line ? `:${t.line}` : ""}`
        : "(general)";
      const body = (t.comments?.nodes ?? [])
        .map(
          (c) =>
            `> **${c.author?.login ?? "unknown"}**: ${c.body.trim().replace(/\n/g, "\n> ")}`,
        )
        .join("\n>\n");
      return `### Thread \`${t.id}\` · ${where}${t.isOutdated ? " · (outdated diff)" : ""}\n\n${body}`;
    })
    .join("\n\n");
}

/**
 * Human comments in the PR conversation (not review threads) newer than
 * `since`: everything that is not a bot comment and not a Codex review. The
 * bot answers them with its round summary and remembers the newest timestamp,
 * so each comment is acted on once. Pure.
 */
export function freshPrComments(
  comments,
  since,
  { botMarker = config.botMarker, codexMarker = config.codexMarker } = {},
) {
  return (comments ?? [])
    .filter((c) => {
      const body = String(c.body ?? "");
      if (body.includes(botMarker) || body.includes(codexMarker)) return false;
      if (c.author?.login?.endsWith("[bot]")) return false;
      return !since || String(c.createdAt ?? "") > since;
    })
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

export function renderPrComments(comments) {
  return comments
    .map(
      (c) =>
        `### ${c.author?.login ?? "unknown"} · ${c.createdAt}\n\n${String(c.body ?? "").trim()}`,
    )
    .join("\n\n");
}
