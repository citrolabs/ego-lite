import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { bundledPluginIndexPath, pluginHomeDir } from "../env.js";
import { PluginError } from "./errors.js";
import {
  assertPluginId,
  MANIFEST_FILE,
  bundleIntegrity,
  compareVersions,
  isApiCompatible,
  majorOf,
  validateManifest,
  type PluginBundle,
  type PluginManifest,
} from "./manifest.js";

/**
 * On-disk plugin state:
 *
 *   ~/.ego-browser/plugins/
 *     package.json                 {"type":"module"} so .js entries load as ESM
 *     installed/<id>/<version>/    one directory per installed version
 *     local/<any>/ego-plugin.json  plugins under development or cloned by hand
 *     lock.json                    active version, source, integrity, pin
 *     index-cache.json             last official index fetched from the network
 *
 * Every function here is synchronous or a short network call; nothing keeps
 * the short-lived round process alive after it returns.
 */

export const DEFAULT_OFFICIAL_INDEX_URL =
  "https://raw.githubusercontent.com/citrolabs/ego-plugins/main/dist/index.json";
export const INDEX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;

export type PluginSource = "official" | "third-party" | "local";

export type IndexVersion = {
  version: string;
  integrity: string;
  bundle: string;
  manifest: PluginManifest;
};

export type IndexPlugin = {
  id: string;
  name?: string;
  description?: string;
  domains: string[];
  versions: IndexVersion[];
};

export type Revocation = {
  id: string;
  versions?: string[] | "*";
  integrity?: string;
  reason?: string;
};

export type PluginIndex = {
  format: 1;
  plugins: IndexPlugin[];
  revoked?: Revocation[];
};

/** Official index after merging the bundled baseline with the network copy. */
export type CatalogPlugin = Omit<IndexPlugin, "versions"> & {
  versions: ResolvedIndexVersion[];
};

export type OfficialCatalog = {
  plugins: Map<string, CatalogPlugin>;
  revoked: Revocation[];
};

type ResolvedIndexVersion = IndexVersion & { bundleUrl: string };

export type LockEntry = {
  version: string;
  source: Exclude<PluginSource, "local">;
  integrity: string;
  origin?: string;
  pinned?: boolean;
  previous?: { version: string; integrity: string };
  installedAt: string;
};

export type Lockfile = { format: 1; plugins: Record<string, LockEntry> };

type IndexCache = {
  url?: string;
  attemptedAt?: number;
  fetchedAt?: number;
  index?: PluginIndex;
  error?: string;
};

export function pluginPaths(home = pluginHomeDir()) {
  return {
    home,
    installed: join(home, "installed"),
    local: join(home, "local"),
    lock: join(home, "lock.json"),
    indexCache: join(home, "index-cache.json"),
    hints: join(home, "hints-seen.json"),
  };
}

function ensureHome(): ReturnType<typeof pluginPaths> {
  const paths = pluginPaths();
  mkdirSync(paths.installed, { recursive: true });
  mkdirSync(paths.local, { recursive: true });
  const packageJson = join(paths.home, "package.json");
  if (!existsSync(packageJson)) {
    writeFileSync(packageJson, '{ "type": "module" }\n');
  }
  return paths;
}

export function readJsonFile<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Write through a temporary file so a crash never leaves half a JSON file. */
export function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

export function readLock(): Lockfile {
  const lock = readJsonFile<Lockfile>(pluginPaths().lock);
  if (!lock || lock.format !== 1 || typeof lock.plugins !== "object") {
    return { format: 1, plugins: {} };
  }
  return lock;
}

export function writeLock(lock: Lockfile): void {
  ensureHome();
  writeJsonFile(pluginPaths().lock, lock);
}

// ---------------------------------------------------------------------------
// Official index

function officialIndexUrl(): string | undefined {
  const configured = process.env.EGO_BROWSER_PLUGIN_INDEX;
  if (configured === undefined || configured === "") {
    return DEFAULT_OFFICIAL_INDEX_URL;
  }
  if (["0", "off", "false", "none"].includes(configured.toLowerCase())) {
    return undefined;
  }
  return configured;
}

