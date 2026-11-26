import { schemaCallShape, schemaResultShape } from "./json-schema.js";
import { hostMatches, urlHostname, type PluginManifest } from "./manifest.js";
import {
  loadOfficialCatalog,
  pickOfficialVersion,
  readLock,
  resolveInstalled,
  revocationFor,
  scanLocalPlugins,
  type PluginSource,
} from "./store.js";

/** One plugin as the Agent sees it, whichever layer provides it. */
export type KnownPlugin = {
  id: string;
  source: PluginSource;
  installed: boolean;
  manifest?: PluginManifest;
  installedVersion?: string;
  latestVersion?: string;
  pinned?: boolean;
  revoked?: string;
  dir?: string;
  error?: string;
};

/**
 * Every plugin visible to this SDK. Precedence: local directory, then the
 * installed version, then the newest official version not yet installed.
 */
export function knownPlugins(): KnownPlugin[] {
  const catalog = loadOfficialCatalog();
  const lock = readLock();
  const local = scanLocalPlugins();
  const out = new Map<string, KnownPlugin>();

  for (const plugin of local.plugins) {
    const revocation = revocationFor(
      catalog,
      plugin.manifest.id,
      plugin.manifest.version,
    );
    out.set(plugin.manifest.id, {
      id: plugin.manifest.id,
      source: "local",
      installed: true,
      manifest: plugin.manifest,
      installedVersion: plugin.manifest.version,
      dir: plugin.dir,
      revoked: revocation ? revocation.reason || "withdrawn" : undefined,
    });
  }
  for (const id of Object.keys(lock.plugins)) {
    if (out.has(id)) continue;
    const entry = lock.plugins[id];
    let installed;
    let error: string | undefined;
    try {
      installed = resolveInstalled(id);
      if (!installed) error = "installed files are missing; run updatePlugin()";
    } catch (cause) {
      error = (cause as Error).message;
    }
    const revocation = revocationFor(
      catalog,
      id,
      entry.version,
      entry.integrity,
    );
    out.set(id, {
      id,
      source: entry.source,
      installed: true,
      manifest: installed?.manifest,
      installedVersion: entry.version,
      latestVersion:
        entry.source === "official"
          ? pickOfficialVersion(catalog, id)?.version
          : undefined,
      pinned: entry.pinned || undefined,
      dir: installed?.dir,
      revoked: revocation ? revocation.reason || "withdrawn" : undefined,
      error,
    });
  }
  for (const id of catalog.plugins.keys()) {
    if (out.has(id)) continue;
    const latest = pickOfficialVersion(catalog, id);
    if (!latest) continue;
    out.set(id, {
      id,
      source: "official",
      installed: false,
      manifest: latest.manifest,
      latestVersion: latest.version,
    });
  }
  const scanErrors: KnownPlugin[] = local.errors.map((entry) => ({
    id: entry.dir,
    source: "local",
    installed: false,
    dir: entry.dir,
    error: entry.error,
  }));
  return [...out.values(), ...scanErrors];
}

export type PluginCommandInfo = {
  ref: string;
  call: string;
  returns: string;
  description: string;
  readOnly: boolean;
  args?: unknown;
};

export type PluginInfo = {
  id: string;
  name?: string;
  description?: string;
  source: PluginSource;
  installed: boolean;
  version?: string;
  latestVersion?: string;
  pinned?: boolean;
  domains: string[];
  commands: PluginCommandInfo[];
  revoked?: string;
  error?: string;
  dir?: string;
};

export function describePlugin(plugin: KnownPlugin): PluginInfo {
  const manifest = plugin.manifest;
  const info: PluginInfo = {
    id: plugin.id,
    name: manifest?.name,
    description: manifest?.description,
    source: plugin.source,
    installed: plugin.installed,
    version: plugin.installedVersion,
    latestVersion:
      plugin.latestVersion && plugin.latestVersion !== plugin.installedVersion
        ? plugin.latestVersion
        : undefined,
    pinned: plugin.pinned,
    domains: manifest?.domains || [],
    commands: Object.entries(manifest?.commands || {}).map(
      ([name, command]) => ({
        ref: `${plugin.id}/${name}`,
        call: `await page.runPlugin(${JSON.stringify(`${plugin.id}/${name}`)}, ${schemaCallShape(command.args)})`,
        returns: schemaResultShape(command.returns),
        description: command.description,
        readOnly: command.readOnly !== false,
        args: command.args?.properties,
      }),
    ),
    revoked: plugin.revoked,
    error: plugin.error,
    dir: plugin.source === "local" ? plugin.dir : undefined,
  };
  for (const key of Object.keys(info) as Array<keyof PluginInfo>) {
    if (info[key] === undefined) delete info[key];
  }
  return info;
}

/** Filter by a URL or hostname, by `{ query }`, or return everything. */
export function filterPlugins(
  plugins: KnownPlugin[],
  filter?: string | { query?: string; url?: string },
): KnownPlugin[] {
  if (filter === undefined || filter === null) return plugins;
  const options = typeof filter === "string" ? { url: filter } : filter;
  if (typeof options !== "object") {
    throw new TypeError(
      "plugins() takes a URL or hostname string, or { query?, url? }",
    );
  }
  let result = plugins;
  if (options.url) {
    const host =
      urlHostname(options.url) ||
      urlHostname(`https://${options.url.replace(/^\/+/, "")}`);
    if (!host)
      throw new TypeError(
        `plugins() could not read a hostname from ${options.url}`,
      );
    result = result.filter(
      (plugin) => plugin.manifest && hostMatches(host, plugin.manifest.domains),
    );
  }
  if (options.query) {
    const needle = options.query.toLowerCase();
    result = result.filter((plugin) =>
      JSON.stringify([
        plugin.id,
        plugin.manifest?.name,
        plugin.manifest?.description,
        plugin.manifest?.domains,
        Object.entries(plugin.manifest?.commands || {}).map(
          ([name, command]) => [name, command.description],
        ),
      ])
        .toLowerCase()
        .includes(needle),
    );
  }
  return result;
}
