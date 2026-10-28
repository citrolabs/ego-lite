import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { agentWorkspace } from "../env.js";

export interface ToolArgSchema {
  type: string;
  required: boolean;
  description: string;
}

export interface ToolSchema {
  description: string;
  path: string;
  args: Record<string, ToolArgSchema>;
  returns: { type: string; description: string };
}

export interface NodeToolSchema extends ToolSchema {
  callable: string;
}

export interface LearningManifest {
  id: string;
  name: string;
  domains: string[];
  notes: string[];
  nodeTools?: Record<string, NodeToolSchema>;
  browserTools?: Record<string, ToolSchema>;
}

export interface LearningEntry {
  id: string;
  name: string;
  path: string;
  domains: string[];
  notes: string[];
  nodeTools: Record<string, NodeToolSchema>;
  browserTools: Record<string, ToolSchema>;
}

export interface LearnedContext {
  exists: boolean;
  siteId: string | null;
  siteName: string | null;
  domain: string;
  knowledge: LearnedKnowledgeNote[];
  tools: LearnedToolSignature[];
}

export interface LearnedKnowledgeNote {
  siteId: string;
  fileName: string;
  content: string;
}

export interface LearnedToolSignature {
  siteId: string;
  toolName: string;
  toolType: "node" | "browser";
  description: string;
  args: Record<string, ToolArgSchema>;
  example: string;
}

export function learningsRoot(workspace = agentWorkspace()) {
  return join(workspace, "learnings");
}

export const siteSkillsRoot = learningsRoot;

export async function checkDomainLearningExists(
  urlOrDomain: string,
  options: { root?: string; agentWorkspace?: string } = {},
) {
  const hostname = urlHostname(urlOrDomain);
  const root =
    options.root || learningsRoot(options.agentWorkspace || agentWorkspace());
  const matches = hostname ? await siteSkillsForUrl(hostname, { root }) : [];
  return {
    exists: matches.length > 0,
    hostname,
    root,
    matches,
  };
}

export async function checkLearningExists(
  siteId: string,
  options: { root?: string; agentWorkspace?: string } = {},
) {
  const root =
    options.root || learningsRoot(options.agentWorkspace || agentWorkspace());
  const siteDir = join(root, siteId);
  const manifestPath = join(siteDir, "manifest.json");
  const exists = await pathExists(manifestPath);
  return {
    exists,
    root,
    siteDir,
    manifestPath,
  };
}

export async function siteSkillsForUrl(url, options: any = {}) {
  const hostname = urlHostname(url);
  if (!hostname) {
    return [];
  }
  const root =
    options.root || learningsRoot(options.agentWorkspace || agentWorkspace());
  const matches = [];
  for (const siteDir of await iterLearningDirs(root)) {
    let manifest;
    try {
      manifest = await loadLearningManifest(siteDir);
    } catch {
      continue;
    }
    const domains = Array.isArray(manifest.domains) ? manifest.domains : [];
    if (
      domains.some(
        (domain) =>
          typeof domain === "string" && domainMatches(hostname, domain),
      )
    ) {
      matches.push(learningEntry(siteDir, manifest));
    }
  }
  return matches;
}

export async function iterLearningDirs(root: string) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => join(root, entry.name))
    .sort();
}

export async function loadLearningManifest(
  siteDir: string,
): Promise<LearningManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(siteDir, "manifest.json"), "utf8"));
  } catch (error) {
    throw new Error(
      `site skill ${JSON.stringify(siteDir)} has invalid or missing manifest.json: ${error.message}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `site skill ${JSON.stringify(siteDir)} manifest must be an object`,
    );
  }
  return parsed as LearningManifest;
}

export function learningEntry(
  siteDir: string,
  manifest: LearningManifest,
): LearningEntry {
  const notes = Array.isArray(manifest.notes) ? manifest.notes : [];
  return {
    id: manifest.id || siteDir.split(/[\\/]/).at(-1),
    name: manifest.name || manifest.id || siteDir.split(/[\\/]/).at(-1),
    path: siteDir,
    domains: Array.isArray(manifest.domains) ? [...manifest.domains] : [],
    notes: notes.map((note) => join(siteDir, note)),
    nodeTools: toolSchemasNode(manifest),
    browserTools: toolSchemasBrowser(manifest),
  };
}

export async function pathExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function urlHostname(url) {
  try {
    const parsed = String(url).includes("://")
      ? new URL(String(url))
      : new URL(`https://${url}`);
    return (parsed.hostname || "").toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

function domainMatches(hostname, pattern) {
  const normalized = String(pattern || "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (normalized.startsWith("*.")) {
    const suffix = normalized.slice(2);
    return hostname.endsWith(`.${suffix}`);
  }
  return hostname === normalized;
}

function toolSchemasNode(
  manifest: LearningManifest,
): Record<string, NodeToolSchema> {
  const value = manifest.nodeTools;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...value };
}

function toolSchemasBrowser(
  manifest: LearningManifest,
): Record<string, ToolSchema> {
  const value = manifest.browserTools;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...value };
}