function readIndexCache(): IndexCache {
  return readJsonFile<IndexCache>(pluginPaths().indexCache) || {};
}

/** True when the network index was not attempted in the last 24 hours. */
export function officialIndexIsStale(now = Date.now()): boolean {
  if (!officialIndexUrl()) return false;
  const cache = readIndexCache();
  if (cache.url !== officialIndexUrl()) return true;
  return !cache.attemptedAt || now - cache.attemptedAt > INDEX_MAX_AGE_MS;
}

/**
 * Fetch the network index and cache it. Failures are recorded and swallowed:
 * the bundled baseline and the previous cache keep working offline, and the
 * attempt timestamp stops every round from retrying a dead network.
 */
export async function refreshOfficialIndex(
  timeoutMs: number,
): Promise<{ ok: boolean; error?: string }> {
  const url = officialIndexUrl();
  if (!url) return { ok: false, error: "the official index is disabled" };
  const previous = readIndexCache();
  const cache: IndexCache = {
    ...(previous.url === url ? previous : {}),
    url,
    attemptedAt: Date.now(),
  };
  try {
    const text = await readUrlText(url, timeoutMs);
    const index = parseIndex(JSON.parse(text), url);
    cache.index = index;
    cache.fetchedAt = Date.now();
    delete cache.error;
    ensureHome();
    writeJsonFile(pluginPaths().indexCache, cache);
    return { ok: true };
  } catch (error) {
    cache.error = (error as Error)?.message || String(error);
    try {
      ensureHome();
      writeJsonFile(pluginPaths().indexCache, cache);
    } catch {
      // A read-only home only loses the retry throttle.
    }
    return { ok: false, error: cache.error };
  }
}

/** Merge the bundled official index with the cached network index. */
export function loadOfficialCatalog(): OfficialCatalog {
  const catalog: OfficialCatalog = { plugins: new Map(), revoked: [] };
  const sources: Array<{ index: PluginIndex; base: string }> = [];
  const bundledPath = bundledPluginIndexPath();
  const bundled = readJsonFile<unknown>(bundledPath);
  if (bundled) {
    try {
      sources.push({
        index: parseIndex(bundled, bundledPath),
        base: pathToFileURL(bundledPath).href,
      });
    } catch {
      // A broken bundled index must not take the remote copy down with it.
    }
  }
  const cache = readIndexCache();
  if (cache.index && cache.url && cache.url === officialIndexUrl()) {
    sources.push({ index: cache.index, base: toUrl(cache.url) });
  }
  for (const { index, base } of sources) {
    for (const plugin of index.plugins) {
      const existing = catalog.plugins.get(plugin.id);
      const versions = plugin.versions.map((version) => ({
        ...version,
        bundleUrl: new URL(version.bundle, base).href,
      }));
      if (!existing) {
        catalog.plugins.set(plugin.id, { ...plugin, versions });
        continue;
      }
      // A later source (the network index) wins for metadata and for a
      // version both sources list.
      const byVersion = new Map(
        existing.versions.map((version) => [version.version, version]),
      );
      for (const version of versions) byVersion.set(version.version, version);
      catalog.plugins.set(plugin.id, {
        ...existing,
        ...plugin,
        versions: [...byVersion.values()].sort((a, b) =>
          compareVersions(b.version, a.version),
        ),
      });
    }
    catalog.revoked.push(...(index.revoked || []));
  }
  return catalog;
}

function parseIndex(value: unknown, source: string): PluginIndex {
  const index = value as PluginIndex;
  if (!index || index.format !== 1 || !Array.isArray(index.plugins)) {
    throw new Error(`${source} is not a plugin index (format 1)`);
  }
  for (const plugin of index.plugins) {
    if (typeof plugin?.id !== "string" || !Array.isArray(plugin.versions)) {
      throw new Error(`${source} has an invalid plugin entry`);
    }
    for (const version of plugin.versions) {
      validateManifest(
        version.manifest,
        `${source} ${plugin.id}@${version.version}`,
      );
    }
    plugin.versions.sort((a, b) => compareVersions(b.version, a.version));
  }
  return index;
}

