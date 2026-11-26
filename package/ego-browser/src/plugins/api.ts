import { setPageTouchedListener, setPluginRunner } from "../plugin-hooks.js";
import {
  describePlugin,
  filterPlugins,
  knownPlugins,
  type PluginInfo,
} from "./catalog.js";
import { PluginError } from "./errors.js";
import { notePageTouched } from "./hints.js";
import { compareVersions } from "./manifest.js";
import {
  bundleFromOrigin,
  downloadOfficialBundle,
  installBundle,
  installFailure,
  installedVersionDir,
  loadOfficialCatalog,
  officialIndexIsStale,
  parseThirdPartyOrigin,
  pickOfficialVersion,
  readLock,
  refreshOfficialIndex,
  removeInstalled,
  resolveInstalled,
  scanLocalPlugins,
  writeLock,
} from "./store.js";
import { runPluginCommand, setPluginHelperContext } from "./runtime.js";
import { existsSync } from "node:fs";

/**
 * Agent-facing plugin management. These run inside the heredoc like every
 * other helper; there are no CLI subcommands, so nothing depends on the
 * launcher that embeds this SDK.
 */

const INDEX_REFRESH_MS = 10_000;
const INSTALL_TIMEOUT_MS = 60_000;

/** Wire the plugin runtime into the Page model and helper context. */
export function installPluginRuntime(
  helperContext: () => Record<string, unknown>,
): void {
  setPluginHelperContext(helperContext);
  setPluginRunner((page, task, ref, args, options) =>
    runPluginCommand(page as never, task as never, ref, args, options),
  );
  setPageTouchedListener(notePageTouched);
}

/**
 * List site plugins: installed, local, and official ones that install on
 * first use. Pass a URL or hostname to see the plugins for that site, or
 * { query } to search.
 * @param {string|{query?:string,url?:string}} [filter] URL, hostname, or search options.
 * @returns {Promise<Array<object>>} Plugins with their commands and call signatures.
 */
export async function plugins(
  filter?: string | { query?: string; url?: string },
): Promise<PluginInfo[]> {
  if (officialIndexIsStale()) await refreshOfficialIndex(5_000);
  return filterPlugins(knownPlugins(), filter).map(describePlugin);
}

/**
 * Install a site plugin. An official id installs from the official index.
 * Anything else (an absolute directory, a bundle URL, a .git URL, or
 * github:owner/repo[/path][#ref]) is third-party: it runs with the same power
 * as your own scripts, so install one only when the user explicitly asked
 * and pass { allowThirdParty: true }. Third-party plugins never auto-update.
 * @param {string} source Official plugin id or third-party source.
 * @param {{allowThirdParty?:boolean,version?:string}} [options]
 * @returns {Promise<object>} The installed plugin.
 */
