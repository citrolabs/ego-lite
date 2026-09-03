import { validateLocatorBackendNodes } from "./element-resolver.js";

type SnapshotRef = {
  backendNodeId?: number;
  frameId?: string;
  frameProvenance?: "page" | "frame" | "unknown";
  loc?: string;
  name?: string;
  refId?: number | string;
  role?: string;
};

type SnapshotResult = {
  content?: string;
  refs?: SnapshotRef[];
};

type SnapshotTreeNode = {
  text: string;
  children: SnapshotTreeNode[];
};

type CdpAdapter = {
  sendRaw(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<any>;
};

type SnapshotServices = {
  cdp(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<any>;
};

type SnapshotFrameContext = {
  frameId?: string;
  frameProvenance?: "page" | "frame" | "unknown";
};

/**
 * Remove redundant native snapshot wrappers without changing semantic nodes.
 *
 * Native output uses two-space indentation as its tree encoding. If an older
 * runtime returns another shape, leave it untouched instead of risking a
 * lossy rewrite.
 */
export function compactSnapshotContent(content: string): string {
  if (typeof content !== "string" || content.length === 0) return content;

  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = content.endsWith(newline);
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const rootIndex = lines.findIndex((line) => line.trim() === "root");
  if (rootIndex < 0) return content;

  const roots: SnapshotTreeNode[] = [];
  const stack: Array<{ indent: number; node: SnapshotTreeNode }> = [];
  for (const line of lines.slice(rootIndex)) {
    const indent = line.length - line.trimStart().length;
    if (indent % 2 !== 0) return content;

    const node: SnapshotTreeNode = { text: line.trim(), children: [] };
    while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
    if (stack.length) stack.at(-1)!.node.children.push(node);
    else roots.push(node);
    stack.push({ indent, node });
  }

  const compacted = roots.flatMap(compactSnapshotNode);
  const rendered = [
    ...lines.slice(0, rootIndex),
    ...renderSnapshotTree(compacted),
  ].join(newline);
  return rendered + (trailingNewline ? newline : "");
}

/** Compact textual content and omit native locator status sentinels. */
export function compactSnapshotResult(result: SnapshotResult): SnapshotResult {
  if (!result || typeof result !== "object") return result;
  if (typeof result.content === "string") {
    result.content = compactSnapshotContent(result.content);
  }
  for (const ref of result.refs || []) {
    if (ref.loc === "unstable" || ref.loc === "ambiguous") delete ref.loc;
  }
  return result;
}

/** Keep iframe roots visible while deferring their descendants in viewport snapshots. */
export function deferIframeSnapshotSubtrees(content: string): string {
  if (typeof content !== "string" || content.length === 0) return content;
  if (!content.split(/\r?\n/).some((line) => line.trim() === "root")) {
    return content;
  }

  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = content.endsWith(newline);
  const lines = content.split(/\r?\n/);
  if (trailingNewline) lines.pop();

  const output: string[] = [];
  let deferredIndent: number | undefined;
  for (const line of lines) {
    const text = line.trim();
    if (!text) {
      if (deferredIndent === undefined) output.push(line);
      continue;
    }

    const indent = line.length - line.trimStart().length;
    if (deferredIndent !== undefined && indent > deferredIndent) continue;
    deferredIndent = undefined;
    output.push(line);
    // Deferring is only safe when the iframe advertises a ref, because that ref
    // is the caller's only way back into the subtree. An unreferenced iframe
    // keeps its descendants inline rather than hiding them irrecoverably.
    if (/^iframe(?:\s|$)/.test(text) && snapshotLineRefId(line) !== undefined) {
      deferredIndent = indent;
    }
  }

  return output.join(newline) + (trailingNewline ? newline : "");
}

/** Keep only refs still advertised by the final rendered snapshot text. */
export function retainSnapshotRefsInContent(
  result: SnapshotResult,
): SnapshotResult {
  if (!Array.isArray(result?.refs) || typeof result.content !== "string") {
    return result;
  }

  const visibleRefIds = new Set<string>();
  for (const line of result.content.split(/\r?\n/)) {
    const refId = snapshotLineRefId(line);
    if (refId !== undefined) visibleRefIds.add(refId);
  }
  result.refs = result.refs.filter((ref) => {
    const refId = ref.refId ?? ref.backendNodeId;
    return refId !== undefined && visibleRefIds.has(String(refId));
  });
  return result;
}

function compactSnapshotNode(node: SnapshotTreeNode): SnapshotTreeNode[] {
  const text = omitUnusableLocatorStatus(node.text);
  const children = node.children.flatMap(compactSnapshotNode);
  if (isEmptySnapshotText(text)) return [];
  if (text === "container" && children.length === 0) return [];
  if (text === "container" && children.length === 1) return children;
  return [{ text, children }];
}

function omitUnusableLocatorStatus(text: string): string {
  const metadataIndex = findSnapshotMetadataStart(text);
  if (metadataIndex < 0) return text;

  const metadata = text.slice(metadataIndex);
  if (!metadata.endsWith("]")) return text;
  const compacted = metadata.replace(
    /^(\[ref=[^,\]]+),\s*loc=(?:unstable|ambiguous)(?=,|\])/,
    "$1",
  );
  return compacted === metadata
    ? text
    : `${text.slice(0, metadataIndex)}${compacted}`;
}

/**
 * Read the ref id a snapshot line advertises. Quote-aware, so a `[ref=` that
 * appears inside an accessible name is never mistaken for the line's metadata.
 */
function snapshotLineRefId(line: string): string | undefined {
  const metadataIndex = findSnapshotMetadataStart(line);
  if (metadataIndex < 0) return undefined;
  const match = line.slice(metadataIndex).match(/^\[ref=([^,\]]+)/);
  return match ? match[1] : undefined;
}

function findSnapshotMetadataStart(text: string): number {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (
      !quoted &&
      text.startsWith("[ref=", index) &&
      (index === 0 || /\s/.test(text[index - 1]))
    ) {
      return index;
    }
  }
  return -1;
}