/**
 * Newest version this SDK can run. With `sameMajorAs`, automatic updates
 * never cross a major version, which signals a breaking args/returns change.
 */
export function pickOfficialVersion(
  catalog: OfficialCatalog,
  id: string,
  { sameMajorAs, exact }: { sameMajorAs?: string; exact?: string } = {},
): ResolvedIndexVersion | undefined {
  const plugin = catalog.plugins.get(id);
  if (!plugin) return undefined;
  return plugin.versions.find(
    (version) =>
      isApiCompatible(version.manifest) &&
      !isRevoked(catalog, id, version.version, version.integrity) &&
      (exact === undefined || version.version === exact) &&
      (sameMajorAs === undefined ||
        majorOf(version.version) === majorOf(sameMajorAs)),
  );
}

export function revocationFor(
  catalog: OfficialCatalog,
  id: string,
  version: string,
  integrity?: string,
): Revocation | undefined {
  return catalog.revoked.find(
    (entry) =>
      (entry.integrity !== undefined && entry.integrity === integrity) ||
      (entry.id === id &&
        (entry.versions === "*" ||
          (Array.isArray(entry.versions) && entry.versions.includes(version)))),
  );
}

export function isRevoked(
  catalog: OfficialCatalog,
  id: string,
  version: string,
  integrity?: string,
): boolean {
  return revocationFor(catalog, id, version, integrity) !== undefined;
}

export async function downloadOfficialBundle(
  version: ResolvedIndexVersion,
  timeoutMs: number,
): Promise<PluginBundle> {
  const bundle = parseBundle(
    await readUrlText(version.bundleUrl, timeoutMs),
    version.bundleUrl,
  );
  const integrity = bundleIntegrity(bundle);
  if (integrity !== version.integrity) {
    throw new Error(
      `${version.bundleUrl} does not match the integrity recorded in the official index`,
    );
  }
  return bundle;
}

// ---------------------------------------------------------------------------
// Installed and local plugins

export type ResolvedPlugin = {
  manifest: PluginManifest;
  dir: string;
  source: PluginSource;
  integrity?: string;
  lock?: LockEntry;
};

export function installedVersionDir(id: string, version: string): string {
  return join(pluginPaths().installed, id, version);
}

/** Install a bundle as the active version of its plugin. */
export function installBundle(
  bundle: PluginBundle,
  {
    source,
    origin,
    pinned,
  }: { source: LockEntry["source"]; origin?: string; pinned?: boolean },
): LockEntry {
  ensureHome();
  const { id, version } = bundle.manifest;
  const integrity = bundleIntegrity(bundle);
  const target = installedVersionDir(id, version);
  const staging = `${target}.staging-${process.pid}-${Date.now()}`;
  rmSync(staging, { recursive: true, force: true });
  for (const [path, content] of Object.entries(bundle.files)) {
    const destination = resolve(staging, path);
    if (!destination.startsWith(staging + sep)) {
      throw new Error(`bundle file ${path} escapes the plugin directory`);
    }
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
  writeFileSync(
    join(staging, MANIFEST_FILE),
    `${JSON.stringify(bundle.manifest, null, 2)}\n`,
  );
  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  renameSync(staging, target);

  const lock = readLock();
  const current = lock.plugins[id];
  const entry: LockEntry = {
    version,
    source,
    integrity,
    origin: origin ?? current?.origin,
    pinned: pinned ?? current?.pinned,
    previous:
      current && current.version !== version
        ? { version: current.version, integrity: current.integrity }
        : current?.previous,
    installedAt: new Date().toISOString(),
  };
  if (!entry.pinned) delete entry.pinned;
  if (!entry.origin) delete entry.origin;
  if (!entry.previous) delete entry.previous;
  lock.plugins[id] = entry;
  writeLock(lock);
  pruneVersions(id, [version, entry.previous?.version]);
  return entry;
}

/** Keep the active and the rollback version; drop older ones. */
function pruneVersions(id: string, keep: Array<string | undefined>): void {
  const dir = join(pluginPaths().installed, id);
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (keep.includes(name)) continue;
    rmSync(join(dir, name), { recursive: true, force: true });
  }
}

