#!/usr/bin/env node
// Build the official plugin index: one self-contained JSON bundle per plugin
// version plus index.json listing every version with its integrity hash.
//
//   node scripts/build-index.mjs [outDir]      (default: dist)
//
// Bundles already present in outDir/bundles are kept and stay listed, so a
// published version remains installable (and pinnable) after newer releases.
// The file selection and the integrity hash must match the ego-browser
// runtime (package/ego-browser/src/plugins/store.ts and manifest.ts), which
// re-hashes installed plugins to detect modified files.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST_FILE = "ego-plugin.json";
const SKIPPED_NAMES = new Set(["node_modules", ".git", "test", "tests"]);
const INCLUDED = /\.(m?js|json|md|txt)$/;

export function buildPluginIndex({ sourceDir, outDir, revokedPath }) {
  const bundlesDir = join(outDir, "bundles");
  mkdirSync(bundlesDir, { recursive: true });
  for (const name of readdirSync(sourceDir).sort()) {
    const dir = join(sourceDir, name);
    if (!statSync(dir).isDirectory() || !existsSync(join(dir, MANIFEST_FILE))) {
      continue;
    }
    const bundle = bundleFromDirectory(dir);
    if (bundle.manifest.id !== name) {
      throw new Error(
        `${dir}: directory name must equal the plugin id ${bundle.manifest.id}`,
      );
    }
    const file = join(
      bundlesDir,
      `${bundle.manifest.id}-${bundle.manifest.version}.json`,
    );
    if (existsSync(file)) {
      const published = JSON.parse(readFileSync(file, "utf8"));
      if (integrity(published) !== integrity(bundle)) {
        throw new Error(
          `${bundle.manifest.id}@${bundle.manifest.version} was already published with different content; bump the version`,
        );
      }
      continue;
    }
    writeFileSync(file, `${JSON.stringify(bundle)}\n`);
  }

  const plugins = new Map();
  for (const name of readdirSync(bundlesDir).sort()) {
    if (!name.endsWith(".json")) continue;
    const bundle = JSON.parse(readFileSync(join(bundlesDir, name), "utf8"));
    const { manifest } = bundle;
    const entry = plugins.get(manifest.id) || {
      id: manifest.id,
      versions: [],
    };
    entry.versions.push({
      version: manifest.version,
      integrity: integrity(bundle),
      bundle: `bundles/${name}`,
      manifest,
    });
    plugins.set(manifest.id, entry);
  }
  const index = {
    format: 1,
    plugins: [...plugins.values()].map((plugin) => {
      plugin.versions.sort((a, b) => compareVersions(b.version, a.version));
      const latest = plugin.versions[0].manifest;
      return {
        id: plugin.id,
        name: latest.name,
        description: latest.description,
        domains: latest.domains,
        versions: plugin.versions,
      };
    }),
    revoked:
      revokedPath && existsSync(revokedPath)
        ? JSON.parse(readFileSync(revokedPath, "utf8"))
        : [],
  };
  writeFileSync(
    join(outDir, "index.json"),
    `${JSON.stringify(index, null, 2)}\n`,
  );
  return index;
}

function bundleFromDirectory(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8"));
  for (const field of ["id", "version", "domains", "commands"]) {
    if (!manifest[field])
      throw new Error(`${dir}: ${MANIFEST_FILE} needs ${field}`);
  }
  const files = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || SKIPPED_NAMES.has(entry.name)) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      const name = relative(dir, path).split(sep).join("/");
      if (!entry.isFile() || name === MANIFEST_FILE || !INCLUDED.test(name))
        continue;
      files[name] = readFileSync(path, "utf8");
    }
  };
  walk(dir);
  for (const [name, command] of Object.entries(manifest.commands)) {
    if (files[command.entry] === undefined) {
      throw new Error(
        `${dir}: command ${name} entry ${command.entry} does not exist`,
      );
    }
  }
  return { format: 1, manifest, files };
}

function integrity(bundle) {
  const canonical = stableStringify({
    format: bundle.format,
    manifest: bundle.manifest,
    files: bundle.files,
  });
  return `sha256-${createHash("sha256").update(canonical).digest("hex")}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return Math.sign(a[index] - b[index]);
  }
  return 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const outDir = resolve(process.argv[2] || join(root, "dist"));
  const index = buildPluginIndex({
    sourceDir: join(root, "plugins"),
    outDir,
    revokedPath: join(root, "revoked.json"),
  });
  console.log(
    `wrote ${join(outDir, "index.json")}: ${index.plugins
      .map((plugin) => `${plugin.id}@${plugin.versions[0].version}`)
      .join(", ")}`,
  );
}
