import {
  chmod,
  cp,
  mkdir,
  open,
  readFile,
  readdir,
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

import { extractHelpDocs } from "./extract-help-docs.mjs";

const HELP_DOCS_PLACEHOLDER = '"__EGO_EMBEDDED_HELP_DOCS__"';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(root));
const distDir = join(root, "dist");
const outDir = join(distDir, "out");
const bundledCliDir = outDir;
const bundledCli = join(bundledCliDir, "index.js");
const skillSourceDir = join(repoRoot, "skills", "ego-browser");
const bundledSkillDir = join(outDir, "ego-browser");
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
    external: [
      ...builtinModules,
      ...builtinModules.map((m) => `node:${m}`),
      "ws",
    ],
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

  await embedHelpDocs(bundledCli, join(distDir, "src", "help-runtime.js"));

  await cp(skillSourceDir, bundledSkillDir, { recursive: true });
  await chmod(bundledCli, 0o755);
} finally {
  await lock.close();
  await rm(buildLock, { force: true });
}

async function embedHelpDocs(...files) {
  // The docs are extracted from the emitted bundle (it carries every helper's
  // JSDoc with comments preserved) and injected into each build artifact that
  // ships help-runtime, replacing the placeholder string constant. Doing this
  // at build time means the runtime never has to read its own source. See
  // GitHub issue #84.
  const bundleSource = await readFile(files[0], "utf-8");
  const docs = extractHelpDocs(bundleSource);
  if (docs.length === 0) {
    throw new Error("embedHelpDocs: extracted 0 helper docs from the bundle");
  }
  const injected = JSON.stringify(JSON.stringify(docs));
  for (const file of files) {
    const source = await readFile(file, "utf-8");
    if (!source.includes(HELP_DOCS_PLACEHOLDER)) {
      throw new Error(`embedHelpDocs: placeholder not found in ${file}`);
    }
    // Use a replacer function so `$` sequences in the JSON are inserted literally.
    await writeFile(
      file,
      source.replace(HELP_DOCS_PLACEHOLDER, () => injected),
    );
  }
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
