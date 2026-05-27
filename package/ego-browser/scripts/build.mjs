import { chmod, mkdir, open, readdir, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { rollup } from "rollup";
import resolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(root, "dist");
const artifactsDir = join(root, "artifacts");
const bundledCliDir = join(artifactsDir, "ego-browser");
const bundledCli = join(bundledCliDir, "index.js");
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
  await rm(artifactsDir, { recursive: true, force: true });
  await rm(join(root, "ego-browser.js"), { force: true });
  await rm(join(root, "bin"), { recursive: true, force: true });
  await mkdir(bundledCliDir, { recursive: true });

  const common = {
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "info"
  };

  await build({
    ...common,
    entryPoints: await tsEntryPoints(["scripts", "src"]),
    outdir: "dist",
    outbase: ".",
    bundle: false,
    sourcemap: false,
    absWorkingDir: root
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
          removeComments: false
        }
      })
    ]
  };
  const bundle = await rollup(rollupConfig);
  await bundle.write({ file: bundledCli, format: "esm", sourcemap: false });
  await bundle.close();

  await chmod(bundledCli, 0o755);
} finally {
  await lock.close();
  await rm(buildLock, { force: true });
}

async function tsEntryPoints(dirs) {
  const files = [];
  for (const dir of dirs) {
    files.push(...await collectTsFiles(join(root, dir), dir));
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
      files.push(...await collectTsFiles(absPath, relativePath));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(relativePath);
    }
  }
  return files;
}
