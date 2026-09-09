export type SnapshotFilterOptions = {
  interactiveOnly?: boolean;
  roles?: string[];
  match?: string | RegExp;
  maxChars?: number;
};

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "menuitem",
  "tab",
  "switch",
  "searchbox",
  "slider",
  "spinbutton",
  "option",
]);

const LANDMARK_ROLES = new Set([
  "heading",
  "banner",
  "complementary",
  "contentinfo",
  "form",
  "main",
  "navigation",
  "region",
  "search",
]);

function lineRoleMatches(line: string, role: string): boolean {
  const normalized = role.toLowerCase();
  const rolePattern = new RegExp(`\\brole=${normalized}\\b`, "i");
  const locPattern = new RegExp(
    `loc=role:${normalized}(?:\\[|[,\\s\\]]|$)`,
    "i",
  );
  return rolePattern.test(line) || locPattern.test(line);
}

function lineHasRef(line: string): boolean {
  return /\[ref=|\bref=\d+/.test(line);
}

function lineMatchesPattern(line: string, match: string | RegExp): boolean {
  if (typeof match === "string") {
    return line.toLowerCase().includes(match.toLowerCase());
  }
  return match.test(line);
}

function lineMatchesInteractiveOnly(line: string): boolean {
  for (const role of INTERACTIVE_ROLES) {
    if (lineRoleMatches(line, role)) return true;
  }
  if (!lineHasRef(line)) return false;
  for (const role of LANDMARK_ROLES) {
    if (lineRoleMatches(line, role)) return true;
  }
  return false;
}

function isMetadataHeaderLine(line: string): boolean {
  const trimmed = line.trim();
  return /^(Page:|URL:|Title:|Snapshot:)/i.test(trimmed);
}

function splitHeaderLines(lines: string[]): {
  header: string[];
  body: string[];
} {
  const header: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      if (header.length > 0) header.push(line);
      continue;
    }
    if (isMetadataHeaderLine(line)) {
      header.push(line);
      continue;
    }
    return { header, body: lines.slice(i) };
  }
  return { header, body: [] };
}

function hasLineFilters(options: SnapshotFilterOptions): boolean {
  return Boolean(
    options.interactiveOnly ||
    (options.roles && options.roles.length > 0) ||
    options.match != null,
  );
}

function shouldKeepLine(line: string, options: SnapshotFilterOptions): boolean {
  if (options.interactiveOnly && !lineMatchesInteractiveOnly(line)) {
    return false;
  }
  if (options.roles?.length) {
    const matchesRole = options.roles.some((role) =>
      lineRoleMatches(line, role),
    );
    if (!matchesRole) return false;
  }
  if (options.match != null && !lineMatchesPattern(line, options.match)) {
    return false;
  }
  return true;
}

function truncateContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const omitted = content.length - maxChars;
  return `${content.slice(0, maxChars)}\n… truncated (${omitted} chars omitted for maxChars=${maxChars})`;
}

/**
 * Post-process snapshot text to drop non-actionable lines and optionally cap size.
 */
export function filterSnapshotContent(
  content: string,
  options: SnapshotFilterOptions = {},
): string {
  if (!content) return content;
  if (!hasLineFilters(options) && options.maxChars == null) {
    return content;
  }

  let filtered = content;
  if (hasLineFilters(options)) {
    const lines = content.split("\n");
    const { header, body } = splitHeaderLines(lines);
    const keptBody = body.filter((line) => shouldKeepLine(line, options));
    filtered = [...header, ...keptBody].join("\n");
  }

  if (options.maxChars != null) {
    filtered = truncateContent(filtered, options.maxChars);
  }
  return filtered;
}
