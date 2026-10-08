import {
  chmod,
  cp,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { rollup } from "rollup";
import resolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(root));
const distDir = join(root, "dist");
const outDir = join(distDir, "out");
const bundledCliDir = outDir;
const bundledCli = join(bundledCliDir, "index.js");
// The usage guide printed by `ego-browser skill` and the site learnings the
// runtime reads next to the bundle, both versioned with this SDK.
const guideSource = join(root, "skill-body", "SKILL.md");
const learningsSource = join(root, "skill-body", "learnings");
const bundledGuideDir = join(outDir, "ego-browser");
// The thin entry Skill the browser installs into ~/.agents/skills/ego-browser.
const entrySkillSourceDir = join(repoRoot, "skills", "ego-browser");
const bundledEntrySkillDir = join(outDir, "agent-skills", "ego-browser");
const entrySkillEntries = [
  "SKILL.md",
  "references",
  "scripts",
  "agents",
  "assets",
];
// Claude Code keeps 30,000 characters of command output; leave headroom.
const maxGuideLength = 25_000;
const buildLock = join(root, ".build.lock");

let lock;
try {
  lock = await open(buildLock, "wx");
} catch (error) {
  if (error?.code === "EEXIST") {
    throw new Error("another ego-browser-v2 build is already running");
  }
  throw error;
}

try {
  await rm(distDir, { recursive: true, force: true });
  await rm(join(root, "artifacts"), { recursive: true, force: true });
  await rm(join(root, "ego-browser.js"), { force: true });
  await rm(join(root, "bin"), { recursive: true, force: true });
  await mkdir(bundledCliDir, { recursive: true });

  const common = {
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "info",
  };

  await build({
    ...common,
    entryPoints: await tsEntryPoints(["scripts", "src"]),
    outdir: "dist",
    outbase: ".",
    bundle: false,
    sourcemap: false,
    absWorkingDir: root,
  });

  const rollupConfig = {
    input: join(root, "src/index.ts"),
    external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
    plugins: [
      resolve(),
      typescript({
        tsconfig: join(root, "tsconfig.json"),
        compilerOptions: {
          noEmit: false,
          declaration: false,
          removeComments: false,
        },
      }),
    ],
  };
  const bundle = await rollup(rollupConfig);
  await bundle.write({ file: bundledCli, format: "esm", sourcemap: false });
  await bundle.close();

  await mkdir(bundledGuideDir, { recursive: true });
  await writeFile(
    join(bundledGuideDir, "SKILL.md"),
    renderGuide(await readFile(guideSource, "utf8")),
  );
  await cp(learningsSource, join(bundledGuideDir, "learnings"), {
    recursive: true,
  });
  for (const entry of entrySkillEntries) {
    await cp(
      join(entrySkillSourceDir, entry),
      join(bundledEntrySkillDir, entry),
      { recursive: true },
    );
  }
  await chmod(bundledCli, 0o755);
} finally {
  await lock.close();
  await rm(buildLock, { force: true });
}

// Replace the source frontmatter with the version line and end marker that
// `ego-browser skill` prints verbatim; agents use the marker to detect truncation.
function renderGuide(source) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
  const version = match && /^version: "([^"]+)"$/m.exec(match[1])?.[1];
  if (!version) {
    throw new Error(`${guideSource} needs frontmatter with a version`);
  }
  const guide = [
    `[ego-browser:skill] ego-browser usage guide v${version}`,
    "",
    match[2].trim(),
    "",
    `[ego-browser:skill] end of guide v${version}`,
    "",
  ].join("\n");
  if (guide.length > maxGuideLength) {
    throw new Error(
      `the bundled usage guide is ${guide.length} characters; keep it under ${maxGuideLength} so agents do not truncate it`,
    );
  }
  return guide;
}

async function tsEntryPoints(dirs) {
  const files = [];
  for (const dir of dirs) {
    files.push(...(await collectTsFiles(join(root, dir), dir)));
  }
  return files.sort();
}

async function collectTsFiles(absDir, relativeDir) {
  const entries = await readdir(absDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = `${relativeDir}/${entry.name}`;
    const absPath = join(absDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTsFiles(absPath, relativePath)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(relativePath);
    }
  }
  return files;
}
