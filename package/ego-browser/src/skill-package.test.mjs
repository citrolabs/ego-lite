import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  guidePlatforms,
  renderGuide,
  selectPlatform,
} from "../scripts/render-guide.mjs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const outDir = fileURLToPath(new URL("../dist/out/", import.meta.url));
const guideSource = fileURLToPath(
  new URL("../skill-body/SKILL.md", import.meta.url),
);

const codeFences = (markdown) => markdown.match(/^```[^\n]*\n[\s\S]*?^```$/gm);
const words = (markdown) => markdown.split(/\s+/).filter(Boolean);

const platformMarker = /^\s*<!--\s*\/?platform\b.*-->\s*$/gm;

test("the bundled usage guide is the unwrapped source guide between version and end markers", async () => {
  const bundled = await readFile(join(outDir, "ego-browser/SKILL.md"), "utf8");
  const source = await readFile(guideSource, "utf8");
  const version = /^version: "([^"]+)"$/m.exec(source)[1];
  const lines = bundled.trimEnd().split("\n");

  assert.deepEqual((await readdir(join(outDir, "ego-browser"))).sort(), [
    "SKILL.macos.md",
    "SKILL.md",
    "SKILL.windows.md",
  ]);
  assert.equal(
    lines[0],
    `[ego-browser:skill] ego-browser usage guide v${version}`,
  );
  assert.equal(lines.at(-1), `[ego-browser:skill] end of guide v${version}`);
  const body = source
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(platformMarker, "")
    .trim();
  const bundledBody = lines.slice(2, -2).join("\n");
  assert.deepEqual(words(bundledBody), words(body));
  assert.deepEqual(codeFences(bundledBody), codeFences(body));
  assert.ok(bundledBody.split("\n").length < body.split("\n").length);
  assert.ok(!/^ {2,}\S/m.test(bundledBody.replace(/^```[\s\S]*?^```$/gm, "")));
  assert.ok(!/<!--/.test(bundled));
  assert.ok(bundled.length <= 25_000);
});

