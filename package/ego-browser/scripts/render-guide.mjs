// Renders `skill-body/SKILL.md` into the guides that `ego-browser skill` prints.
//
// The source is one file. Platform-specific passages sit between marker lines:
//
//   <!-- platform: windows -->
//   ...Markdown that only the Windows guide keeps...
//   <!-- /platform -->
//
// A marker may name several platforms (`<!-- platform: macos, windows -->`).
// Rendering a platform keeps the blocks that name it and drops the others; the
// platform-neutral `SKILL.md` keeps every block. Marker lines never reach the
// output. Prettier keeps a blank line on each side of a marker, so a block
// holds whole paragraphs, headings, or code fences, never part of a paragraph.
//
// Execution-mode passages work the same way with `<!-- mode: direct -->` or
// `<!-- mode: ego-run -->` ... `<!-- /mode -->`: `direct` is the guide for
// `ego-browser nodejs` (what the browser prints today), `ego-run` the guide for
// the persistent-session CLI. Every render picks exactly one mode. A mode block
// may sit inside a platform block and vice versa; blocks of the same kind do
// not nest.

export const guidePlatforms = ["macos", "windows"];
export const guideModes = ["direct", "ego-run"];
export const defaultGuideMode = "direct";

// Claude Code keeps 30,000 characters of command output; leave headroom.
export const maxGuideLength = 25_000;

const openPattern = /^\s*<!--\s*(platform|mode):\s*([a-z, -]+?)\s*-->\s*$/;
const closePattern = /^\s*<!--\s*\/(platform|mode)\s*-->\s*$/;

// `platform` is one of `guidePlatforms`, or `null` for the all-platform guide;
// `mode` is one of `guideModes`.
export function renderGuide(
  source,
  { platform = null, mode = defaultGuideMode, name = "guide" } = {},
) {
  if (platform !== null && !guidePlatforms.includes(platform)) {
    throw new Error(`unknown guide platform ${JSON.stringify(platform)}`);
  }
  if (!guideModes.includes(mode)) {
    throw new Error(`unknown guide mode ${JSON.stringify(mode)}`);
  }
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
  const version = match && /^version: "([^"]+)"$/m.exec(match[1])?.[1];
  if (!version) {
    throw new Error(`${name} needs frontmatter with a version`);
  }
  const tags = [platform, mode === defaultGuideMode ? null : mode].filter(
    Boolean,
  );
  const label = tags.length
    ? `v${version} (${tags.join(", ")})`
    : `v${version}`;
  const guide = [
    `[ego-browser:skill] ego-browser usage guide ${label}`,
    "",
    unwrapProse(selectBlocks(match[2], { platform, mode }, name).trim()),
    "",
    `[ego-browser:skill] end of guide v${version}`,
    "",
  ].join("\n");
  if (guide.length > maxGuideLength) {
    throw new Error(
      `the bundled ${platform ?? "all-platform"} usage guide is ${guide.length} characters; keep it under ${maxGuideLength} so agents do not truncate it`,
    );
  }
  return guide;
}

// Drop the platform and mode blocks that do not apply, and every marker line.
export function selectBlocks(
  markdown,
  { platform = null, mode = defaultGuideMode } = {},
  name = "guide",
) {
  const lines = [];
  const open = []; // enclosing blocks, innermost last: { kind, keep, line }
  markdown.split("\n").forEach((line, index) => {
    const opener = openPattern.exec(line);
    if (opener) {
      const [, kind, list] = opener;
      const values = list.split(",").map((entry) => entry.trim());
      const known = kind === "platform" ? guidePlatforms : guideModes;
      for (const entry of values) {
        if (!known.includes(entry)) {
          throw new Error(
            `${name}:${index + 1}: unknown ${kind} ${JSON.stringify(entry)}; use ${known.join(", ")}`,
          );
        }
      }
      const enclosing = open.find((block) => block.kind === kind);
      if (enclosing) {
        throw new Error(
          `${name}:${index + 1}: ${kind} blocks do not nest (opened at line ${enclosing.line})`,
        );
      }
      const keep =
        kind === "platform"
          ? platform === null || values.includes(platform)
          : values.includes(mode);
      open.push({ kind, keep, line: index + 1 });
      return;
    }
    const closer = closePattern.exec(line);
    if (closer) {
      const last = open.at(-1);
      if (!last || last.kind !== closer[1]) {
        throw new Error(
          `${name}:${index + 1}: ${closer[1]} block closed ${last ? `inside an open ${last.kind} block` : "twice"}`,
        );
      }
      open.pop();
      return;
    }
    if (open.every((block) => block.keep)) lines.push(line);
  });
  if (open.length) {
    throw new Error(
      `${name}:${open.at(-1).line}: ${open.at(-1).kind} block is never closed`,
    );
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

// The platform selection of the default (direct) mode.
export function selectPlatform(markdown, platform, name = "guide") {
  return selectBlocks(markdown, { platform }, name);
}

// Join soft-wrapped Markdown lines with a space, which renders identically.
// Code fences, headings, list items, tables, and blockquotes start new lines.
export function unwrapProse(markdown) {
  const startsBlock = /^\s*(```|#|[-*+] |\d+\. |\||>)/;
  const lines = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    const fence = /^\s*```/.test(line);
    const previous = lines.at(-1);
    if (
      !inFence &&
      !fence &&
      line.trim() &&
      previous?.trim() &&
      !startsBlock.test(line) &&
      !/^\s*(```|#|\|)/.test(previous)
    ) {
      lines[lines.length - 1] = `${previous} ${line.trim()}`;
    } else {
      lines.push(line);
    }
    if (fence) inFence = !inFence;
  }
  return lines.join("\n");
}