export async function installPlugin(
  source: string,
  options: { allowThirdParty?: boolean; version?: string } = {},
): Promise<PluginInfo> {
  if (typeof source !== "string" || !source) {
    throw new TypeError(
      "installPlugin(source, { allowThirdParty?, version? }) needs a source string",
    );
  }
  for (const key of Object.keys(options || {})) {
    if (key !== "allowThirdParty" && key !== "version") {
      throw new TypeError(`installPlugin received unknown option: ${key}`);
    }
  }
  await refreshOfficialIndex(INDEX_REFRESH_MS);
  const catalog = loadOfficialCatalog();
  if (catalog.plugins.has(source)) {
    const version = pickOfficialVersion(catalog, source, {
      exact: options.version,
    });
    if (!version) {
      throw new PluginError(
        "PLUGIN_NOT_FOUND",
        options.version
          ? `official plugin ${source} has no installable version ${options.version}`
          : `no version of ${source} runs on this ego-browser; update Ego Lite`,
        { plugin: source },
      );
    }
    try {
      installBundle(await downloadOfficialBundle(version, INSTALL_TIMEOUT_MS), {
        source: "official",
        pinned: options.version ? true : undefined,
      });
    } catch (error) {
      throw installFailure(source, error);
    }
    return infoFor(source);
  }

  if (/^[a-z0-9][a-z0-9.-]*$/.test(source)) {
    throw new PluginError(
      "PLUGIN_NOT_FOUND",
      `${source} is not an official plugin id`,
      { plugin: source, nextStep: "Run plugins() to list official plugins." },
    );
  }
  if (options.allowThirdParty !== true) {
    throw new PluginError(
      "PLUGIN_INSTALL_FAILED",
      `${source} is a third-party plugin. It is not reviewed by Ego and runs with the same access as your own scripts, including the user's signed-in sites`,
      {
        plugin: source,
        nextStep:
          "Install it only if the user explicitly asked for this plugin, by calling installPlugin(source, { allowThirdParty: true }).",
      },
    );
  }
  const origin = parseThirdPartyOrigin(source);
  let bundle;
  try {
    bundle = await bundleFromOrigin(origin, INSTALL_TIMEOUT_MS);
  } catch (error) {
    throw installFailure(source, error);
  }
  const id = bundle.manifest.id;
  if (catalog.plugins.has(id)) {
    throw new PluginError(
      "PLUGIN_INSTALL_FAILED",
      `${source} declares id ${id}, which belongs to an official plugin`,
      {
        plugin: id,
        nextStep: `Use the official plugin: installPlugin(${JSON.stringify(id)}).`,
      },
    );
  }
  if (scanLocalPlugins().plugins.some((plugin) => plugin.manifest.id === id)) {
    throw new PluginError(
      "PLUGIN_INSTALL_FAILED",
      `a local plugin already uses id ${id}; local plugins take precedence`,
      {
        plugin: id,
        nextStep:
          "Remove the local copy first if you want the installed version.",
      },
    );
  }
  const existing = readLock().plugins[id];
  if (
    existing &&
    existing.source === "third-party" &&
    existing.origin &&
    existing.origin !== source
  ) {
    throw new PluginError(
      "PLUGIN_INSTALL_FAILED",
      `plugin id ${id} is already installed from ${existing.origin}`,
      {
        plugin: id,
        nextStep: `Run removePlugin(${JSON.stringify(id)}) first if the user wants to replace it.`,
      },
    );
  }
  installBundle(bundle, { source: "third-party", origin: source });
  return infoFor(id);
}

/**
 * Update official plugins to their newest compatible version (crossing major
 * versions), or re-fetch a third-party plugin from where it was installed.
 * Pinned plugins are skipped unless named explicitly.
 * @param {string} [id] Plugin id; omit to update every installed plugin.
 * @returns {Promise<Array<{id:string,from?:string,to?:string,status:string}>>}
 */
export async function updatePlugin(id?: string) {
  await refreshOfficialIndex(INDEX_REFRESH_MS);
  const catalog = loadOfficialCatalog();
  const lock = readLock();
  const ids = id ? [id] : Object.keys(lock.plugins);
  if (id && !lock.plugins[id]) {
    throw new PluginError("PLUGIN_NOT_FOUND", `${id} is not installed`, {
      plugin: id,
    });
  }
  const results: Array<{
    id: string;
    from?: string;
    to?: string;
    status: string;
  }> = [];
  for (const pluginId of ids) {
    const entry = lock.plugins[pluginId];
    if (entry.pinned && !id) {
      results.push({ id: pluginId, from: entry.version, status: "pinned" });
      continue;
    }
    try {
      if (entry.source === "official") {
        const latest = pickOfficialVersion(catalog, pluginId);
        const broken = !existsSync(
          installedVersionDir(pluginId, entry.version),
        );
        if (
          !latest ||
          (!broken && compareVersions(latest.version, entry.version) <= 0)
        ) {
          results.push({
            id: pluginId,
            from: entry.version,
            status: "up to date",
          });
          continue;
        }
        installBundle(
          await downloadOfficialBundle(latest, INSTALL_TIMEOUT_MS),
          {
            source: "official",
            pinned: false,
          },
        );
        results.push({
          id: pluginId,
          from: entry.version,
          to: latest.version,
          status: "updated",
        });
      } else {
        if (!entry.origin) {
          results.push({
            id: pluginId,
            from: entry.version,
            status: "no origin recorded",
          });
          continue;
        }
        const bundle = await bundleFromOrigin(
          parseThirdPartyOrigin(entry.origin),
          INSTALL_TIMEOUT_MS,
        );
        if (bundle.manifest.id !== pluginId) {
          throw new Error(
            `${entry.origin} now declares id ${bundle.manifest.id}`,
          );
        }
        const next = installBundle(bundle, {
          source: "third-party",
          origin: entry.origin,
        });
        results.push({
          id: pluginId,
          from: entry.version,
          to: next.version,
          status: next.integrity === entry.integrity ? "up to date" : "updated",
        });
      }
    } catch (error) {
      results.push({
        id: pluginId,
        from: entry.version,
        status: `failed: ${(error as Error)?.message || String(error)}`,
      });
    }
  }
  return results;
}