export function removeInstalled(id: string): boolean {
  assertPluginId(id, "removePlugin");
  const root = resolve(pluginPaths().installed);
  const dir = resolve(root, id);
  if (dirname(dir) !== root) {
    throw new TypeError(`removePlugin refuses to delete ${dir}`);
  }
  const lock = readLock();
  const existed = Boolean(lock.plugins[id]);
  delete lock.plugins[id];
  writeLock(lock);
  rmSync(dir, { recursive: true, force: true });
  return existed;
}

/** Read an installed version back as a bundle to verify its integrity. */
export function readInstalledBundle(id: string, version: string): PluginBundle {
  return bundleFromDirectory(installedVersionDir(id, version));
}

export function resolveInstalled(id: string): ResolvedPlugin | undefined {
  const entry = readLock().plugins[id];
  if (!entry) return undefined;
  const dir = installedVersionDir(id, entry.version);
  const manifest = readJsonFile<unknown>(join(dir, MANIFEST_FILE));
  if (!manifest) return undefined;
  return {
    manifest: validateManifest(manifest, join(dir, MANIFEST_FILE)),
    dir,
    source: entry.source,
    integrity: entry.integrity,
    lock: entry,
  };
}

export type LocalPluginScan = {
  plugins: ResolvedPlugin[];
  errors: Array<{ dir: string; error: string }>;
};

/** Plugins under local/: one plugin per child directory, loaded as-is. */
export function scanLocalPlugins(): LocalPluginScan {
  const scan: LocalPluginScan = { plugins: [], errors: [] };
  const root = pluginPaths().local;
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return scan;
  }
  const seen = new Map<string, string>();
  for (const name of names.sort()) {
    if (name.startsWith(".")) continue;
    const dir = join(root, name);
    const manifestPath = join(dir, MANIFEST_FILE);
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = validateManifest(
        JSON.parse(readFileSync(manifestPath, "utf8")),
        manifestPath,
      );
      const duplicate = seen.get(manifest.id);
      if (duplicate) {
        throw new Error(
          `plugin id ${manifest.id} is also defined in ${duplicate}; plugin ids must be unique`,
        );
      }
      seen.set(manifest.id, dir);
      scan.plugins.push({ manifest, dir, source: "local" });
    } catch (error) {
      scan.errors.push({ dir, error: (error as Error).message });
    }
  }
  return scan;
}

// ---------------------------------------------------------------------------
// Bundles from directories, URLs and Git

const SKIPPED_NAMES = new Set(["node_modules", ".git", "test", "tests"]);

export function bundleFromDirectory(dir: string): PluginBundle {
  const manifestPath = join(dir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    throw new Error(`${dir} has no ${MANIFEST_FILE}`);
  }
  const manifest = validateManifest(
    JSON.parse(readFileSync(manifestPath, "utf8")),
    manifestPath,
  );
  const files: Record<string, string> = {};
  let total = 0;
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || SKIPPED_NAMES.has(entry.name)) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const name = relative(dir, path).split(sep).join("/");
      if (name === MANIFEST_FILE) continue;
      if (!/\.(m?js|json|md|txt)$/.test(name)) continue;
      total += statSync(path).size;
      if (total > MAX_BUNDLE_BYTES) {
        throw new Error(`${dir} is larger than ${MAX_BUNDLE_BYTES} bytes`);
      }
      files[name] = readFileSync(path, "utf8");
    }
  };
  walk(dir);
  for (const [name, command] of Object.entries(manifest.commands)) {
    if (files[command.entry] === undefined) {
      throw new Error(
        `${manifestPath}: command ${name} entry ${command.entry} does not exist`,
      );
    }
  }
  return { format: 1, manifest, files };
}

