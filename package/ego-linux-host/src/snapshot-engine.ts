/**
 * AX tree → compact snapshot text + ref map for ego Linux host.
 *
 * Pure serializer (`axTreeToSnapshot`) for fixtures/unit tests.
 * `snapshotPage` loads Accessibility.getFullAXTree via CdpBridge.
 */

import type { CdpBridge } from "./cdp-bridge.js";
import { makeEgoError } from "./errors.js";

export type SnapshotOptions = {
  scope?: "only_within_viewport" | "full_page";
  includeActionMarks?: boolean;
  includeStableLocator?: boolean;
  maxResultLength?: number;
};

export type SnapshotRef = {
  id: number;
  backendNodeId: number;
  role?: string;
  name?: string;
};

export type SnapshotResult = {
  content: string;
  refs: SnapshotRef[];
};

/** Roles worth exposing as actionable / readable snapshot lines. */
const INTERESTING_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "option",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "heading",
  "StaticText",
  "image",
  "img",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "treeitem",
  "cell",
  "gridcell",
  "columnheader",
  "rowheader",
  "Row",
  "table",
  "listitem",
  "ListItem",
  "article",
  "navigation",
  "main",
  "banner",
  "contentinfo",
  "form",
  "dialog",
  "alertdialog",
  "alert",
  "status",
  "progressbar",
  "meter",
  "RootWebArea",
]);

/** Structural roles we only keep when they carry a non-empty name. */
const STRUCTURAL_IF_NAMED = new Set([
  "generic",
  "group",
  "none",
  "InlineTextBox",
  "LineBreak",
  "paragraph",
  "LabelText",
  "LegacyLayout",
]);

function extractAxString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "object") {
    const raw = (value as { value?: unknown }).value;
    if (typeof raw === "string") return raw;
    if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  }
  return "";
}

function nodeRole(node: any): string {
  return extractAxString(node?.role);
}

function nodeName(node: any): string {
  return extractAxString(node?.name);
}

function nodeBackendId(node: any): number | undefined {
  const id = node?.backendDOMNodeId ?? node?.backendNodeId;
  if (id === undefined || id === null) return undefined;
  const n = Number(id);
  return Number.isFinite(n) ? n : undefined;
}

function isInteresting(node: any): boolean {
  if (!node || typeof node !== "object") return false;
  if (node.ignored) return false;

  const backendNodeId = nodeBackendId(node);
  if (backendNodeId === undefined) return false;

  const role = nodeRole(node);
  const name = nodeName(node).trim();

  if (INTERESTING_ROLES.has(role)) {
    // RootWebArea always kept (page chrome); StaticText needs name
    if (role === "StaticText" || role === "InlineTextBox") {
      return name.length > 0;
    }
    return true;
  }

  if (STRUCTURAL_IF_NAMED.has(role)) {
    return name.length > 0;
  }

  // Unknown role with a name is still useful context
  return name.length > 0;
}

function formatLine(
  refId: number,
  role: string,
  name: string,
  includeActionMarks: boolean,
  includeStableLocator: boolean,
): string {
  const quoted = JSON.stringify(name);
  let line = includeActionMarks
    ? `@${refId} ${role} ${quoted}`
    : `${role} ${quoted}`;
  if (includeStableLocator && role && name) {
    const loc = `loc=role:${role}[name=${JSON.stringify(name)}]`;
    line += ` ${loc}`;
  }
  return line;
}

/**
 * Walk AX nodes; emit compact snapshot lines + sequential refs with backendNodeId.
 */
export function axTreeToSnapshot(
  axNodes: any[],
  options: SnapshotOptions = {},
): SnapshotResult {
  const includeActionMarks = options.includeActionMarks === true;
  const includeStableLocator = options.includeStableLocator === true;
  const maxResultLength = options.maxResultLength;

  const nodes = Array.isArray(axNodes) ? axNodes : [];
  const lines: string[] = [];
  const refs: SnapshotRef[] = [];
  let nextId = 1;

  for (const node of nodes) {
    if (!isInteresting(node)) continue;

    const role = nodeRole(node) || "unknown";
    const name = nodeName(node);
    const backendNodeId = nodeBackendId(node)!;
    const id = nextId++;

    refs.push({ id, backendNodeId, role, name });
    lines.push(
      formatLine(id, role, name, includeActionMarks, includeStableLocator),
    );
  }

  let content = lines.join("\n");
  if (
    typeof maxResultLength === "number" &&
    Number.isFinite(maxResultLength) &&
    maxResultLength >= 0 &&
    content.length > maxResultLength
  ) {
    content = content.slice(0, maxResultLength);
  }

  return { content, refs };
}

/**
 * Fetch full AX tree via CDP and serialize.
 * On any failure throws EGO_SNAPSHOT_FAILED.
 */
export async function snapshotPage(
  cdp: CdpBridge,
  sessionId: string,
  options?: SnapshotOptions,
): Promise<SnapshotResult> {
  try {
    await cdp.send("Accessibility.enable", {}, sessionId);
    const params: Record<string, unknown> = {};
    // scope is reserved for future viewport filtering; full tree for MVP
    void options?.scope;
    const result = await cdp.send(
      "Accessibility.getFullAXTree",
      params,
      sessionId,
    );
    const nodes = result?.nodes;
    if (!Array.isArray(nodes)) {
      throw makeEgoError(
        "EGO_SNAPSHOT_FAILED",
        "Accessibility.getFullAXTree returned no nodes array",
      );
    }
    return axTreeToSnapshot(nodes, options);
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      (err as { error_code?: string }).error_code === "EGO_SNAPSHOT_FAILED"
    ) {
      throw err;
    }
    const detail =
      err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : String(err);
    throw makeEgoError(
      "EGO_SNAPSHOT_FAILED",
      `Snapshot failed: ${detail}`,
    );
  }
}