test("each platform guide keeps only its own passages", async () => {
  const source = await readFile(guideSource, "utf8");
  const version = /^version: "([^"]+)"$/m.exec(source)[1];
  const all = await readFile(join(outDir, "ego-browser/SKILL.md"), "utf8");
  const sourceBody = source.replace(/^---\n[\s\S]*?\n---\n/, "");
  const guides = {};
  for (const platform of guidePlatforms) {
    const guide = await readFile(
      join(outDir, `ego-browser/SKILL.${platform}.md`),
      "utf8",
    );
    const lines = guide.trimEnd().split("\n");
    assert.equal(
      lines[0],
      `[ego-browser:skill] ego-browser usage guide v${version} (${platform})`,
    );
    assert.equal(lines.at(-1), `[ego-browser:skill] end of guide v${version}`);
    assert.ok(!/<!--/.test(guide));
    assert.ok(guide.length <= 25_000);
    // The platform guide is the source with the other platforms' blocks removed.
    const expected = selectPlatform(sourceBody, platform).trim();
    const bundledBody = lines.slice(2, -2).join("\n");
    assert.deepEqual(words(bundledBody), words(expected));
    assert.deepEqual(codeFences(bundledBody), codeFences(expected));
    assert.ok(words(bundledBody).length <= words(all).length);
    guides[platform] = guide;
  }
  assert.match(guides.windows, /^### Bash, Zsh, Git Bash$/m);
  assert.match(guides.windows, /^### PowerShell$/m);
  assert.match(guides.windows, /^### cmd$/m);
  assert.match(guides.windows, /forward slashes/);
  assert.match(guides.macos, /^ego-browser nodejs <<'EOF'$/m);
  assert.doesNotMatch(
    guides.macos,
    /PowerShell|### cmd|Get-Content|forward slashes/,
  );
  assert.ok(guides.macos.length < guides.windows.length);
});

test("renderGuide selects platform blocks and strips the markers", () => {
  const source = [
    "---",
    'version: "9.9.9"',
    "---",
    "Shared start.",
    "<!-- platform: windows -->",
    "Windows only, same paragraph.",
    "<!-- /platform -->",
    "",
    "<!-- platform: macos -->",
    "## macOS heading",
    "<!-- /platform -->",
    "",
    "<!-- platform: macos, windows -->",
    "Both.",
    "<!-- /platform -->",
    "",
  ].join("\n");
  const body = (platform) =>
    renderGuide(source, { platform })
      .trim()
      .split("\n")
      .slice(2, -2)
      .join("\n");
  assert.equal(
    body("windows"),
    "Shared start. Windows only, same paragraph.\n\nBoth.",
  );
  assert.equal(body("macos"), "Shared start.\n\n## macOS heading\n\nBoth.");
  assert.equal(
    body(null),
    "Shared start. Windows only, same paragraph.\n\n## macOS heading\n\nBoth.",
  );
  assert.match(
    renderGuide(source, { platform: "macos" }),
    /^\[ego-browser:skill\] ego-browser usage guide v9\.9\.9 \(macos\)\n/,
  );
  assert.match(
    renderGuide(source),
    /^\[ego-browser:skill\] ego-browser usage guide v9\.9\.9\n/,
  );
  assert.throws(
    () => renderGuide(source, { platform: "linux" }),
    /unknown guide platform/,
  );
});

test("selectPlatform rejects malformed platform blocks", () => {
  assert.throws(
    () => selectPlatform("<!-- platform: windows -->\nx", "macos"),
    /never closed/,
  );
  assert.throws(
    () => selectPlatform("x\n<!-- /platform -->", "macos"),
    /closed twice/,
  );
  assert.throws(
    () =>
      selectPlatform(
        "<!-- platform: windows -->\n<!-- platform: macos -->\n<!-- /platform -->\n<!-- /platform -->",
        "macos",
      ),
    /do not nest/,
  );
  assert.throws(
    () =>
      selectPlatform("<!-- platform: linux -->\n<!-- /platform -->", "macos"),
    /unknown platform "linux"/,
  );
});

test("the bundled entry Skill matches the published entry Skill", async () => {
  const entry = join(outDir, "agent-skills/ego-browser");
  assert.deepEqual((await readdir(entry)).sort(), [
    "SKILL.md",
    "agents",
    "assets",
    "learnings",
    "references",
    "scripts",
  ]);
  assert.deepEqual((await readdir(join(entry, "references"))).sort(), [
    "clearing-state.md",
    "install-macos.md",
    "install-windows.md",
    "install.md",
  ]);
  assert.equal(
    await readFile(join(entry, "SKILL.md"), "utf8"),
    await readFile(join(repoRoot, "skills/ego-browser/SKILL.md"), "utf8"),
  );
  assert.deepEqual(
    (await readdir(join(entry, "learnings"))).sort(),
    (await readdir(join(repoRoot, "skills/ego-browser/learnings"))).sort(),
  );
});

test("the entry Skill defers usage to ego-browser skill", async () => {
  const entry = await readFile(
    join(repoRoot, "skills/ego-browser/SKILL.md"),
    "utf8",
  );
  assert.match(entry, /^\s+bootstrap: "true"$/m);
  assert.match(entry, /^ego-browser skill$/m);
  assert.match(entry, /\[ego-browser:skill\] end of guide/);
  assert.match(entry, /references\/install\.md/);
  assert.match(entry, /references\/install-macos\.md/);
  assert.match(entry, /references\/install-windows\.md/);
  assert.match(entry, /references\/clearing-state\.md/);
});

test("the shared install guide routes to a file per operating system", async () => {
  const references = join(repoRoot, "skills/ego-browser/references");
  const shared = await readFile(join(references, "install.md"), "utf8");
  assert.match(shared, /\(install-macos\.md\)/);
  assert.match(shared, /\(install-windows\.md\)/);
  assert.doesNotMatch(shared, /PowerShell|install\.sh|SmartScreen|Gatekeeper/);
  const macos = await readFile(join(references, "install-macos.md"), "utf8");
  assert.match(macos, /scripts\/install\.sh/);
  assert.doesNotMatch(macos, /PowerShell|SmartScreen/);
  const windows = await readFile(
    join(references, "install-windows.md"),
    "utf8",
  );
  assert.match(windows, /PowerShell/);
  assert.doesNotMatch(windows, /install\.sh|Gatekeeper/);
});

test("project Agent and Codex entries share the canonical Skill", async () => {
  for (const directory of [".agents", ".codex"]) {
    assert.equal(
      await readlink(join(repoRoot, directory, "skills/ego-browser")),
      "../../skills/ego-browser",
    );
  }
});