function isEmptySnapshotText(text: string): boolean {
  if (text === "text") return true;
  const match = text.match(/^text\s+("(?:\\.|[^"\\])*")$/);
  if (!match) return false;
  try {
    const value = JSON.parse(match[1]);
    return (
      typeof value === "string" && value.replace(/[\s\p{Cf}]/gu, "") === ""
    );
  } catch {
    return false;
  }
}

function renderSnapshotTree(
  nodes: SnapshotTreeNode[],
  depth = 0,
  output: string[] = [],
): string[] {
  for (const node of nodes) {
    output.push(`${"  ".repeat(depth)}${node.text}`);
    renderSnapshotTree(node.children, depth + 1, output);
  }
  return output;
}

/** Return whether one advertised locator resolves uniquely to its source ref. */
export async function validateSnapshotLocator(
  cdp: CdpAdapter,
  pageSessionId: string,
  iframeSessions: Map<string, string>,
  ref: SnapshotRef,
): Promise<boolean> {
  const candidates = snapshotLocatorCandidates([ref]);
  if (candidates.length === 0) return false;
  const valid = await validateLocatorBackendNodes(
    cdp,
    pageSessionId,
    iframeSessions,
    candidates,
  );
  return valid.has(0);
}

/** Omit invalid native stable locators while retaining their short-lived refs. */
export async function sanitizeSnapshotLocators(
  result: SnapshotResult,
  validator: (ref: SnapshotRef) => Promise<boolean>,
): Promise<SnapshotResult> {
  if (!Array.isArray(result?.refs)) return result;

  const invalidLocators = new Map<string, Set<string>>();
  for (const ref of result.refs) {
    const locator = ref?.loc;
    if (
      typeof locator !== "string" ||
      locator === "unstable" ||
      locator === "ambiguous"
    ) {
      continue;
    }
    if (await validator(ref)) continue;

    delete ref.loc;
    const refId = ref.refId ?? ref.backendNodeId;
    if (refId !== undefined) {
      const refLocators = invalidLocators.get(String(refId)) ?? new Set();
      refLocators.add(locator);
      invalidLocators.set(String(refId), refLocators);
    }
  }
  if (typeof result.content === "string" && invalidLocators.size > 0) {
    result.content = omitSnapshotLocators(result.content, invalidLocators);
  }
  return result;
}

function omitSnapshotLocators(
  content: string,
  invalidLocators: Map<string, Set<string>>,
): string {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  return content
    .split(/\r?\n/)
    .map((line) => omitSnapshotLineLocator(line, invalidLocators))
    .join(newline);
}

function omitSnapshotLineLocator(
  text: string,
  invalidLocators: Map<string, Set<string>>,
): string {
  const metadataIndex = findSnapshotMetadataStart(text);
  if (metadataIndex < 0) return text;

  const metadata = text.slice(metadataIndex);
  if (!metadata.endsWith("]")) return text;
  const prefix = metadata.match(/^\[ref=([^,\]]+),\s*loc=/);
  if (!prefix) return text;

  const candidates = invalidLocators.get(prefix[1]);
  if (!candidates) return text;
  for (const locator of candidates) {
    const locatorEnd = prefix[0].length + locator.length;
    if (
      metadata.startsWith(locator, prefix[0].length) &&
      (metadata[locatorEnd] === "," || metadata[locatorEnd] === "]")
    ) {
      return `${text.slice(0, metadataIndex)}[ref=${prefix[1]}${metadata.slice(locatorEnd)}`;
    }
  }
  return text;
}

