import { validateLocatorBackendNodes } from "./element-resolver.js";

type SnapshotRef = {
  backendNodeId?: number;
  frameId?: string;
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

/**
 * Add frame provenance that older native snapshots omit.
 *
 * One AX-tree read per frame is enough to map every unique backend node in the
 * snapshot. Repeated backend ids cannot be disambiguated without native
 * `refId`/`frameId` support, so those refs deliberately remain unscoped.
 */
export async function enrichSnapshotRefFrames(
  services: SnapshotServices,
  pageSessionId: string,
  iframeSessions: Map<string, string>,
  refs: SnapshotRef[] = [],
): Promise<void> {
  if (!(iframeSessions instanceof Map) || iframeSessions.size === 0) return;

  const refsByBackendNode = new Map<number, SnapshotRef[]>();
  for (const ref of refs) {
    if (ref.frameId || !Number.isInteger(ref.backendNodeId)) continue;
    const matches = refsByBackendNode.get(ref.backendNodeId!) || [];
    matches.push(ref);
    refsByBackendNode.set(ref.backendNodeId!, matches);
  }
  if (refsByBackendNode.size === 0) return;

  const pageOwner = "";
  const ownersByRef = new Map(
    [...refsByBackendNode.values()]
      .flat()
      .map((ref) => [ref, new Set<string>()]),
  );
  const contexts = [
    { frameId: pageOwner, sessionId: pageSessionId, params: {} },
    ...[...iframeSessions].map(([frameId, frameSessionId]) => ({
      frameId,
      sessionId: frameSessionId,
      params: frameSessionId === pageSessionId ? { frameId } : {},
    })),
  ];

  for (const context of contexts) {
    let tree;
    try {
      tree = await services.cdp(
        "Accessibility.getFullAXTree",
        context.params,
        context.sessionId,
      );
    } catch {
      // Incomplete ownership data cannot safely disambiguate renderer-local ids.
      return;
    }
    for (const node of tree?.nodes || []) {
      const backendNodeId = node?.backendDOMNodeId;
      const matches = refsByBackendNode.get(backendNodeId);
      if (!matches || node?.ignored) continue;
      for (const ref of matches) {
        if (!snapshotRefMatchesAxNode(ref, node)) continue;
        ownersByRef.get(ref)?.add(context.frameId);
      }
    }
  }

  for (const [ref, owners] of ownersByRef) {
    if (owners.size !== 1) continue;
    const [frameId] = owners;
    if (frameId) ref.frameId = frameId;
  }
}

function snapshotRefMatchesAxNode(ref: SnapshotRef, node: any): boolean {
  if (
    typeof ref.role === "string" &&
    normalizeSnapshotRole(axValue(node?.role)) !==
      normalizeSnapshotRole(ref.role)
  ) {
    return false;
  }
  return typeof ref.name !== "string" || axValue(node?.name) === ref.name;
}

function normalizeSnapshotRole(value: unknown): string {
  const role = String(value || "").toLowerCase();
  return (
    {
      listboxoption: "option",
      textfield: "textbox",
    }[role] || role
  );
}

function axValue(value: any): string {
  const raw = value?.value ?? value;
  return typeof raw === "string" ||
    typeof raw === "number" ||
    typeof raw === "boolean"
    ? String(raw)
    : "";
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

/** Add frame provenance and validate stable locators for the Page API. */
export async function preparePageSnapshotResult(
  services: SnapshotServices,
  pageSessionId: string,
  iframeSessions: Map<string, string>,
  result: SnapshotResult,
): Promise<SnapshotResult> {
  await enrichSnapshotRefFrames(
    services,
    pageSessionId,
    iframeSessions,
    result?.refs || [],
  );
  const adapter: CdpAdapter = {
    sendRaw: (method, params = {}, sessionId) =>
      services.cdp(method, params, sessionId),
  };
  const refs = result?.refs || [];
  const validIndexes = await validateLocatorBackendNodes(
    adapter,
    pageSessionId,
    iframeSessions,
    snapshotLocatorCandidates(refs),
  );
  const validRefs = new Set(refs.filter((_, index) => validIndexes.has(index)));
  return sanitizeSnapshotLocators(result, async (ref) => validRefs.has(ref));
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
