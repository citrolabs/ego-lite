import { config } from "./config.mjs";

/**
 * Unresolved review threads whose latest comment is not a bot reply. Human
 * comments made from the bot's own GitHub account are indistinguishable by
 * author, so bot replies are recognized by the marker they carry.
 */
export function actionableThreads(threads, marker = config.botMarker) {
  return (threads ?? []).filter((t) => {
    if (t.isResolved) return false;
    const comments = t.comments?.nodes ?? [];
    if (!comments.length) return false;
    const last = comments[comments.length - 1];
    return !String(last.body ?? "").includes(marker);
  });
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