/** Preserve native frame provenance and validate stable locators for the Page API. */
export async function preparePageSnapshotResult(
  services: SnapshotServices,
  pageSessionId: string,
  iframeSessions: Map<string, string>,
  result: SnapshotResult,
  rootContext: SnapshotFrameContext = {},
): Promise<SnapshotResult> {
  const adapter: CdpAdapter = {
    sendRaw: (method, params = {}, sessionId) =>
      services.cdp(method, params, sessionId),
  };
  const refs = result?.refs || [];
  const descendantRefIds =
    typeof result?.content === "string"
      ? iframeDescendantRefIds(result.content)
      : new Set<string>();
  const validIndexes = await validateLocatorBackendNodes(
    adapter,
    pageSessionId,
    iframeSessions,
    snapshotLocatorCandidates(refs),
  );
  const validRefs = new Set(refs.filter((_, index) => validIndexes.has(index)));
  await backfillSnapshotFrameIds(
    adapter,
    pageSessionId,
    iframeSessions,
    result,
    descendantRefIds,
  );
  for (const ref of refs) {
    const refId = ref.refId ?? ref.backendNodeId;
    if (ref.frameId) {
      ref.frameProvenance = "frame";
    } else if (refId !== undefined && descendantRefIds.has(String(refId))) {
      ref.frameProvenance = "unknown";
    } else if (rootContext.frameId) {
      ref.frameId = rootContext.frameId;
      ref.frameProvenance = "frame";
    } else {
      // A subtree root with frame provenance always carries a frameId, so the
      // remaining cases are a page-owned root or one whose frame is unknown.
      ref.frameProvenance = rootContext.frameProvenance ?? "page";
    }
  }
  return sanitizeSnapshotLocators(result, async (ref) => validRefs.has(ref));
}

async function backfillSnapshotFrameIds(
  cdp: CdpAdapter,
  pageSessionId: string,
  iframeSessions: Map<string, string>,
  result: SnapshotResult,
  descendantRefIds: Set<string>,
): Promise<void> {
  if (iframeSessions.size === 0 || typeof result.content !== "string") return;

  const missing = (result.refs || []).filter((ref) => {
    const refId = ref.refId ?? ref.backendNodeId;
    return (
      !ref.frameId && refId !== undefined && descendantRefIds.has(String(refId))
    );
  });
  if (missing.length === 0) return;

  const frameIds = [...iframeSessions.keys()];
  // One frame admits no ambiguity to resolve, and the refs that most need a
  // frame here are the ones with no usable locator to validate against.
  if (frameIds.length === 1) {
    for (const ref of missing) ref.frameId = frameIds[0];
    return;
  }

  const owners = new Map<number, { frameId: string; ref: SnapshotRef }>();
  const candidates: Array<{
    index: number;
    locator: string;
    backendNodeId: number;
    frameId: string;
  }> = [];
  for (const ref of missing) {
    const base = snapshotLocatorCandidates([ref])[0];
    if (!base) continue;
    for (const frameId of frameIds) {
      const index = candidates.length;
      candidates.push({ ...base, index, frameId });
      owners.set(index, { frameId, ref });
    }
  }

  const valid = await validateLocatorBackendNodes(
    cdp,
    pageSessionId,
    iframeSessions,
    candidates,
  );
  const matches = new Map<SnapshotRef, Set<string>>();
  for (const index of valid) {
    const owner = owners.get(index);
    if (!owner) continue;
    const frameMatches = matches.get(owner.ref) ?? new Set<string>();
    frameMatches.add(owner.frameId);
    matches.set(owner.ref, frameMatches);
  }
  for (const [ref, frameMatches] of matches) {
    if (frameMatches.size === 1) ref.frameId = [...frameMatches][0];
  }
}

function iframeDescendantRefIds(content: string): Set<string> {
  const refs = new Set<string>();
  let iframeIndent: number | undefined;
  let frameRootIndent: number | undefined;
  for (const line of content.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    const indent = line.length - line.trimStart().length;
    const startsIframe = /^iframe(?:\s|$)/.test(text);

    if (iframeIndent === undefined) {
      if (startsIframe) iframeIndent = indent;
      continue;
    }

    if (frameRootIndent === undefined) {
      if (/^root(?:\s|$)/.test(text) && indent >= iframeIndent) {
        frameRootIndent = indent;
      } else if (indent <= iframeIndent) {
        iframeIndent = startsIframe ? indent : undefined;
      }
      continue;
    }

    if (indent <= frameRootIndent) {
      iframeIndent = startsIframe ? indent : undefined;
      frameRootIndent = undefined;
      continue;
    }

    const refId = snapshotLineRefId(line);
    if (refId !== undefined) refs.add(refId);
  }
  return refs;
}

function snapshotLocatorCandidates(refs: SnapshotRef[]) {
  return refs.flatMap((ref, index) => {
    if (
      !Number.isInteger(ref.backendNodeId) ||
      typeof ref.loc !== "string" ||
      ref.loc.length === 0 ||
      ref.loc === "unstable" ||
      ref.loc === "ambiguous"
    ) {
      return [];
    }
    return [
      {
        index,
        locator: ref.loc.startsWith("loc=") ? ref.loc : `loc=${ref.loc}`,
        backendNodeId: ref.backendNodeId!,
        ...(ref.frameId ? { frameId: ref.frameId } : {}),
      },
    ];
  });
}