/**
 * Pin an installed plugin so automatic updates skip it. With a version, an
 * official plugin first switches to that version.
 * @param {string} id Plugin id.
 * @param {string} [version] Official version to install and pin.
 * @returns {Promise<object>}
 */
export async function pinPlugin(
  id: string,
  version?: string,
): Promise<PluginInfo> {
  if (version !== undefined) {
    return installPlugin(id, { version });
  }
  const lock = readLock();
  const entry = lock.plugins[id];
  if (!entry)
    throw new PluginError("PLUGIN_NOT_FOUND", `${id} is not installed`, {
      plugin: id,
    });
  entry.pinned = true;
  writeLock(lock);
  return infoFor(id);
}

/**
 * Let a pinned official plugin update automatically again.
 * @param {string} id Plugin id.
 * @returns {Promise<object>}
 */
export async function unpinPlugin(id: string): Promise<PluginInfo> {
  const lock = readLock();
  const entry = lock.plugins[id];
  if (!entry)
    throw new PluginError("PLUGIN_NOT_FOUND", `${id} is not installed`, {
      plugin: id,
    });
  delete entry.pinned;
  writeLock(lock);
  return infoFor(id);
}

/**
 * Remove an installed plugin. Official plugins reinstall on their next use;
 * local plugins are removed by deleting their directory.
 * @param {string} id Plugin id.
 * @returns {Promise<boolean>} Whether anything was removed.
 */
export async function removePlugin(id: string): Promise<boolean> {
  return removeInstalled(id);
}

/**
 * Switch an installed plugin back to its previous version and pin it there,
 * so the next automatic update does not undo the rollback.
 * @param {string} id Plugin id.
 * @returns {Promise<object>}
 */
export async function rollbackPlugin(id: string): Promise<PluginInfo> {
  const lock = readLock();
  const entry = lock.plugins[id];
  if (!entry)
    throw new PluginError("PLUGIN_NOT_FOUND", `${id} is not installed`, {
      plugin: id,
    });
  const previous = entry.previous;
  if (!previous || !existsSync(installedVersionDir(id, previous.version))) {
    throw new PluginError(
      "PLUGIN_NOT_FOUND",
      `${id} has no previous version to roll back to`,
      {
        plugin: id,
        nextStep:
          entry.source === "official"
            ? `Pin a specific version with pinPlugin(${JSON.stringify(id)}, version).`
            : "Reinstall the version you need.",
      },
    );
  }
  lock.plugins[id] = {
    ...entry,
    version: previous.version,
    integrity: previous.integrity,
    previous: { version: entry.version, integrity: entry.integrity },
    pinned: true,
    installedAt: new Date().toISOString(),
  };
  writeLock(lock);
  return infoFor(id);
}

function infoFor(id: string): PluginInfo {
  const known = knownPlugins().find((plugin) => plugin.id === id);
  if (known) return describePlugin(known);
  const installed = resolveInstalled(id);
  return describePlugin({
    id,
    source: installed?.source || "third-party",
    installed: Boolean(installed),
    manifest: installed?.manifest,
    installedVersion: installed?.manifest.version,
  });
}

export const pluginHelpers = {
  plugins,
  installPlugin,
  updatePlugin,
  pinPlugin,
  unpinPlugin,
  removePlugin,
  rollbackPlugin,
};
