import { createHash } from "node:crypto";

import type { JsonSchema } from "./json-schema.js";

/**
 * Plugin API generation this SDK implements. A plugin declares the generation
 * it was written for in `engines.egoPluginApi`; the SDK runs plugins up to
 * its own generation and skips newer ones.
 */
export const PLUGIN_API_VERSION = 1;

export const MANIFEST_FILE = "ego-plugin.json";

export type PluginCommandManifest = {
  entry: string;
  description: string;
  readOnly?: boolean;
  args?: JsonSchema;
  returns?: JsonSchema;
};

export type PluginManifest = {
  id: string;
  name?: string;
  version: string;
  description?: string;
  homepage?: string;
  engines?: { egoPluginApi?: number };
  /** Hostnames the plugin is written for; used for matching, not enforced. */
  domains: string[];
  commands: Record<string, PluginCommandManifest>;
};

/** A self-contained plugin package: the manifest plus every source file. */
export type PluginBundle = {
  format: 1;
  manifest: PluginManifest;
  files: Record<string, string>;
};

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*$/;
const COMMAND_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/** Throw a readable error unless `value` is a usable plugin manifest. */
export function validateManifest(
  value: unknown,
  source = MANIFEST_FILE,
): PluginManifest {
  const fail = (message: string): never => {
    throw new Error(`invalid plugin manifest ${source}: ${message}`);
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("expected a JSON object");
  }
  const manifest = value as PluginManifest;
  if (typeof manifest.id !== "string" || !ID_PATTERN.test(manifest.id)) {
    fail(
      'id must be lowercase letters, digits, "-" and "." (for example "x" or "example.blog")',
    );
  }
  if (
    typeof manifest.version !== "string" ||
    !VERSION_PATTERN.test(manifest.version)
  ) {
    fail("version must be MAJOR.MINOR.PATCH");
  }
  if (
    !Array.isArray(manifest.domains) ||
    manifest.domains.length === 0 ||
    manifest.domains.some(
      (domain) => typeof domain !== "string" || !/^[a-z0-9.-]+$/.test(domain),
    )
  ) {
    fail("domains must be a non-empty array of lowercase hostnames");
  }
  const api = manifest.engines?.egoPluginApi;
  if (api !== undefined && (!Number.isInteger(api) || api < 1)) {
    fail("engines.egoPluginApi must be a positive integer");
  }
  if (
    !manifest.commands ||
    typeof manifest.commands !== "object" ||
    Object.keys(manifest.commands).length === 0
  ) {
    fail("commands must declare at least one command");
  }
  for (const [name, command] of Object.entries(manifest.commands)) {
    if (!COMMAND_PATTERN.test(name)) {
      fail(
        `command name ${JSON.stringify(name)} must be lowercase letters, digits and "-"`,
      );
    }
    if (!command || typeof command !== "object") {
      fail(`command ${name} must be an object`);
    }
    if (
      typeof command.entry !== "string" ||
      !/\.m?js$/.test(command.entry) ||
      command.entry.startsWith("/") ||
      command.entry.split(/[\\/]/).includes("..")
    ) {
      fail(
        `command ${name} entry must be a relative .js or .mjs path inside the plugin`,
      );
    }
    if (typeof command.description !== "string" || !command.description) {
      fail(`command ${name} needs a description`);
    }
    for (const key of ["args", "returns"] as const) {
      const schema = command[key];
      if (schema !== undefined && (typeof schema !== "object" || !schema)) {
        fail(`command ${name} ${key} must be a JSON Schema object`);
      }
    }
  }
  return manifest;
}

export function isApiCompatible(manifest: PluginManifest): boolean {
  return (manifest.engines?.egoPluginApi ?? 1) <= PLUGIN_API_VERSION;
}

/** Compare MAJOR.MINOR.PATCH versions numerically. */
export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function majorOf(version: string): number {
  return Number(version.split(".")[0]) || 0;
}

/**
 * Content hash of a bundle. The same function hashes a downloaded bundle and
 * an installed directory, so tampering with installed files is detectable.
 * Keys are sorted so the hash does not depend on JSON formatting.
 */
export function bundleIntegrity(bundle: PluginBundle): string {
  const canonical = stableStringify({
    format: bundle.format,
    manifest: bundle.manifest,
    files: bundle.files,
  });
  return `sha256-${createHash("sha256").update(canonical).digest("hex")}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** True when `hostname` is one of `domains` or a subdomain of one. */
export function hostMatches(hostname: string, domains: string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return domains.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}

/** Hostname of a URL, or undefined for non-web URLs. */
export function urlHostname(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return parsed.hostname;
  } catch {
    return undefined;
  }
}

/** Split `"x/timeline"` into plugin id and command name. */
export function parseCommandRef(ref: unknown): { id: string; command: string } {
  if (typeof ref !== "string") {
    throw new TypeError(
      'page.runPlugin expects "pluginId/command" as its first argument, for example page.runPlugin("x/timeline", { user: "nasa" })',
    );
  }
  const slash = ref.lastIndexOf("/");
  const id = slash > 0 ? ref.slice(0, slash) : "";
  const command = slash > 0 ? ref.slice(slash + 1) : "";
  if (!ID_PATTERN.test(id) || !COMMAND_PATTERN.test(command)) {
    throw new TypeError(
      `page.runPlugin expects "pluginId/command", got ${JSON.stringify(ref)}`,
    );
  }
  return { id, command };
}
