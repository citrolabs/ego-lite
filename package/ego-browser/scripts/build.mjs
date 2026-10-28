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

import { guideModes, guidePlatforms, renderGuide } from "./render-guide.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(root));
const distDir = join(root, "dist");
const outDir = join(distDir, "out");
const bundledCliDir = outDir;
const bundledCli = join(bundledCliDir, "index.js");
// The usage guide printed by `ego-browser skill`, versioned with this SDK.
const guideSource = join(root, "skill-body", "SKILL.md");
const bundledGuideDir = join(outDir, "ego-browser");
// The entry Skill the browser installs into ~/.agents/skills/ego-browser. It
// carries the site learnings, which the runtime also reads from this copy.
const entrySkillSourceDir = join(repoRoot, "skills", "ego-browser");
const bundledEntrySkillDir = join(outDir, "agent-skills", "ego-browser");
const entrySkillEntries = [
  "SKILL.md",
  "references",
  "scripts",
  "agents",
  "assets",
  "learnings",
];
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

  // `SKILL.md` keeps every platform's passages, for launchers that do not
  // pick a platform guide; `SKILL.<platform>.md` drops the others'.
  await mkdir(bundledGuideDir, { recursive: true });
  const guideMarkdown = await readFile(guideSource, "utf8");
  await writeFile(
    join(bundledGuideDir, "SKILL.md"),
    renderGuide(guideMarkdown, { name: guideSource }),
  );
  for (const platform of guidePlatforms) {
    await writeFile(
      join(bundledGuideDir, `SKILL.${platform}.md`),
      renderGuide(guideMarkdown, { platform, name: guideSource }),
    );
  }
  // The same guide for the persistent-session CLI (`ego-run --session`), under
  // `ego-browser/<mode>/`; the browser keeps printing the direct guide above.
  for (const mode of guideModes.filter((entry) => entry !== "direct")) {
    const modeDir = join(bundledGuideDir, mode);
    await mkdir(modeDir, { recursive: true });
    await writeFile(
      join(modeDir, "SKILL.md"),
      renderGuide(guideMarkdown, { mode, name: guideSource }),
    );
    for (const platform of guidePlatforms) {
      await writeFile(
        join(modeDir, `SKILL.${platform}.md`),
        renderGuide(guideMarkdown, { platform, mode, name: guideSource }),
      );
    }
  }
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
