import { mkdir, rm, readdir, copyFile } from "node:fs/promises";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcRoot = join(root, "src");
const dist = join(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

async function collectByExt(dir, ext) {
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await collectByExt(p, ext)));
    else if (ent.name.endsWith(ext) && !ent.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const entries = await collectByExt(srcRoot, ".ts");
await build({
  entryPoints: entries,
  outdir: dist,
  outbase: srcRoot,
  platform: "node",
  format: "esm",
  target: "node22",
  bundle: false,
  sourcemap: true,
});

// Copy non-TS fixtures so tests can load them via import.meta.url
const fixtures = await collectByExt(srcRoot, ".json");
for (const file of fixtures) {
  const rel = relative(srcRoot, file);
  const dest = join(dist, rel);
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(file, dest);
}

console.log(
  `built ${entries.length} files → dist/` +
    (fixtures.length ? ` (+${fixtures.length} fixtures)` : ""),
);
