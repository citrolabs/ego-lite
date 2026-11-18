import { statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { bufferOutput, createRoundConsole } from "../output-sink.js";
import { validatePublicApiOptions } from "../public-api-schema.js";
import { PluginError, attributePluginError } from "./errors.js";
import {
  formatSchemaIssues,
  schemaCallShape,
  schemaResultShape,
  validateJsonSchema,
} from "./json-schema.js";
import {
  bundleIntegrity,
  compareVersions,
  parseCommandRef,
  type PluginManifest,
} from "./manifest.js";
import { notePluginUsed } from "./hints.js";
import {
  downloadOfficialBundle,
  installBundle,
  installFailure,
  loadOfficialCatalog,
  officialIndexIsStale,
  pickOfficialVersion,
  readInstalledBundle,
  refreshOfficialIndex,
  resolveInstalled,
  revocationFor,
  scanLocalPlugins,
  type OfficialCatalog,
  type ResolvedPlugin,
} from "./store.js";

export const DEFAULT_PLUGIN_TIMEOUT_MS = 120_000;
const AUTO_INDEX_REFRESH_MS = 5_000;
const SITE_CHANGED_REFRESH_MS = 10_000;
const INSTALL_TIMEOUT_MS = 15_000;

type PageLike = { label: string; spaceId: number };
type TaskLike = { name?: string };
type HelperContextFactory = () => Record<string, unknown>;

let helperContextFactory: HelperContextFactory = () => ({});

/** helpers.ts provides the helper set plugins receive, avoiding an import cycle. */
export function setPluginHelperContext(factory: HelperContextFactory): void {
  helperContextFactory = factory;
}

export type RunPluginOptions = { timeout?: number };

/**
 * `page.runPlugin(ref, args, options)`. Resolves the plugin (installing or
 * updating an official one silently), validates args, runs it with the same
 * helpers an Agent script has, validates the result, and on SITE_CHANGED
 * checks once for a fixed official version before giving up.
 */
export async function runPluginCommand(
  page: PageLike,
  task: TaskLike,
  ref: unknown,
  args: unknown = {},
  options: unknown = {},
): Promise<unknown> {
  const { id, command } = parseCommandRef(ref);
  const timeoutMs = readTimeout(options);
  let plugin = await resolveForRun(id);
  notePluginUsed(page.spaceId, task.name, id);
  try {
    return await executeCommand(plugin, command, args, page, task, timeoutMs);
  } catch (error) {
    if (
      !(error instanceof PluginError) ||
      error.code !== "SITE_CHANGED" ||
      plugin.source !== "official" ||
      plugin.lock?.pinned
    ) {
      throw error;
    }
    const updated = await updateOfficialAfterSiteChange(plugin);
    if (!updated) throw error;
    plugin = updated;
    return executeCommand(plugin, command, args, page, task, timeoutMs);
  }
}

function readTimeout(options: unknown): number {
  if (options === undefined) return DEFAULT_PLUGIN_TIMEOUT_MS;
  validatePublicApiOptions("Page.runPlugin", options);
  return (options as RunPluginOptions).timeout ?? DEFAULT_PLUGIN_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// Resolution

export async function resolveForRun(id: string): Promise<ResolvedPlugin> {
  const local = scanLocalPlugins().plugins.find(
    (plugin) => plugin.manifest.id === id,
  );
  if (officialIndexIsStale()) await refreshOfficialIndex(AUTO_INDEX_REFRESH_MS);
  const catalog = loadOfficialCatalog();
  if (local) {
    assertNotRevoked(catalog, local.manifest.id, local.manifest.version);
    return local;
  }

  const installed = resolveInstalled(id);
  if (installed?.source === "third-party") {
    if (catalog.plugins.has(id)) {
      throw new PluginError(
        "PLUGIN_BROKEN",
        `third-party plugin ${id} uses the id of an official plugin; remove it with removePlugin(${JSON.stringify(id)}) and use the official one`,
        { plugin: id },
      );
    }
    assertNotRevoked(
      catalog,
      id,
      installed.manifest.version,
      installed.integrity,
    );
    assertIntact(installed);
    return installed;
  }
  if (installed?.source === "official") {
    return ensureOfficialCurrent(catalog, installed);
  }

  const latest = pickOfficialVersion(catalog, id);
  if (!latest) {
    throw new PluginError(
      "PLUGIN_NOT_FOUND",
      catalog.plugins.has(id)
        ? `no version of ${id} runs on this ego-browser; update Ego Lite`
        : `no plugin with id ${JSON.stringify(id)} is installed or published`,
      { plugin: id },
    );
  }
  try {
    installBundle(await downloadOfficialBundle(latest, INSTALL_TIMEOUT_MS), {
      source: "official",
    });
  } catch (error) {
    throw installFailure(id, error);
  }
  return resolveInstalled(id)!;
}

async function ensureOfficialCurrent(
  catalog: OfficialCatalog,
  installed: ResolvedPlugin,
): Promise<ResolvedPlugin> {
  const id = installed.manifest.id;
  const version = installed.manifest.version;
  const revocation = revocationFor(catalog, id, version, installed.integrity);
  const pinned = Boolean(installed.lock?.pinned);
  const replacement =
    revocation || !pinned
      ? pickOfficialVersion(catalog, id, { sameMajorAs: version })
      : undefined;
  const intact = isIntact(installed);
  if (
    replacement &&
    (revocation || !intact || compareVersions(replacement.version, version) > 0)
  ) {
    try {
      installBundle(
        await downloadOfficialBundle(replacement, INSTALL_TIMEOUT_MS),
        { source: "official" },
      );
      if (replacement.version !== version) {
        bufferOutput(
          `[ego-browser:plugins] Updated ${id} ${version} → ${replacement.version}.\n`,
        );
      }
      return resolveInstalled(id)!;
    } catch (error) {
      if (revocation || !intact) throw installFailure(id, error);
      // An update that fails to download leaves the working version in use.
    }
  }
  if (revocation) {
    throw new PluginError(
      "PLUGIN_REVOKED",
      `${id}@${version} was withdrawn: ${revocation.reason || "no reason given"}`,
      { plugin: id },
    );
  }
  if (!intact) assertIntact(installed);
  return installed;
}

async function updateOfficialAfterSiteChange(
  plugin: ResolvedPlugin,
): Promise<ResolvedPlugin | undefined> {
  await refreshOfficialIndex(SITE_CHANGED_REFRESH_MS);
  const catalog = loadOfficialCatalog();
  const next = pickOfficialVersion(catalog, plugin.manifest.id, {
    sameMajorAs: plugin.manifest.version,
  });
  if (!next || compareVersions(next.version, plugin.manifest.version) <= 0) {
    return undefined;
  }
  try {
    installBundle(await downloadOfficialBundle(next, INSTALL_TIMEOUT_MS), {
      source: "official",
    });
  } catch {
    return undefined;
  }
  bufferOutput(
    `[ego-browser:plugins] ${plugin.manifest.id} reported a site change; updated ${plugin.manifest.version} → ${next.version} and retried.\n`,
  );
  return resolveInstalled(plugin.manifest.id);
}

function assertNotRevoked(
  catalog: OfficialCatalog,
  id: string,
  version: string,
  integrity?: string,
): void {
  const revocation = revocationFor(catalog, id, version, integrity);
  if (revocation) {
    throw new PluginError(
      "PLUGIN_REVOKED",
      `${id}@${version} was withdrawn: ${revocation.reason || "no reason given"}`,
      { plugin: id },
    );
  }
}

function isIntact(plugin: ResolvedPlugin): boolean {
  if (!plugin.integrity) return true;
  try {
    return (
      bundleIntegrity(
        readInstalledBundle(plugin.manifest.id, plugin.manifest.version),
      ) === plugin.integrity
    );
  } catch {
    return false;
  }
}

function assertIntact(plugin: ResolvedPlugin): void {
  if (isIntact(plugin)) return;
  throw new PluginError(
    "PLUGIN_BROKEN",
    `installed files of ${plugin.manifest.id}@${plugin.manifest.version} changed after installation (${plugin.dir}). To edit a plugin, copy it into the local plugins directory instead`,
    {
      plugin: plugin.manifest.id,
      nextStep: `Reinstall it with installPlugin(...) or ${plugin.source === "official" ? `updatePlugin(${JSON.stringify(plugin.manifest.id)})` : "removePlugin()"}; meanwhile fall back to page.snapshot() and hand-written page code.`,
    },
  );
}

// ---------------------------------------------------------------------------
// Execution

async function executeCommand(
  plugin: ResolvedPlugin,
  commandName: string,
  rawArgs: unknown,
  page: PageLike,
  task: TaskLike,
  timeoutMs: number,
): Promise<unknown> {
  const { manifest } = plugin;
  const ref = `${manifest.id}/${commandName}`;
  const command = manifest.commands[commandName];
  if (!command) {
    throw new PluginError(
      "PLUGIN_NOT_FOUND",
      `${manifest.id} has no command ${JSON.stringify(commandName)}. Commands: ${commandList(manifest)}`,
      { plugin: ref, nextStep: "Call one of the listed commands." },
    );
  }
  const argsInput = rawArgs === undefined ? {} : rawArgs;
  const { value: args, issues } = validateJsonSchema(
    command.args || { type: "object" },
    argsInput,
    { applyDefaults: true },
  );
  if (issues.length > 0) {
    throw new PluginError(
      "INVALID_ARGS",
      `${formatSchemaIssues(issues)}. Expected: page.runPlugin(${JSON.stringify(ref)}, ${schemaCallShape(command.args)}); arguments: ${describeArgs(command.args)}`,
      { plugin: ref },
    );
  }

  const run = await loadEntry(plugin, commandName);
  const roundConsole = createRoundConsole();
  const context = {
    ...helperContextFactory(),
    page,
    task,
    console: roundConsole,
    plugin: {
      id: manifest.id,
      version: manifest.version,
      command: commandName,
      source: plugin.source,
      dir: plugin.dir,
    },
    PluginError,
    fail(code: string, message: string, details?: unknown): never {
      throw new PluginError(code as never, message, { plugin: ref, details });
    },
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: unknown;
  try {
    result = await Promise.race([
      Promise.resolve().then(() => run(args, context)),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new PluginError(
                "TIMEOUT",
                `did not finish within ${timeoutMs} ms; the page may still be changing`,
                { plugin: ref },
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    throw attributePluginError(error, ref);
  } finally {
    clearTimeout(timer);
  }

  if (command.returns) {
    const checked = validateJsonSchema(command.returns, result);
    if (checked.issues.length > 0) {
      throw new PluginError(
        "SITE_CHANGED",
        `the result no longer matches the declared ${schemaResultShape(command.returns)} shape (${formatSchemaIssues(checked.issues)})`,
        { plugin: ref, details: { issues: checked.issues } },
      );
    }
  }
  return result;
}

type EntryFunction = (args: unknown, context: unknown) => unknown;

async function loadEntry(
  plugin: ResolvedPlugin,
  commandName: string,
): Promise<EntryFunction> {
  const { manifest } = plugin;
  const ref = `${manifest.id}/${commandName}`;
  const path = join(plugin.dir, manifest.commands[commandName].entry);
  let href = pathToFileURL(path).href;
  if (plugin.source === "local") {
    // Local plugins are edited in place; a changed file must load fresh.
    try {
      href += `?v=${statSync(path).mtimeMs}`;
    } catch {
      // The import below reports the missing file.
    }
  }
  let module: Record<string, unknown>;
  try {
    module = await import(href);
  } catch (error) {
    throw new PluginError(
      "PLUGIN_BROKEN",
      `could not load ${path}: ${(error as Error)?.message || String(error)}`,
      { plugin: ref, cause: error },
    );
  }
  const run = module.default ?? module.run;
  if (typeof run !== "function") {
    throw new PluginError(
      "PLUGIN_BROKEN",
      `${path} must export a default async function (args, context)`,
      { plugin: ref },
    );
  }
  return run as EntryFunction;
}

function commandList(manifest: PluginManifest): string {
  return Object.entries(manifest.commands)
    .map(([name, command]) => `${name} ${schemaCallShape(command.args)}`)
    .join(", ");
}

function describeArgs(
  schema: PluginManifest["commands"][string]["args"],
): string {
  const properties = schema?.properties || {};
  const required = new Set(schema?.required || []);
  const parts = Object.entries(properties).map(([name, property]) => {
    const type = Array.isArray(property.type)
      ? property.type.join("|")
      : property.type;
    const extras: string[] = [];
    if (property.enum)
      extras.push(property.enum.map((v) => JSON.stringify(v)).join("|"));
    if (property.default !== undefined)
      extras.push(`default ${JSON.stringify(property.default)}`);
    if (property.minimum !== undefined || property.maximum !== undefined) {
      extras.push(`${property.minimum ?? ""}..${property.maximum ?? ""}`);
    }
    return `${name}${required.has(name) ? "" : "?"}: ${type || "any"}${extras.length ? ` (${extras.join(", ")})` : ""}${property.description ? ` ${property.description}` : ""}`;
  });
  return parts.length ? parts.join("; ") : "none";
}
