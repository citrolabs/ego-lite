import { chmod, cp, mkdir, open, readdir, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { rollup } from "rollup";
import resolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(root, "dist");
const outDir = join(distDir, "out");
const bundledCliDir = outDir;
const bundledCli = join(bundledCliDir, "index.js");
const bundledSkillCli = join(bundledCliDir, "skill.js");
const skillSourceDir = join(root, "skill");
const bundledSkillDir = join(outDir, "ego-browser");
const buildLock = join(root, ".build.lock");
const bundledSkillEntries = ["GUIDE.md", "learnings", "topics"];

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
  for (const [input, file] of [
    ["src/index.ts", bundledCli],
    ["src/skill-cli.ts", bundledSkillCli],
  ]) {
    const bundle = await rollup({ ...rollupConfig, input: join(root, input) });
    await bundle.write({ file, format: "esm", sourcemap: false });
    await bundle.close();
  }

  await mkdir(bundledSkillDir, { recursive: true });
  for (const entry of bundledSkillEntries) {
    await cp(join(skillSourceDir, entry), join(bundledSkillDir, entry), {
      recursive: true,
    });
  }
  await chmod(bundledCli, 0o755);
  await chmod(bundledSkillCli, 0o755);
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