function parseBundle(text: string, source: string): PluginBundle {
  if (text.length > MAX_BUNDLE_BYTES * 2) {
    throw new Error(`${source} is too large for a plugin bundle`);
  }
  const bundle = JSON.parse(text) as PluginBundle;
  if (!bundle || bundle.format !== 1 || typeof bundle.files !== "object") {
    throw new Error(`${source} is not a plugin bundle (format 1)`);
  }
  validateManifest(bundle.manifest, source);
  for (const [name, command] of Object.entries(bundle.manifest.commands)) {
    if (typeof bundle.files[command.entry] !== "string") {
      throw new Error(
        `${source}: command ${name} entry ${command.entry} is missing`,
      );
    }
  }
  return bundle;
}

export type ThirdPartyOrigin =
  | { kind: "directory"; path: string }
  | { kind: "bundle"; url: string }
  | { kind: "git"; url: string; ref?: string; subdir?: string };

/** Classify a third-party install source string. */
export function parseThirdPartyOrigin(source: string): ThirdPartyOrigin {
  const github = /^github:([\w.-]+)\/([\w.-]+)((?:\/[\w.-]+)*)(?:#(.+))?$/.exec(
    source,
  );
  if (github) {
    return {
      kind: "git",
      url: `https://github.com/${github[1]}/${github[2]}.git`,
      subdir: github[3] ? github[3].slice(1) : undefined,
      ref: github[4],
    };
  }
  if (/^git\+/.test(source) || /\.git(#.*)?$/.test(source)) {
    const [url, ref] = source.replace(/^git\+/, "").split("#");
    return { kind: "git", url, ref };
  }
  if (/^https?:\/\//.test(source)) {
    const repo = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)\/?$/.exec(
      source,
    );
    if (repo) {
      return {
        kind: "git",
        url: `https://github.com/${repo[1]}/${repo[2]}.git`,
      };
    }
    return { kind: "bundle", url: source };
  }
  if (source.startsWith("file:")) {
    return { kind: "directory", path: fileURLToPath(source) };
  }
  const expanded = source.startsWith("~")
    ? join(process.env.HOME || process.env.USERPROFILE || "", source.slice(1))
    : source;
  if (isAbsolute(expanded)) return { kind: "directory", path: expanded };
  throw new Error(
    `cannot install ${JSON.stringify(source)}: use an official plugin id, an absolute directory path, a bundle URL, a .git URL, or github:owner/repo[/path][#ref]`,
  );
}

export async function bundleFromOrigin(
  origin: ThirdPartyOrigin,
  timeoutMs: number,
): Promise<PluginBundle> {
  if (origin.kind === "directory") return bundleFromDirectory(origin.path);
  if (origin.kind === "bundle") {
    return parseBundle(await readUrlText(origin.url, timeoutMs), origin.url);
  }
  const work = await mkdtemp(join(tmpdir(), "ego-plugin-"));
  try {
    const args = ["clone", "--depth", "1"];
    if (origin.ref) args.push("--branch", origin.ref);
    args.push(origin.url, join(work, "repo"));
    await promisify(execFile)("git", args, { timeout: timeoutMs });
    return bundleFromDirectory(join(work, "repo", origin.subdir || ""));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------

async function readUrlText(url: string, timeoutMs: number): Promise<string> {
  if (url.startsWith("file:")) return readFileSync(fileURLToPath(url), "utf8");
  if (isAbsolute(url)) return readFileSync(url, "utf8");
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`GET ${url} failed: HTTP ${response.status}`);
  }
  return response.text();
}

function toUrl(location: string): string {
  return isAbsolute(location) ? pathToFileURL(location).href : location;
}

/** Wrap install-path failures so callers always see the plugin error format. */
export function installFailure(id: string, error: unknown): PluginError {
  if (error instanceof PluginError) return error;
  return new PluginError(
    "PLUGIN_INSTALL_FAILED",
    `could not install ${id}: ${(error as Error)?.message || String(error)}`,
    { plugin: id, cause: error },
  );
}
