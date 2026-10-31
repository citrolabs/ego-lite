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

export const guidePlatforms = ["macos", "windows"];

// Claude Code keeps 30,000 characters of command output; leave headroom.
export const maxGuideLength = 25_000;

const platformPattern = /^\s*<!--\s*platform:\s*([a-z, ]+?)\s*-->\s*$/;
const endPattern = /^\s*<!--\s*\/platform\s*-->\s*$/;

// `platform` is one of `guidePlatforms`, or `null` for the all-platform guide.
export function renderGuide(source, { platform = null, name = "guide" } = {}) {
  if (platform !== null && !guidePlatforms.includes(platform)) {
    throw new Error(`unknown guide platform ${JSON.stringify(platform)}`);
  }
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
  const version = match && /^version: "([^"]+)"$/m.exec(match[1])?.[1];
  if (!version) {
    throw new Error(`${name} needs frontmatter with a version`);
  }
  const label = platform ? `v${version} (${platform})` : `v${version}`;
  const guide = [
    `[ego-browser:skill] ego-browser usage guide ${label}`,
    "",
    unwrapProse(selectPlatform(match[2], platform, name).trim()),
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

// Drop the platform blocks that do not apply, and every marker line.
export function selectPlatform(markdown, platform, name = "guide") {
  const lines = [];
  let keep = null; // null outside a block, boolean inside
  let openedAt = 0;
  markdown.split("\n").forEach((line, index) => {
    const open = platformPattern.exec(line);
    if (open) {
      if (keep !== null) {
        throw new Error(
          `${name}:${index + 1}: platform blocks do not nest (opened at line ${openedAt})`,
        );
      }
      const platforms = open[1].split(",").map((entry) => entry.trim());
      for (const entry of platforms) {
        if (!guidePlatforms.includes(entry)) {
          throw new Error(
            `${name}:${index + 1}: unknown platform ${JSON.stringify(entry)}; use ${guidePlatforms.join(", ")}`,
          );
        }
      }
      keep = platform === null || platforms.includes(platform);
      openedAt = index + 1;
      return;
    }
    if (endPattern.test(line)) {
      if (keep === null) {
        throw new Error(`${name}:${index + 1}: platform block closed twice`);
      }
      keep = null;
      return;
    }
    if (keep !== false) lines.push(line);
  });
  if (keep !== null) {
    throw new Error(`${name}:${openedAt}: platform block is never closed`);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
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
