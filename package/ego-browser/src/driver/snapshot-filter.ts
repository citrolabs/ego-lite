export type SnapshotUrlMode = "none" | "host_path";

export type SnapshotFilterOptions = {
  interactiveOnly?: boolean;
  roles?: string[];
  match?: string | RegExp;
  maxChars?: number;
  urls?: SnapshotUrlMode;
};

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "anchor",
  "textbox",
  "textfield",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "searchbox",
  "slider",
  "spinbutton",
  "option",
  "treeitem",
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
  "article",
  "dialog",
  "alertdialog",
]);

// The snapshot printer uses DOM-ish names for some ARIA roles (`anchor`, `img`,
// `textfield`), so asking for the ARIA name must still match the printed token.
const ROLE_ALIASES: Record<string, string[]> = {
  anchor: ["link"],
  link: ["anchor"],
  image: ["img"],
  img: ["image"],
  textbox: ["textfield"],
  textfield: ["textbox"],
};

// The role is the leading token of a snapshot body line, e.g.
//   anchor "Home" [ref=10, loc=..., url=...]
//   container [ref=1]
// Requiring a name or a metadata bracket after the token keeps prose such as
// `Button to checkout` from being mistaken for a button element.
const LEADING_ROLE = /^\s*([a-z][a-z0-9_-]*)(?=\s*(?:"|\[|$))/i;

function leadingRole(line: string): string | null {
  const match = LEADING_ROLE.exec(line);
  return match ? match[1].toLowerCase() : null;
}

function declaredRoles(line: string): string[] {
  const roles: string[] = [];
  for (const match of line.matchAll(/\brole=([a-z][a-z0-9_-]*)\b/gi)) {
    roles.push(match[1].toLowerCase());
  }
  for (const match of line.matchAll(/loc=role:([a-z][a-z0-9_-]*)/gi)) {
    roles.push(match[1].toLowerCase());
  }
  return roles;
}

function roleMatches(candidate: string, role: string): boolean {
  const normalized = role.toLowerCase();
  if (candidate === normalized) return true;
  return (ROLE_ALIASES[normalized] || []).includes(candidate);
}

function lineRoleMatches(line: string, role: string): boolean {
  const leading = leadingRole(line);
  if (leading && roleMatches(leading, role)) return true;
  return declaredRoles(line).some((declared) => roleMatches(declared, role));
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

// Structural lines are printed outside the element tree but still carry
// meaning: the `[p1 ...]` page header and hints such as
// `[more content below the viewport ...]`.
function isPageHeaderLine(line: string): boolean {
  return /^\[p\d+\b/i.test(line.trim());
}

function isNoticeLine(line: string): boolean {
  return /^\s*\[[^\]]*(?:more content|below the viewport|content omitted|truncated)[^\]]*\]/i.test(
    line,
  );
}

function isMetadataHeaderLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    /^(Page:|URL:|Title:|Snapshot:)/i.test(trimmed) || isPageHeaderLine(trimmed)
  );
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
  if (isNoticeLine(line)) return true;
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

function findMatchingBracket(line: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\") {
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "[") {
      depth++;
    } else if (ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Locate the trailing `[ref=..., loc=..., url=...]` annotation. The scan is
// quote-aware so a `url=` inside an accessible name is never touched, and the
// matching close bracket accounts for nested `loc=css:a[aria-label="..."]`.
function findMetadataBracket(
  line: string,
): { open: number; close: number } | null {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\") {
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch !== "[") continue;
    if (!/^(?:ref|loc|url)=/.test(line.slice(i + 1))) continue;
    const close = findMatchingBracket(line, i);
    return close === -1 ? null : { open: i, close };
  }
  return null;
}

const METADATA_KEY =
  /^\s*(?:ref|loc|url|role|name|href|action|value|type|title|id)\s*=/;

function splitMetadataParts(inner: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      if (ch === "\\") {
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "[") {
      depth++;
      continue;
    }
    if (ch === "]") {
      depth--;
      continue;
    }
    if (ch !== "," || depth !== 0) continue;
    // Only split when the next token is another metadata key; an unquoted URL
    // may legitimately contain commas in its query string.
    if (!METADATA_KEY.test(inner.slice(i + 1))) continue;
    parts.push(inner.slice(start, i));
    start = i + 1;
  }
  parts.push(inner.slice(start));
  return parts;
}

function toHostPath(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return value;
    return `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
}

function rewriteUrlValue(raw: string): string {
  const trimmed = raw.trim();
  const quote =
    trimmed[0] === '"' || trimmed[0] === "'" ? trimmed[0] : undefined;
  const value = quote ? trimmed.slice(1, -1) : trimmed;
  const rewritten = toHostPath(value);
  return quote ? `${quote}${rewritten}${quote}` : rewritten;
}

function rewriteUrlMetadata(line: string, mode: SnapshotUrlMode): string {
  const span = findMetadataBracket(line);
  if (!span) return line;
  const inner = line.slice(span.open + 1, span.close);
  const kept: string[] = [];
  let changed = false;
  for (const part of splitMetadataParts(inner)) {
    const match = /^\s*url\s*=\s*(.*)$/s.exec(part);
    if (!match) {
      kept.push(part);
      continue;
    }
    changed = true;
    if (mode === "none") continue;
    kept.push(`url=${rewriteUrlValue(match[1])}`);
  }
  if (!changed) return line;
  if (kept.length === 0) {
    const before = line.slice(0, span.open).replace(/\s+$/, "");
    const after = line.slice(span.close + 1).replace(/^\s+/, "");
    return `${before}${after ? ` ${after}` : ""}`;
  }
  const normalized = kept.map((part) => part.trim()).join(", ");
  return `${line.slice(0, span.open + 1)}${normalized}${line.slice(span.close)}`;
}

function collectTrailingNotices(content: string): string[] {
  const lines = content.split("\n");
  const notices: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (!isNoticeLine(line)) break;
    notices.unshift(line);
  }
  return notices;
}

function truncateContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const lines = content.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = kept.length === 0 ? line.length : line.length + 1;
    if (used + cost > maxChars) break;
    kept.push(line);
    used += cost;
  }
  // Never cut inside the first line: the page header identifies the document
  // even when maxChars is smaller than that single line.
  if (kept.length === 0 && lines.length > 0) kept.push(lines[0]);

  const keptText = kept.join("\n");
  const trailing = collectTrailingNotices(content).filter(
    (notice) => !keptText.includes(notice),
  );
  const omitted = content.length - keptText.length;
  const note = `… truncated (${omitted} chars omitted for maxChars=${maxChars})`;
  return [keptText, ...trailing, note].join("\n");
}

/**
 * Post-process snapshot text to drop non-actionable lines, shrink URL metadata,
 * and optionally cap size.
 */
export function filterSnapshotContent(
  content: string,
  options: SnapshotFilterOptions = {},
): string {
  if (!content) return content;
  const lineFilters = hasLineFilters(options);
  const rewriteUrls = options.urls === "none" || options.urls === "host_path";
  if (!lineFilters && !rewriteUrls && options.maxChars == null) {
    return content;
  }

  let lines = content.split("\n");
  if (lineFilters) {
    const { header, body } = splitHeaderLines(lines);
    lines = [
      ...header,
      ...body.filter((line) => shouldKeepLine(line, options)),
    ];
  }
  if (rewriteUrls) {
    lines = lines.map((line) => rewriteUrlMetadata(line, options.urls!));
  }

  let filtered = lines.join("\n");
  if (options.maxChars != null) {
    filtered = truncateContent(filtered, options.maxChars);
  }
  return filtered;
}
