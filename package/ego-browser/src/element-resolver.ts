import { parseRef } from "./ref-map.js";
import {
  ACTION_TARGET_STATE_HELPERS,
  HIT_TARGET_HELPERS,
} from "./driver/action-target.js";

type ElementActionability =
  | "visible"
  | "enabled"
  | "pointer"
  | "pointer-enabled";
type PageRuntimeContext = {
  sessionId: string;
  frameId?: string;
  ownerFrameId?: string;
  contextId?: number;
};

export type LocatorBackendCandidate = {
  index: number;
  locator: string;
  backendNodeId: number;
  frameId?: string;
};

let snapshotLocatorBatchSequence = 0;

export class ElementResolutionError extends Error {
  kind: "transient" | "permanent";
  constructor(message: string, kind: "transient" | "permanent") {
    super(message);
    this.name = "ElementResolutionError";
    this.kind = kind;
  }
}

function exceptionText(result: any) {
  const d = result?.exceptionDetails;
  return d?.exception?.description || d?.text || "evaluation error";
}

function matchCountKind(message: string): "transient" | "permanent" {
  const m = /matched (\d+)/.exec(message);
  const n = m ? Number(m[1]) : 0;
  return n > 1 ? "permanent" : "transient";
}

export async function resolveElementCenter(
  cdp,
  sessionId,
  refMap,
  selectorOrRef,
  iframeSessions = new Map(),
) {
  const refId = parseRef(selectorOrRef);
  if (refId) {
    const entry = refMap.get(refId);
    if (!entry) {
      throw new ElementResolutionError(`Unknown ref: ${refId}`, "transient");
    }
    const effectiveSessionId = resolveFrameSession(
      entry.frameId,
      sessionId,
      iframeSessions,
    );
    if (entry.backendNodeId !== undefined && entry.backendNodeId !== null) {
      try {
        const result = await send(
          cdp,
          "DOM.getBoxModel",
          { backendNodeId: entry.backendNodeId },
          effectiveSessionId,
        );
        return {
          ...boxModelCenter(result.model),
          sessionId: effectiveSessionId,
        };
      } catch (error) {
        if (error instanceof ElementResolutionError) {
          // The node resolved but has no usable box model (not rendered yet).
          // Propagate the retryable state instead of falling back to role/name,
          // which could silently target a different node with the same label.
          throw error;
        }
        // The backend node can become stale after DOM updates; fall back to role/name lookup below.
      }
    }
    const backendNodeId = await findBackendNodeIdByRoleName(
      cdp,
      sessionId,
      entry.role,
      entry.name,
      entry.nth,
      entry.frameId,
      iframeSessions,
    );
    const result = await send(
      cdp,
      "DOM.getBoxModel",
      { backendNodeId },
      effectiveSessionId,
    );
    return { ...boxModelCenter(result.model), sessionId: effectiveSessionId };
  }

  const locator = parseLocatorOrThrow(selectorOrRef);
  if (locator) {
    return resolveLocatorCenter(cdp, sessionId, locator, iframeSessions);
  }

  for (const candidateSessionId of pageSessions(sessionId, iframeSessions)) {
    const result = await send(
      cdp,
      "Runtime.evaluate",
      {
        expression: buildSelectorCenterJs(selectorOrRef),
        returnByValue: true,
        awaitPromise: false,
      },
      candidateSessionId,
    );
    if (result.exceptionDetails) {
      throw invalidSelectorError(selectorOrRef, result);
    }
    const value = result.result?.value;
    if (typeof value?.x === "number" && typeof value?.y === "number") {
      return { x: value.x, y: value.y, sessionId: candidateSessionId };
    }
  }
  throw new ElementResolutionError(
    `Element not found: ${selectorOrRef}`,
    "transient",
  );
}

export async function resolveElementObjectId(
  cdp,
  sessionId,
  refMap,
  selectorOrRef,
  iframeSessions = new Map(),
  options: {
    strict?: boolean;
    strictGlobal?: boolean;
    actionability?: ElementActionability;
  } = {},
): Promise<{ objectId: string; sessionId: string; frameId?: string }> {
  const refId = parseRef(selectorOrRef);
  if (refId) {
    const entry = refMap.get(refId);
    if (!entry) {
      throw new ElementResolutionError(`Unknown ref: ${refId}`, "transient");
    }
    const effectiveSessionId = resolveFrameSession(
      entry.frameId,
      sessionId,
      iframeSessions,
    );
    if (entry.backendNodeId !== undefined && entry.backendNodeId !== null) {
      try {
        const result = await send(
          cdp,
          "DOM.resolveNode",
          {
            backendNodeId: entry.backendNodeId,
            objectGroup: "ego-browser",
          },
          effectiveSessionId,
        );
        const objectId = result.object?.objectId;
        if (objectId) {
          return {
            objectId,
            sessionId: effectiveSessionId,
            ...(entry.frameId ? { frameId: entry.frameId } : {}),
          };
        }
      } catch {
        // The backend node can become stale after DOM updates; fall back to role/name lookup below.
      }
    }
    const backendNodeId = await findBackendNodeIdByRoleName(
      cdp,
      sessionId,
      entry.role,
      entry.name,
      entry.nth,
      entry.frameId,
      iframeSessions,
    );
    const result = await send(
      cdp,
      "DOM.resolveNode",
      { backendNodeId, objectGroup: "ego-browser" },
      effectiveSessionId,
    );
    const objectId = result.object?.objectId;
    if (!objectId) {
      throw new ElementResolutionError(
        `No objectId for ref ${refId}`,
        "permanent",
      );
    }
    return {
      objectId,
      sessionId: effectiveSessionId,
      ...(entry.frameId ? { frameId: entry.frameId } : {}),
    };
  }

  const locator = parseLocatorOrThrow(selectorOrRef);
  if (locator) {
    return resolveLocatorObjectId(
      cdp,
      sessionId,
      locator,
      iframeSessions,
      options,
    );
  }

  const contexts = await runtimePageContexts(cdp, sessionId, iframeSessions);
  if (options.strict) {
    return resolveRawSelectorObjectId(
      cdp,
      contexts,
      parseRawSelector(selectorOrRef),
      { actionability: options.actionability },
    );
  }
  for (const context of contexts) {
    const result = await evaluateInContext(
      cdp,
      context,
      buildFindElementJs(selectorOrRef),
      false,
      "ego-browser",
    );
    if (result.exceptionDetails) {
      throw invalidSelectorError(selectorOrRef, result);
    }
    const objectId = result.result?.objectId;
    if (objectId) {
      return {
        objectId,
        sessionId: context.sessionId,
        ...(context.frameId ? { frameId: context.frameId } : {}),
      };
    }
  }
  throw new ElementResolutionError(
    `Element not found: ${selectorOrRef}`,
    "transient",
  );
}

/**
 * Validate many native snapshot locators together. DOM locator counts are
 * queried once per execution context, matching nodes are described in
 * parallel, and one object group releases every temporary handle.
 */
export async function validateLocatorBackendNodes(
  cdp,
  sessionId: string,
  iframeSessions: Map<string, string>,
  candidates: LocatorBackendCandidate[],
): Promise<Set<number>> {
  const parsed = candidates
    .map((candidate) => ({
      candidate,
      locator: parseLocator(candidate.locator),
    }))
    .filter((entry) => entry.locator);
  const roleCandidates = parsed.filter(
    (entry) => entry.locator.kind === "role",
  );
  const domCandidates = parsed.filter((entry) => entry.locator.kind !== "role");

  const [roleMatches, domMatches] = await Promise.all([
    validateRoleLocatorBackendNodes(
      cdp,
      sessionId,
      iframeSessions,
      roleCandidates,
    ),
    validateDomLocatorBackendNodes(
      cdp,
      sessionId,
      iframeSessions,
      domCandidates,
    ),
  ]);
  return new Set([...roleMatches, ...domMatches]);
}

async function validateRoleLocatorBackendNodes(
  cdp,
  sessionId,
  iframeSessions,
  entries,
): Promise<Set<number>> {
  const valid = new Set<number>();
  if (entries.length === 0) return valid;
  const available = (
    await Promise.all(
      pageContexts(sessionId, iframeSessions).map(async (context) => {
        try {
          const tree = await send(
            cdp,
            "Accessibility.getFullAXTree",
            context.frameId ? { frameId: context.frameId } : {},
            context.sessionId,
          );
          return { context, tree };
        } catch {
          // A detached frame must not discard locators from healthy contexts.
          return undefined;
        }
      }),
    )
  ).filter((item) => item !== undefined);

  for (const entry of entries) {
    const rawMatches = available.flatMap(({ context, tree }) =>
      (tree?.nodes || [])
        .filter(
          (node) =>
            !node.ignored &&
            normalizeRole(extractAxString(node.role)) === entry.locator.role &&
            roleNameMatches(
              extractAxString(node.name),
              entry.locator.name,
              entry.locator.nameMode,
            ) &&
            Number.isInteger(node.backendDOMNodeId),
        )
        .map((node) => ({
          backendNodeId: node.backendDOMNodeId,
          frameId: context.frameId,
          sessionId: context.sessionId,
        })),
    );
    const framedNodeKeys = new Set(
      rawMatches
        .filter((match) => match.frameId)
        .map((match) => `${match.sessionId}\u0000${match.backendNodeId}`),
    );
    const matches = rawMatches.filter(
      (match) =>
        match.frameId ||
        !framedNodeKeys.has(`${match.sessionId}\u0000${match.backendNodeId}`),
    );
    if (
      matches.length === 1 &&
      matches[0].backendNodeId === entry.candidate.backendNodeId &&
      locatorContextMatchesCandidate(
        matches[0],
        entry.candidate,
        sessionId,
        iframeSessions,
      )
    ) {
      valid.add(entry.candidate.index);
    }
  }
  return valid;
}

async function validateDomLocatorBackendNodes(
  cdp,
  sessionId,
  iframeSessions,
  entries,
): Promise<Set<number>> {
  const valid = new Set<number>();
  if (entries.length === 0) return valid;

  const candidateContexts = await availableRuntimePageContexts(
    cdp,
    sessionId,
    iframeSessions,
  );
  const countedContexts = (
    await Promise.all(
      candidateContexts.map(async (context) => {
        try {
          const result = await evaluateInContext(
            cdp,
            context,
            buildBatchLocatorCountJs(entries.map((entry) => entry.locator)),
            true,
          );
          const counts = result.result?.value;
          if (
            result.exceptionDetails ||
            !Array.isArray(counts) ||
            counts.length !== entries.length ||
            counts.some((count) => !Number.isInteger(count) || count < -1)
          ) {
            return undefined;
          }
          return { context, counts };
        } catch {
          // Count failures are scoped to the frame that disappeared.
          return undefined;
        }
      }),
    )
  ).filter((item) => item !== undefined);
  const contexts = countedContexts.map(({ context }) => context);
  const countsByContext = countedContexts.map(({ counts }) => counts);

  const contextForEntry = entries.map((_, entryIndex) => {
    let total = 0;
    let matchedContext = -1;
    for (let contextIndex = 0; contextIndex < contexts.length; contextIndex++) {
      const count = countsByContext[contextIndex][entryIndex];
      if (count < 0) return -1;
      total += count;
      if (count === 1) matchedContext = contextIndex;
    }
    return total === 1 ? matchedContext : -1;
  });
  const objectGroup = `ego-browser-snapshot-locators-${++snapshotLocatorBatchSequence}`;
  const usedSessions = new Set<string>();

  try {
    const resolved = (
      await Promise.all(
        contexts.map(async (context, contextIndex) => {
          const localEntries = entries
            .map((entry, entryIndex) => ({ entry, entryIndex }))
            .filter(
              ({ entryIndex }) => contextForEntry[entryIndex] === contextIndex,
            );
          if (localEntries.length === 0) return [];
          usedSessions.add(context.sessionId);
          try {
            const evaluated = await evaluateInContext(
              cdp,
              context,
              buildBatchLocatorObjectsJs(
                localEntries.map(({ entry }) => entry.locator),
              ),
              false,
              objectGroup,
            );
            const batchObjectId = evaluated.result?.objectId;
            if (!batchObjectId || evaluated.exceptionDetails) return [];
            const properties = await send(
              cdp,
              "Runtime.getProperties",
              { objectId: batchObjectId, ownProperties: true },
              context.sessionId,
            );
            return localEntries.flatMap(({ entry }, localIndex) => {
              const property = (properties.result || []).find(
                (candidate) => candidate.name === String(localIndex),
              );
              const objectId = property?.value?.objectId;
              return objectId ? [{ entry, context, objectId }] : [];
            });
          } catch {
            return [];
          }
        }),
      )
    ).flat();

    await Promise.all(
      resolved.map(async ({ entry, context, objectId }) => {
        try {
          const described = await send(
            cdp,
            "DOM.describeNode",
            { objectId, depth: 0 },
            context.sessionId,
          );
          if (
            described?.node?.backendNodeId === entry.candidate.backendNodeId &&
            locatorContextMatchesCandidate(
              context,
              entry.candidate,
              sessionId,
              iframeSessions,
            )
          ) {
            valid.add(entry.candidate.index);
          }
        } catch {
          // A stale node is unsafe to advertise as a stable locator.
        }
      }),
    );
  } finally {
    await Promise.all(
      [...usedSessions].map((candidateSessionId) =>
        send(
          cdp,
          "Runtime.releaseObjectGroup",
          { objectGroup },
          candidateSessionId,
        ).catch(() => {}),
      ),
    );
  }
  return valid;
}

function locatorContextMatchesCandidate(
  context,
  candidate,
  pageSessionId,
  iframeSessions,
): boolean {
  if (!candidate.frameId) return true;
  const expectedSessionId = resolveFrameSession(
    candidate.frameId,
    pageSessionId,
    iframeSessions,
  );
  const expectedFrameId =
    expectedSessionId === pageSessionId ? candidate.frameId : undefined;
  return (
    context.sessionId === expectedSessionId &&
    context.frameId === expectedFrameId
  );
}

async function resolveRawSelectorObjectId(
  cdp,
  contexts,
  selector,
  { actionability = undefined }: { actionability?: ElementActionability } = {},
) {
  const match = await findUniqueRawSelectorContext(cdp, contexts, selector, {
    actionability,
  });
  const result = await evaluateInContext(
    cdp,
    match,
    match.actionable
      ? `(() => ${buildActionableElementsJs(buildRawSelectorElementsJs(selector), actionability)}[0] || null)()`
      : buildFindElementJs(selector.raw),
    false,
    "ego-browser",
  );
  if (result.exceptionDetails) {
    throw invalidSelectorError(selector.raw, result);
  }
  const objectId = result.result?.objectId;
  if (!objectId) {
    throw new ElementResolutionError(
      `Element not found: ${selector.raw}`,
      "transient",
    );
  }
  return {
    objectId,
    sessionId: match.sessionId,
    ...(match.ownerFrameId || match.frameId
      ? { frameId: match.ownerFrameId || match.frameId }
      : {}),
  };
}

async function findUniqueRawSelectorContext(
  cdp,
  contexts,
  selector,
  { actionability = undefined }: { actionability?: ElementActionability } = {},
) {
  if (actionability) {
    const mainCount = await rawSelectorCount(cdp, contexts[0], selector);
    const mainActionable = mainCount
      ? await rawSelectorActionableCount(
          cdp,
          contexts[0],
          selector,
          actionability,
        )
      : 0;
    if (mainActionable === 1) {
      return { ...contexts[0], actionable: true };
    }
    if (mainActionable > 1) {
      throw await rawSelectorCountError(
        cdp,
        [contexts[0]],
        selector,
        mainCount,
      );
    }
    const matches = [];
    let totalCount = mainCount;
    let actionableCount = 0;
    for (const context of contexts.slice(1)) {
      const count = await rawSelectorCount(cdp, context, selector);
      totalCount += count;
      if (count === 0) continue;
      const actionable = await rawSelectorActionableCount(
        cdp,
        context,
        selector,
        actionability,
      );
      actionableCount += actionable;
      if (actionable > 0) matches.push({ ...context, actionable });
    }
    if (totalCount === 0) {
      throw new ElementResolutionError(
        `Selector ${selector.raw} matched 0 elements`,
        "transient",
      );
    }
    if (actionableCount === 1) {
      return { ...matches[0], actionable: true };
    }
    if (actionableCount === 0) {
      const blocker = await firstActionabilityBlocker(
        cdp,
        contexts,
        buildRawSelectorElementsJs(selector),
        actionability,
      );
      throw new ElementResolutionError(
        `Selector ${selector.raw} matched ${totalCount} elements, but none can receive input${blocker ? `; ${blocker}` : ""}`,
        "transient",
      );
    }
    throw await rawSelectorCountError(cdp, matches, selector, totalCount);
  }

  const mainCount = await rawSelectorCount(cdp, contexts[0], selector);
  if (mainCount > 1) {
    throw await rawSelectorCountError(cdp, [contexts[0]], selector, mainCount);
  }
  if (mainCount === 1) return contexts[0];

  const matches = [];
  let count = 0;
  for (const context of contexts.slice(1)) {
    const candidateCount = await rawSelectorCount(cdp, context, selector);
    count += candidateCount;
    if (candidateCount > 0) {
      matches.push({ count: candidateCount, ...context });
    }
  }
  if (count === 0) {
    throw new ElementResolutionError(
      `Selector ${selector.raw} matched 0 elements`,
      "transient",
    );
  }
  if (count > 1) {
    throw await rawSelectorCountError(cdp, matches, selector, count);
  }
  return matches[0];
}

async function rawSelectorCount(cdp, context, selector) {
  const result = await evaluateInContext(
    cdp,
    context,
    buildRawSelectorCountJs(selector),
    true,
  );
  if (result.exceptionDetails) {
    throw invalidSelectorError(selector.raw, result);
  }
  return Number(result.result?.value || 0);
}

async function rawSelectorActionableCount(
  cdp,
  context,
  selector,
  actionability: ElementActionability,
) {
  const result = await evaluateInContext(
    cdp,
    context,
    `(() => ${buildActionableElementsJs(buildRawSelectorElementsJs(selector), actionability)}.length)()`,
    true,
  );
  if (result.exceptionDetails) {
    throw invalidSelectorError(selector.raw, result);
  }
  return Number(result.result?.value || 0);
}

async function rawSelectorCountError(cdp, contexts, selector, count) {
  return ambiguityError(
    `Selector ${selector.raw} matched ${count} elements`,
    await collectMatchDiagnostics(
      cdp,
      contexts,
      buildRawSelectorElementsJs(selector),
    ),
  );
}

function invalidSelectorError(raw, result) {
  const hint = numericCssIdHint(raw);
  return new ElementResolutionError(
    `Invalid selector: ${raw}${hint ? `. ${hint}` : ""}: ${exceptionText(result)}`,
    "permanent",
  );
}

function numericCssIdHint(raw) {
  const value = String(raw || "").trim();
  const prefix = value.startsWith("loc=css:")
    ? "loc=css:"
    : value.startsWith("css:")
      ? "css:"
      : "";
  const match = /^#([0-9][A-Za-z0-9_-]*)$/.exec(value.slice(prefix.length));
  if (!match) return undefined;
  const selector = `[id=${JSON.stringify(match[1])}]`;
  return `CSS ids beginning with a digit must be escaped; use ${prefix}${selector}`;
}

function resolveFrameSession(frameId, sessionId, iframeSessions) {
  if (!frameId) {
    return sessionId;
  }
  if (iframeSessions instanceof Map) {
    return iframeSessions.get(frameId) || sessionId;
  }
  return iframeSessions?.[frameId] || sessionId;
}

function pageSessions(sessionId, iframeSessions) {
  const sessions = [sessionId];
  const frameSessionIds =
    iframeSessions instanceof Map
      ? iframeSessions.values()
      : Object.values(iframeSessions || {});
  for (const frameSessionId of frameSessionIds) {
    if (frameSessionId && !sessions.includes(frameSessionId)) {
      sessions.push(frameSessionId);
    }
  }
  return sessions;
}

function pageContexts(sessionId, iframeSessions) {
  const contexts: PageRuntimeContext[] = [
    { sessionId, frameId: undefined, ownerFrameId: undefined },
  ];
  const entries =
    iframeSessions instanceof Map
      ? iframeSessions.entries()
      : Object.entries(iframeSessions || {});
  for (const [frameId, frameSessionId] of entries) {
    contexts.push({
      sessionId: frameSessionId,
      frameId: frameSessionId === sessionId ? frameId : undefined,
      ownerFrameId: frameId,
    });
  }
  return contexts;
}

async function runtimePageContexts(
  cdp,
  sessionId,
  iframeSessions,
): Promise<PageRuntimeContext[]> {
  const contexts = pageContexts(sessionId, iframeSessions);
  return Promise.all(
    contexts.map((context) => runtimePageContext(cdp, context)),
  );
}

async function availableRuntimePageContexts(
  cdp,
  sessionId,
  iframeSessions,
): Promise<PageRuntimeContext[]> {
  const settled = await Promise.allSettled(
    pageContexts(sessionId, iframeSessions).map((context) =>
      runtimePageContext(cdp, context),
    ),
  );
  return settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
}

async function runtimePageContext(
  cdp,
  context: PageRuntimeContext,
): Promise<PageRuntimeContext> {
  if (!context.frameId) return context;
  try {
    const result = await send(
      cdp,
      "Page.createIsolatedWorld",
      {
        frameId: context.frameId,
        worldName: "ego-browser-locator",
        grantUniveralAccess: true,
      },
      context.sessionId,
    );
    if (!Number.isInteger(result?.executionContextId)) {
      throw new Error("Page.createIsolatedWorld returned no context id");
    }
    return { ...context, contextId: result.executionContextId };
  } catch (error) {
    throw new ElementResolutionError(
      `Frame ${context.frameId} is not ready: ${error?.message || String(error)}`,
      "transient",
    );
  }
}

function evaluateInContext(
  cdp,
  context: PageRuntimeContext,
  expression: string,
  returnByValue: boolean,
  objectGroup?: string,
) {
  return send(
    cdp,
    "Runtime.evaluate",
    {
      expression,
      returnByValue,
      awaitPromise: false,
      ...(context.contextId !== undefined
        ? { contextId: context.contextId }
        : {}),
      ...(objectGroup ? { objectGroup } : {}),
    },
    context.sessionId,
  );
}

async function resolveLocatorCenter(cdp, sessionId, locator, iframeSessions) {
  const sessions = pageSessions(sessionId, iframeSessions);
  if (locator.kind === "role") {
    const match = await findUniqueRoleMatch(
      cdp,
      pageContexts(sessionId, iframeSessions),
      locator.role,
      locator.name,
      locator.raw,
      { nameMode: locator.nameMode },
    );
    const result = await send(
      cdp,
      "DOM.getBoxModel",
      { backendNodeId: match.backendNodeId },
      match.sessionId,
    );
    return { ...boxModelCenter(result.model), sessionId: match.sessionId };
  }
  const match =
    sessions.length === 1
      ? { sessionId: sessions[0] }
      : await findUniqueLocatorContext(
          cdp,
          sessions.map((candidateSessionId) => ({
            sessionId: candidateSessionId,
          })),
          locator,
        );
  const result = await evaluateInContext(
    cdp,
    match,
    buildLocatorCenterJs(locator),
    true,
  );
  if (result.exceptionDetails) {
    throw new ElementResolutionError(
      `Invalid selector: ${locator.raw}: ${exceptionText(result)}`,
      "permanent",
    );
  }
  const value = result.result?.value;
  if (value?.error) {
    const kind = matchCountKind(value.error);
    if (kind === "permanent") {
      throw await locatorCountError(
        cdp,
        [match],
        locator,
        matchCount(value.error),
      );
    }
    throw new ElementResolutionError(value.error, kind);
  }
  if (typeof value?.x !== "number" || typeof value?.y !== "number") {
    throw new ElementResolutionError(
      `Element not found: ${locator.raw}`,
      "transient",
    );
  }
  return { x: value.x, y: value.y, sessionId: match.sessionId };
}

async function resolveLocatorObjectId(
  cdp,
  sessionId,
  locator,
  iframeSessions,
  options: {
    strictGlobal?: boolean;
    actionability?: ElementActionability;
  } = {},
) {
  if (locator.kind === "role") {
    const match = await findUniqueRoleMatch(
      cdp,
      pageContexts(sessionId, iframeSessions),
      locator.role,
      locator.name,
      locator.raw,
      {
        nameMode: locator.nameMode,
        strictGlobal: options.strictGlobal,
        actionability: options.actionability,
      },
    );
    const result = await send(
      cdp,
      "DOM.resolveNode",
      {
        backendNodeId: match.backendNodeId,
        objectGroup: "ego-browser",
      },
      match.sessionId,
    );
    const objectId = result.object?.objectId;
    if (!objectId) {
      throw new ElementResolutionError(
        `No objectId for locator ${locator.raw}`,
        "permanent",
      );
    }
    return {
      objectId,
      sessionId: match.sessionId,
      ...(match.ownerFrameId || match.frameId
        ? { frameId: match.ownerFrameId || match.frameId }
        : {}),
    };
  }
  const contexts = await runtimePageContexts(cdp, sessionId, iframeSessions);
  const match = await findUniqueLocatorContext(cdp, contexts, locator, {
    strictGlobal: options.strictGlobal,
    actionability: options.actionability,
  });
  const result = await evaluateInContext(
    cdp,
    match,
    match.actionable
      ? buildLocatorActionableFindJs(locator, options.actionability)
      : buildLocatorFindJs(locator),
    false,
    "ego-browser",
  );
  const objectId = result.result?.objectId;
  if (!objectId) {
    throw new ElementResolutionError(
      `Element not found: ${locator.raw}`,
      "transient",
    );
  }
  return {
    objectId,
    sessionId: match.sessionId,
    ...(match.ownerFrameId || match.frameId
      ? { frameId: match.ownerFrameId || match.frameId }
      : {}),
  };
}

async function findUniqueLocatorContext(
  cdp,
  contexts,
  locator,
  {
    strictGlobal = false,
    actionability = undefined,
  }: {
    strictGlobal?: boolean;
    actionability?: ElementActionability;
  } = {},
) {
  if (actionability) {
    const mainCount = await locatorCount(cdp, contexts[0], locator);
    const mainActionable = mainCount
      ? await locatorActionableCount(cdp, contexts[0], locator, actionability)
      : 0;
    if (mainActionable === 1) {
      return { count: 1, ...contexts[0], actionable: true };
    }
    if (mainActionable > 1) {
      throw await locatorCountError(cdp, [contexts[0]], locator, mainCount);
    }
    const matches = [];
    let totalCount = mainCount;
    let actionableCount = 0;
    for (const context of contexts.slice(1)) {
      const count = await locatorCount(cdp, context, locator);
      totalCount += count;
      if (count === 0) continue;
      const actionable = await locatorActionableCount(
        cdp,
        context,
        locator,
        actionability,
      );
      actionableCount += actionable;
      if (actionable > 0) {
        matches.push({
          count,
          actionable,
          ...context,
        });
      }
    }
    if (totalCount === 0) {
      throw new ElementResolutionError(
        `Locator ${locator.raw} matched 0 elements`,
        "transient",
      );
    }
    if (actionableCount === 1) {
      return { ...matches[0], count: 1, actionable: true };
    }
    if (actionableCount === 0) {
      const blocker = await firstActionabilityBlocker(
        cdp,
        contexts,
        buildLocatorElementsJs(locator),
        actionability,
      );
      throw new ElementResolutionError(
        `Locator ${locator.raw} matched ${totalCount} elements, but none can receive input${blocker ? `; ${blocker}` : ""}`,
        "transient",
      );
    }
    throw await locatorCountError(cdp, matches, locator, totalCount);
  }

  const matches = [];
  let count = 0;
  const mainCount = await locatorCount(cdp, contexts[0], locator);
  if (mainCount > 1 && !strictGlobal) {
    throw await locatorCountError(cdp, [contexts[0]], locator, mainCount);
  }
  if (mainCount === 1 && !strictGlobal) {
    return { count: 1, ...contexts[0] };
  }
  count += mainCount;
  if (mainCount > 0) {
    matches.push({ count: mainCount, ...contexts[0] });
  }

  for (const context of contexts.slice(1)) {
    const candidateCount = await locatorCount(cdp, context, locator);
    count += candidateCount;
    if (candidateCount > 0) {
      matches.push({ count: candidateCount, ...context });
    }
  }
  if (count === 0) {
    throw new ElementResolutionError(
      `Locator ${locator.raw} matched 0 elements`,
      "transient",
    );
  }
  if (count > 1) {
    throw await locatorCountError(cdp, matches, locator, count);
  }
  return matches[0];
}

async function findUniqueRoleMatch(
  cdp,
  contexts,
  role,
  name,
  raw,
  {
    nameMode = "exact",
    strictGlobal = false,
    actionability = undefined,
  }: {
    nameMode?: "exact" | "substring";
    strictGlobal?: boolean;
    actionability?: ElementActionability;
  } = {},
) {
  const matchesIn = async (selectedContexts) => {
    const matches = [];
    for (const context of selectedContexts) {
      const result = await send(
        cdp,
        "Accessibility.getFullAXTree",
        context.frameId ? { frameId: context.frameId } : {},
        context.sessionId,
      );
      for (const node of result.nodes || []) {
        if (
          !node.ignored &&
          normalizeRole(extractAxString(node.role)) === normalizeRole(role) &&
          roleNameMatches(extractAxString(node.name), name, nameMode) &&
          node.backendDOMNodeId !== undefined &&
          node.backendDOMNodeId !== null
        ) {
          matches.push({
            backendNodeId: node.backendDOMNodeId,
            frameId: context.frameId,
            ownerFrameId: context.ownerFrameId,
            sessionId: context.sessionId,
          });
        }
      }
    }
    return matches;
  };

  const rawMainMatches = await matchesIn(contexts.slice(0, 1));
  let cachedFrameMatches;
  const matchesWithFrameProvenance = async () => {
    cachedFrameMatches ||= matchesIn(contexts.slice(1));
    const frames = await cachedFrameMatches;
    const framedNodeKeys = new Set(
      frames
        .filter((match) => match.frameId)
        .map((match) => `${match.sessionId}\u0000${match.backendNodeId}`),
    );
    const main = rawMainMatches.filter(
      (match) =>
        !framedNodeKeys.has(`${match.sessionId}\u0000${match.backendNodeId}`),
    );
    return { main, frames };
  };
  if (strictGlobal) {
    const { main, frames } = await matchesWithFrameProvenance();
    const matches = [...main, ...frames];
    if (matches.length === 0) {
      throw new ElementResolutionError(
        `Locator ${raw} matched 0 elements`,
        "transient",
      );
    }
    if (matches.length === 1) return matches[0];
    throw ambiguityError(`Locator ${raw} matched ${matches.length} elements`);
  }

  if (!actionability) {
    const matches =
      rawMainMatches.length > 0
        ? rawMainMatches
        : (await matchesWithFrameProvenance()).frames;
    if (matches.length === 0) {
      throw new ElementResolutionError(
        `Locator ${raw} matched 0 elements`,
        "transient",
      );
    }
    if (matches.length === 1) return matches[0];
    throw ambiguityError(`Locator ${raw} matched ${matches.length} elements`);
  }

  const classify = async (matches) => {
    const actionable = [];
    let blocker;
    for (const match of matches) {
      const result = await roleMatchActionability(cdp, match, actionability);
      if (result.actionable) actionable.push(match);
      else blocker ||= result.blocker;
    }
    return { actionable, blocker };
  };
  const provenance = await matchesWithFrameProvenance();
  const mainMatches = provenance.main;
  const main = await classify(mainMatches);
  if (main.actionable.length === 1) return main.actionable[0];
  if (main.actionable.length > 1) {
    throw ambiguityError(
      `Locator ${raw} matched ${mainMatches.length} elements`,
    );
  }

  const frames = provenance.frames;
  const frame = await classify(frames);
  const total = mainMatches.length + frames.length;
  if (total === 0) {
    throw new ElementResolutionError(
      `Locator ${raw} matched 0 elements`,
      "transient",
    );
  }
  if (frame.actionable.length === 1) return frame.actionable[0];
  if (frame.actionable.length === 0) {
    const blocker = main.blocker || frame.blocker;
    throw new ElementResolutionError(
      `Locator ${raw} matched ${total} elements, but none can receive input${blocker ? `; ${blocker}` : ""}`,
      "transient",
    );
  }
  throw ambiguityError(`Locator ${raw} matched ${total} elements`);
}

/** Classify one AX match with the same rules used for DOM selectors. */
async function roleMatchActionability(
  cdp,
  match,
  actionability: ElementActionability,
): Promise<{ actionable: boolean; blocker?: string }> {
  let objectId;
  try {
    const resolved = await send(
      cdp,
      "DOM.resolveNode",
      {
        backendNodeId: match.backendNodeId,
        objectGroup: "ego-browser",
      },
      match.sessionId,
    );
    objectId = resolved.object?.objectId;
    if (!objectId) return { actionable: false };
    const result = await send(
      cdp,
      "Runtime.callFunctionOn",
      {
        functionDeclaration: `function() {
          ${actionabilityRequiresPointer(actionability) ? HIT_TARGET_HELPERS : ACTION_TARGET_STATE_HELPERS}
          if (!this.isConnected) return { actionable: false };
          const rect = this.getBoundingClientRect();
          const view = this.ownerDocument?.defaultView;
          if (!view || rect.width <= 0 || rect.height <= 0) return { actionable: false };
          const style = view.getComputedStyle(this);
          const visible = !this.closest?.("[hidden], [inert]") &&
            style.display !== "none" &&
            style.visibility !== "hidden";
          if (!visible) return { actionable: false };
          if (
            ${JSON.stringify(actionabilityRequiresEnabled(actionability))} &&
            isActionTargetDisabled(this)
          ) return { actionable: false, blocker: "element is disabled" };
          if (${JSON.stringify(actionabilityRequiresPointer(actionability))}) {
            const point = actionPointForElement(this);
            if (!point) return { actionable: false };
            if (!scrollRequestForPoint(this, point)) {
              const interceptor = interceptingElementAtPoint(this, point);
              if (interceptor) {
                return {
                  actionable: false,
                  blocker: describeHitTarget(interceptor) + " intercepts pointer events"
                };
              }
            }
          }
          return { actionable: true };
        }`,
        objectId,
        returnByValue: true,
        awaitPromise: false,
      },
      match.sessionId,
    );
    const value = result.result?.value;
    if (typeof value === "boolean") return { actionable: value };
    return {
      actionable: value?.actionable === true,
      ...(typeof value?.blocker === "string" ? { blocker: value.blocker } : {}),
    };
  } catch {
    return { actionable: false };
  } finally {
    if (objectId) {
      await send(
        cdp,
        "Runtime.releaseObject",
        { objectId },
        match.sessionId,
      ).catch(() => {});
    }
  }
}

async function locatorCount(cdp, context, locator) {
  const result = await evaluateInContext(
    cdp,
    context,
    buildLocatorCountJs(locator),
    true,
  );
  if (result.exceptionDetails) {
    throw new ElementResolutionError(
      `Invalid selector: ${locator.raw}: ${exceptionText(result)}`,
      "permanent",
    );
  }
  return Number(result.result?.value || 0);
}

async function locatorActionableCount(
  cdp,
  context,
  locator,
  actionability: ElementActionability,
) {
  const result = await evaluateInContext(
    cdp,
    context,
    buildLocatorActionableCountJs(locator, actionability),
    true,
  );
  if (result.exceptionDetails) {
    throw new ElementResolutionError(
      `Invalid selector: ${locator.raw}: ${exceptionText(result)}`,
      "permanent",
    );
  }
  return Number(result.result?.value || 0);
}

async function locatorCountError(cdp, contexts, locator, count) {
  if (locator.kind === "role") {
    return ambiguityError(`Locator ${locator.raw} matched ${count} elements`);
  }
  return ambiguityError(
    `Locator ${locator.raw} matched ${count} elements`,
    await collectMatchDiagnostics(
      cdp,
      contexts,
      buildLocatorElementsJs(locator),
    ),
  );
}

function matchCount(message) {
  const match = /matched (\d+)/.exec(message);
  return match ? Number(match[1]) : 0;
}

async function collectMatchDiagnostics(cdp, contexts, elementsExpression) {
  const combined: {
    visible: number;
    hidden: number;
    candidates: Array<{
      tag?: string;
      role?: string;
      name?: string;
      visible?: boolean;
      disabled?: boolean;
    }>;
  } = { visible: 0, hidden: 0, candidates: [] };
  try {
    for (const context of contexts) {
      const result = await evaluateInContext(
        cdp,
        context,
        buildMatchDiagnosticsJs(elementsExpression),
        true,
      );
      const value = result.result?.value;
      if (
        typeof value?.visible !== "number" ||
        typeof value?.hidden !== "number" ||
        !Array.isArray(value?.candidates)
      ) {
        continue;
      }
      combined.visible += value.visible;
      combined.hidden += value.hidden;
      combined.candidates.push(
        ...value.candidates.slice(0, 3 - combined.candidates.length),
      );
    }
    return combined.visible + combined.hidden > 0 ? combined : undefined;
  } catch {
    // Diagnostics must never replace the original strict-selector failure.
    return undefined;
  }
}

function ambiguityError(message, diagnostics = undefined) {
  const visibility = diagnostics
    ? ` (${diagnostics.visible} visible, ${diagnostics.hidden} hidden)`
    : "";
  const candidates = diagnostics?.candidates?.length
    ? ` Candidates: ${diagnostics.candidates
        .map(
          (candidate, index) => `${index + 1}. ${formatCandidate(candidate)}`,
        )
        .join("; ")}.`
    : "";
  return new ElementResolutionError(
    `${message}${visibility}.${candidates} Use a current snapshot ref or a more specific role, text, or CSS selector.`,
    "permanent",
  );
}

function formatCandidate(candidate) {
  const tag = candidate?.tag || "element";
  const role = candidate?.role ? ` role=${candidate.role}` : "";
  const name = candidate?.name ? ` ${JSON.stringify(candidate.name)}` : "";
  const states = [candidate?.visible === false ? "hidden" : "visible"];
  if (candidate?.disabled) states.push("disabled");
  return `${tag}${role}${name} (${states.join(", ")})`;
}

async function findBackendNodeIdByRoleName(
  cdp,
  sessionId,
  role,
  name,
  nth = undefined,
  frameId = undefined,
  iframeSessions = new Map(),
) {
  const [params, effectiveSessionId] = resolveAxSession(
    frameId,
    sessionId,
    iframeSessions,
  );
  const result = await send(
    cdp,
    "Accessibility.getFullAXTree",
    params,
    effectiveSessionId,
  );
  const nthIndex = nth ?? 0;
  let matchCount = 0;
  for (const node of result.nodes || []) {
    if (node.ignored) {
      continue;
    }
    if (
      normalizeRole(extractAxString(node.role)) !== normalizeRole(role) ||
      extractAxString(node.name) !== name
    ) {
      continue;
    }
    if (matchCount === nthIndex) {
      if (
        node.backendDOMNodeId === undefined ||
        node.backendDOMNodeId === null
      ) {
        throw new ElementResolutionError(
          `AX node has no backendDOMNodeId for role=${role} name=${name}`,
          "permanent",
        );
      }
      return node.backendDOMNodeId;
    }
    matchCount += 1;
  }
  throw new ElementResolutionError(
    `Could not locate element with role=${role} name=${name}`,
    "transient",
  );
}

async function findUniqueBackendNodeIdByRoleName(cdp, sessionId, role, name) {
  const result = await send(cdp, "Accessibility.getFullAXTree", {}, sessionId);
  const matches = [];
  for (const node of result.nodes || []) {
    if (node.ignored) {
      continue;
    }
    if (
      normalizeRole(extractAxString(node.role)) === normalizeRole(role) &&
      extractAxString(node.name) === name
    ) {
      matches.push(node);
    }
  }
  if (matches.length === 0) {
    throw new ElementResolutionError(
      `Locator role:${role}[name=${JSON.stringify(name)}] matched 0 elements`,
      "transient",
    );
  }
  if (matches.length > 1) {
    throw new ElementResolutionError(
      `Locator role:${role}[name=${JSON.stringify(name)}] matched ${matches.length} elements`,
      "permanent",
    );
  }
  const backendNodeId = matches[0].backendDOMNodeId;
  if (backendNodeId === undefined || backendNodeId === null) {
    throw new ElementResolutionError(
      `AX node has no backendDOMNodeId for role=${role} name=${name}`,
      "permanent",
    );
  }
  return backendNodeId;
}

function resolveAxSession(frameId, sessionId, iframeSessions) {
  if (!frameId) {
    return [{}, sessionId];
  }
  const iframeSession =
    iframeSessions instanceof Map
      ? iframeSessions.get(frameId)
      : iframeSessions?.[frameId];
  if (iframeSession && iframeSession !== sessionId) {
    return [{}, iframeSession];
  }
  return [{ frameId }, sessionId];
}

function buildFindElementJs(selector) {
  if (String(selector).startsWith("xpath=")) {
    return `document.evaluate(${JSON.stringify(String(selector).slice(6))}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`;
  }
  return buildCssFindJs(selector);
}

function parseRawSelector(input) {
  const raw = String(input);
  return raw.startsWith("xpath=")
    ? { kind: "xpath", selector: raw.slice(6), raw }
    : {
        kind: "css",
        selector: raw.startsWith("css=") ? raw.slice(4) : raw,
        raw,
      };
}

function buildRawSelectorCountJs(selector) {
  if (selector.kind === "xpath") {
    return `document.evaluate(${JSON.stringify(selector.selector)}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotLength`;
  }
  return buildCssCountJs(selector.selector);
}

function buildRawSelectorElementsJs(selector) {
  if (selector.kind === "xpath") {
    return `(() => {
              const result = document.evaluate(${JSON.stringify(selector.selector)}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
              return Array.from({ length: result.snapshotLength }, (_, index) => result.snapshotItem(index));
            })()`;
  }
  return buildCssQueryAllJs(selector.selector);
}

function buildLocatorFindJs(locator) {
  if (locator.kind === "css") {
    return buildCssFindJs(locator.selector);
  }
  if (locator.kind === "text") {
    return `(() => ${textElementsJs(locator)}[0] || null)()`;
  }
  if (locator.kind === "href") {
    return `(() => ${hrefElementsJs(locator.href)}[0] || null)()`;
  }
  return `(() => ${buildLocatorElementsJs(locator)}[0] || null)()`;
}

function buildLocatorActionableFindJs(
  locator,
  actionability: ElementActionability,
) {
  return `(() => ${buildActionableElementsJs(buildLocatorElementsJs(locator), actionability)}[0] || null)()`;
}

function buildLocatorActionableCountJs(
  locator,
  actionability: ElementActionability,
) {
  return `(() => ${buildActionableElementsJs(buildLocatorElementsJs(locator), actionability)}.length)()`;
}

function buildActionableElementsJs(
  elementsExpression,
  actionability: ElementActionability,
) {
  return `(() => {
            ${actionabilityRequiresPointer(actionability) ? HIT_TARGET_HELPERS : ACTION_TARGET_STATE_HELPERS}
            const __egoActionableMatches = Array.from(${elementsExpression} || []).filter((element) => {
              if (!element?.isConnected || element.closest?.("[hidden], [inert]")) return false;
              const view = element.ownerDocument?.defaultView;
              if (!view) return false;
              const rect = element.getBoundingClientRect();
              const style = view.getComputedStyle(element);
              const visible = rect.width > 0 && rect.height > 0 &&
                style.display !== "none" &&
                style.visibility !== "hidden";
              if (!visible) return false;
              if (
                ${JSON.stringify(actionabilityRequiresEnabled(actionability))} &&
                isActionTargetDisabled(element)
              ) return false;
              if (!${JSON.stringify(actionabilityRequiresPointer(actionability))}) return true;
              const point = actionPointForElement(element);
              if (!point) return false;
              return Boolean(scrollRequestForPoint(element, point)) ||
                !interceptingElementAtPoint(element, point);
            });
            return __egoActionableMatches;
          })()`;
}

async function firstActionabilityBlocker(
  cdp,
  contexts,
  elementsExpression,
  actionability: ElementActionability,
): Promise<string | undefined> {
  for (const context of contexts) {
    try {
      const result = await evaluateInContext(
        cdp,
        context,
        `(() => {
          ${actionabilityRequiresPointer(actionability) ? HIT_TARGET_HELPERS : ACTION_TARGET_STATE_HELPERS}
          for (const element of Array.from(${elementsExpression} || [])) {
            if (!element?.isConnected || element.closest?.("[hidden], [inert]")) continue;
            const view = element.ownerDocument?.defaultView;
            const rect = element.getBoundingClientRect();
            const style = view?.getComputedStyle(element);
            if (!view || rect.width <= 0 || rect.height <= 0 ||
                style.display === "none" || style.visibility === "hidden") continue;
            if (
              ${JSON.stringify(actionabilityRequiresEnabled(actionability))} &&
              isActionTargetDisabled(element)
            ) return "element is disabled";
            if (!${JSON.stringify(actionabilityRequiresPointer(actionability))}) continue;
            const point = actionPointForElement(element);
            if (!point) continue;
            if (scrollRequestForPoint(element, point)) continue;
            const interceptor = interceptingElementAtPoint(element, point);
            if (interceptor) {
              return describeHitTarget(interceptor) + " intercepts pointer events";
            }
          }
          return null;
        })()`,
        true,
      );
      if (typeof result.result?.value === "string") return result.result.value;
    } catch {
      // Keep the original actionability error when diagnostics fail.
    }
  }
  return undefined;
}

function buildLocatorCountJs(locator) {
  if (locator.kind === "css") {
    return buildCssCountJs(locator.selector);
  }
  if (locator.kind === "text") {
    return `(() => ${textElementsJs(locator)}.length)()`;
  }
  if (locator.kind === "href") {
    return `(() => ${hrefElementsJs(locator.href)}.length)()`;
  }
  return `(() => ${buildLocatorElementsJs(locator)}.length)()`;
}

function buildBatchLocatorCountJs(locators) {
  const queries = locators
    .map(
      (locator) =>
        `() => Array.from(${buildLocatorElementsJs(locator)} || []).length`,
    )
    .join(",\n");
  return `(() => {
            const queries = [${queries}];
            return queries.map((query) => {
              try {
                return query();
              } catch {
                return -1;
              }
            });
          })()`;
}

function buildBatchLocatorObjectsJs(locators) {
  return `(() => [${locators
    .map((locator) => buildLocatorFindJs(locator))
    .join(",\n")}])()`;
}

function buildLocatorElementsJs(locator) {
  if (locator.kind === "css") {
    return buildCssQueryAllJs(locator.selector);
  }
  if (locator.kind === "text") {
    return textElementsJs(locator);
  }
  if (locator.kind === "href") {
    return hrefElementsJs(locator.href);
  }
  if (locator.kind === "cssText") {
    return cssTextElementsJs(locator);
  }
  if (locator.kind === "nth") {
    return nthElementsJs(locator);
  }
  throw new Error(`Unsupported locator kind: ${locator.kind}`);
}

function buildMatchDiagnosticsJs(elementsExpression) {
  return `(() => {
            ${ACTION_TARGET_STATE_HELPERS}
            const __egoDescribeMatches = (values) => {
              const elements = Array.from(values || []).filter(Boolean);
              const normalize = (value) =>
                String(value ?? "").replace(/\\s+/g, " ").trim();
              const visible = (element) => {
                const style = getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return !element.closest("[hidden], [inert]") &&
                  style.display !== "none" &&
                  style.visibility !== "hidden" &&
                  style.opacity !== "0" &&
                  rect.width > 0 && rect.height > 0;
              };
              const candidates = elements.slice(0, 3).map((element) => {
                const isVisible = visible(element);
                const name = normalize(
                  element.getAttribute?.("aria-label") ||
                  element.getAttribute?.("alt") ||
                  element.getAttribute?.("title") ||
                  element.value ||
                  element.innerText ||
                  element.textContent
                ).slice(0, 80);
                return {
                  tag: String(element.tagName || "element").toLowerCase(),
                  role: element.getAttribute?.("role") || undefined,
                  name: name || undefined,
                  visible: isVisible,
                  disabled: isActionTargetDisabled(element)
                };
              });
              const visibleCount = elements.filter(visible).length;
              return {
                visible: visibleCount,
                hidden: elements.length - visibleCount,
                candidates
              };
            };
            return __egoDescribeMatches(${elementsExpression});
          })()`;
}

function actionabilityRequiresEnabled(
  actionability: ElementActionability,
): boolean {
  return actionability === "enabled" || actionability === "pointer-enabled";
}

function actionabilityRequiresPointer(
  actionability: ElementActionability,
): boolean {
  return actionability === "pointer" || actionability === "pointer-enabled";
}

function buildLocatorCenterJs(locator) {
  return `(() => {
            const count = ${buildLocatorCountJs(locator)};
            if (count !== 1) return { error: ${JSON.stringify(`Locator ${locator.raw} matched`)} + ' ' + count + ' elements' };
            const el = ${buildLocatorFindJs(locator)};
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        })()`;
}

function hrefElementsJs(href) {
  return `${buildCssQueryAllJs("a[href]")}.filter((el) => {
            try {
              const u = new URL(el.href, location.href);
              const path = u.pathname + u.search + u.hash;
              return path === ${JSON.stringify(href)} || u.href === ${JSON.stringify(href)};
            } catch {
              return false;
            }
          })`;
}

function cssTextElementsJs(locator) {
  return `(() => {
            const spec = {
              selector: ${JSON.stringify(locator.selector)},
              mode: ${JSON.stringify(locator.mode)},
              text: ${JSON.stringify(locator.text)}
            };
            const normalize = (value) =>
              String(value ?? "")
                .replace(/[\\u200b\\u00ad]/g, "")
                .replace(/[\\r\\n\\s\\t]+/g, " ")
                .trim();
            const expected = normalize(spec.text);
            const elements = ${buildCssQueryAllJs(locator.selector)};

            function shouldSkip(element) {
              return (
                element.tagName === "SCRIPT" ||
                element.tagName === "NOSCRIPT" ||
                element.tagName === "STYLE" ||
                document.head?.contains(element)
              );
            }

            function elementText(element) {
              if (shouldSkip(element)) {
                return { full: "", normalized: "", immediate: [] };
              }
              const type = String(element.getAttribute?.("type") || "").toLowerCase();
              if (element.tagName === "INPUT" && (type === "button" || type === "submit")) {
                const value = String(element.value || "");
                return { full: value, normalized: normalize(value), immediate: [value] };
              }

              let full = "";
              let currentImmediate = "";
              const immediate = [];
              const flushImmediate = () => {
                if (currentImmediate) immediate.push(currentImmediate);
                currentImmediate = "";
              };
              for (const child of element.childNodes) {
                if (child.nodeType === Node.TEXT_NODE) {
                  full += child.nodeValue || "";
                  currentImmediate += child.nodeValue || "";
                } else if (child.nodeType !== Node.COMMENT_NODE) {
                  flushImmediate();
                  if (child.nodeType === Node.ELEMENT_NODE) {
                    full += elementText(child).full;
                  }
                }
              }
              flushImmediate();
              if (element.shadowRoot) full += elementText(element.shadowRoot).full;
              return { full, normalized: normalize(full), immediate };
            }

            return elements.filter((element) => {
              const text = elementText(element);
              if (spec.mode === "exact") {
                return (
                  (expected === "" && text.immediate.length === 0) ||
                  text.immediate.some((value) => normalize(value) === expected)
                );
              }
              return text.normalized.toLowerCase().includes(expected.toLowerCase());
            });
          })()`;
}

function nthElementsJs(locator) {
  return `(() => {
            const values = Array.from(${buildLocatorElementsJs(locator.locator)} || []);
            const index = ${locator.index} === -1 ? values.length - 1 : ${locator.index};
            return index >= 0 && index < values.length ? [values[index]] : [];
          })()`;
}

function textElementsJs(locator) {
  return `(() => {
            ${OPEN_SHADOW_QUERY_HELPER}
            const spec = {
              mode: ${JSON.stringify(locator.mode)},
              text: ${JSON.stringify(locator.text)}
            };
            const normalize = (value) =>
              String(value ?? "").replace(/\\s+/g, " ").trim();
            const expected = normalize(spec.text);
            const excludedTags = new Set([
              "HEAD",
              "NOSCRIPT",
              "SCRIPT",
              "STYLE",
              "TEMPLATE",
              "TITLE"
            ]);
            const elements = __egoQueryAllOpenShadow("*").filter(
              (element) => !excludedTags.has(element.tagName)
            );

            function fullText(element) {
              const type = String(element.getAttribute?.("type") || "").toLowerCase();
              if (element.tagName === "INPUT" && (type === "button" || type === "submit")) {
                return normalize(element.value);
              }
              return normalize(element.textContent);
            }

            function immediateText(element) {
              const type = String(element.getAttribute?.("type") || "").toLowerCase();
              if (element.tagName === "INPUT" && (type === "button" || type === "submit")) {
                return normalize(element.value);
              }
              return normalize(
                [...element.childNodes]
                  .filter((node) => node.nodeType === Node.TEXT_NODE)
                  .map((node) => node.nodeValue)
                  .join(" ")
              );
            }

            function matches(element) {
              if (spec.mode === "exact") return immediateText(element) === expected;
              return fullText(element)
                .toLowerCase()
                .includes(expected.toLowerCase());
            }

            function isComposedDescendant(ancestor, node) {
              let current = node;
              while (current) {
                if (current === ancestor) return true;
                if (current.parentElement) {
                  current = current.parentElement;
                  continue;
                }
                const root = current.getRootNode?.();
                current = root instanceof ShadowRoot ? root.host : null;
              }
              return false;
            }

            const matchesByText = elements.filter(matches);
            return matchesByText.filter(
              (element) =>
                !matchesByText.some(
                  (other) =>
                    other !== element && isComposedDescendant(element, other)
                )
            );
          })()`;
}

// CSS locators from the native snapshot can point into an open shadow tree.
// Query every reachable tree scope so those locators have the same meaning
// when an action reuses them. XPath deliberately keeps document-only semantics.
const OPEN_SHADOW_QUERY_HELPER = `
  function __egoQueryAllOpenShadow(selector) {
    const matches = [];
    const roots = [document];
    while (roots.length) {
      const root = roots.pop();
      matches.push(...root.querySelectorAll(selector));
      const elements = root.querySelectorAll('*');
      for (let index = elements.length - 1; index >= 0; index -= 1) {
        const shadowRoot = elements[index].shadowRoot;
        if (shadowRoot) roots.push(shadowRoot);
      }
    }
    return matches;
  }
`;

function buildCssQueryAllJs(selector) {
  return `(() => {
            ${OPEN_SHADOW_QUERY_HELPER}
            return __egoQueryAllOpenShadow(${JSON.stringify(selector)});
          })()`;
}

function buildCssFindJs(selector) {
  return `(() => {
            ${OPEN_SHADOW_QUERY_HELPER}
            return __egoQueryAllOpenShadow(${JSON.stringify(selector)})[0] || null;
          })()`;
}

function buildCssCountJs(selector) {
  return `(() => {
            ${OPEN_SHADOW_QUERY_HELPER}
            return __egoQueryAllOpenShadow(${JSON.stringify(selector)}).length;
          })()`;
}

function buildSelectorCenterJs(selector) {
  const findExpr = buildFindElementJs(selector);
  return `(() => {
            const el = ${findExpr};
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        })()`;
}

function parseLocator(input) {
  const raw = String(input || "").trim();
  let value = raw;
  if (value.startsWith("loc=")) {
    value = value.slice(4);
  }

  const nth = parseTerminalNth(value);
  if (nth?.valid) {
    const locator = parseLocatorCore(nth.base, raw, true);
    if (!locator || locator.kind === "role" || locator.kind === "nth") {
      return null;
    }
    return { kind: "nth", locator, index: nth.index, raw };
  }
  if (nth) return null;

  return parseLocatorCore(value, raw, false);
}

function parseLocatorCore(value, raw, allowRawCss) {
  if (value.startsWith("css:")) {
    const selector = value.slice(4);
    return parseCssLocator(selector, raw);
  }
  if (value.startsWith("css=")) {
    const selector = value.slice(4);
    return parseCssLocator(selector, raw);
  }
  if (value.startsWith("href:")) {
    const href = value.slice(5);
    return href ? { kind: "href", href, raw } : null;
  }
  if (value.startsWith("text=")) {
    const body = value.slice(5).trim();
    if (!body) return null;
    const quoted =
      (body.startsWith('"') && body.endsWith('"')) ||
      (body.startsWith("'") && body.endsWith("'"));
    const text = quoted ? parseLocatorName(body) : body;
    return normalizeText(text)
      ? {
          kind: "text",
          mode: quoted ? "exact" : "substring",
          text,
          raw,
        }
      : null;
  }
  const roleMatch = /^role:([A-Za-z0-9_-]+)\[name(\*=|=)(.+)\]$/.exec(value);
  if (roleMatch) {
    return {
      kind: "role",
      role: normalizeRole(roleMatch[1]),
      nameMode: roleMatch[2] === "*=" ? "substring" : "exact",
      name: parseLocatorName(roleMatch[3]),
      raw,
    };
  }

  if (allowRawCss || hasTerminalCssTextPseudo(value)) {
    return parseCssLocator(value, raw);
  }
  return null;
}

function parseCssLocator(selector, raw) {
  const trimmed = selector.trim();
  if (!trimmed) return null;
  const text = parseTerminalCssText(trimmed);
  if (text?.valid) {
    return {
      kind: "cssText",
      selector: text.selector,
      mode: text.mode,
      text: text.text,
      raw,
    };
  }
  if (text) return null;
  if (containsUnquotedTextPseudo(trimmed)) return null;
  return { kind: "css", selector: trimmed, raw };
}

function parseLocatorOrThrow(input) {
  const locator = parseLocator(input);
  if (locator) return locator;

  const value = String(input || "").trim();
  if (
    value.startsWith("loc=") ||
    value.startsWith("role:") ||
    value.startsWith("text=") ||
    value.startsWith("css=") ||
    hasPlaywrightCompatibilitySyntax(value)
  ) {
    throw new ElementResolutionError(
      `Invalid locator: ${value}. Expected loc=role:<role>[name="<exact name>"], loc=role:<role>[name*="<name part>"], loc=css:<selector>, loc=href:<substring>, text=..., css=..., a terminal :has-text(...) or :text-is(...), or a terminal >> nth=N`,
      "permanent",
    );
  }
  return null;
}

function parseTerminalNth(value) {
  const separators = topLevelTokenPositions(value, ">>");
  if (separators.length === 0) return undefined;
  if (separators.length !== 1) return { valid: false };
  const position = separators[0];
  const base = value.slice(0, position).trim();
  const tail = value.slice(position + 2).trim();
  const match = /^nth=(-?\d+)$/.exec(tail);
  if (!base || !match) return { valid: false };
  const index = Number(match[1]);
  if (!Number.isSafeInteger(index) || index < -1) return { valid: false };
  return { valid: true, base, index };
}

function parseTerminalCssText(selector) {
  const pseudos = [
    { token: ":has-text(", mode: "substring" },
    { token: ":text-is(", mode: "exact" },
  ];
  for (let index = 0; index < selector.length; index += 1) {
    if (!isTopLevelPosition(selector, index)) continue;
    const pseudo = pseudos.find(({ token }) =>
      selector.startsWith(token, index),
    );
    if (!pseudo) continue;
    const open = index + pseudo.token.length - 1;
    const close = matchingParenPosition(selector, open);
    if (close === -1 || selector.slice(close + 1).trim()) {
      return { valid: false };
    }
    const base = selector.slice(0, index).trim();
    const argument = selector.slice(open + 1, close).trim();
    const string = parseCssString(argument);
    if (
      !base ||
      topLevelTokenPositions(base, ",").length > 0 ||
      !string.valid
    ) {
      return { valid: false };
    }
    return {
      valid: true,
      selector: base,
      mode: pseudo.mode,
      text: string.value,
    };
  }
  return undefined;
}

function hasTerminalCssTextPseudo(value) {
  return Boolean(parseTerminalCssText(value));
}

function hasPlaywrightCompatibilitySyntax(value) {
  return (
    containsUnquotedTextPseudo(value) ||
    topLevelTokenPositions(value, ">>").length > 0
  );
}

function containsUnquotedTextPseudo(value) {
  const tokens = [":has-text(", ":text-is("];
  let quote;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (tokens.some((token) => value.startsWith(token, index))) return true;
  }
  return false;
}

function topLevelTokenPositions(value, token) {
  const positions = [];
  let quote;
  let escaped = false;
  let bracketDepth = 0;
  let parenDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "[") bracketDepth += 1;
    else if (character === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (character === "(") parenDepth += 1;
    else if (character === ")") parenDepth = Math.max(0, parenDepth - 1);
    if (
      bracketDepth === 0 &&
      parenDepth === 0 &&
      value.startsWith(token, index)
    ) {
      positions.push(index);
      index += token.length - 1;
    }
  }
  return positions;
}

function isTopLevelPosition(value, position) {
  let quote;
  let escaped = false;
  let bracketDepth = 0;
  let parenDepth = 0;
  for (let index = 0; index < position; index += 1) {
    const character = value[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "[") {
      bracketDepth += 1;
    } else if (character === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (character === "(") {
      parenDepth += 1;
    } else if (character === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
    }
  }
  return !quote && bracketDepth === 0 && parenDepth === 0;
}

function matchingParenPosition(value, open) {
  let quote;
  let escaped = false;
  let depth = 0;
  for (let index = open; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")" && --depth === 0) return index;
  }
  return -1;
}

function parseCssString(value) {
  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || value.length < 2) {
    return { valid: false };
  }

  let decoded = "";
  for (let index = 1; index < value.length; index += 1) {
    const character = value[index];
    if (character === quote) {
      return index === value.length - 1
        ? { valid: true, value: decoded }
        : { valid: false };
    }
    if (character === "\n" || character === "\r" || character === "\f") {
      return { valid: false };
    }
    if (character !== "\\") {
      decoded += character;
      continue;
    }

    index += 1;
    if (index >= value.length) return { valid: false };
    if (value[index] === "\r" && value[index + 1] === "\n") index += 1;
    if (
      value[index] === "\n" ||
      value[index] === "\r" ||
      value[index] === "\f"
    ) {
      continue;
    }

    const hex = value.slice(index).match(/^[0-9a-fA-F]{1,6}/)?.[0];
    if (!hex) {
      decoded += value[index];
      continue;
    }
    index += hex.length - 1;
    const terminator = value[index + 1];
    if (terminator === "\r") {
      index += value[index + 2] === "\n" ? 2 : 1;
    } else if (
      terminator === "\n" ||
      terminator === "\f" ||
      terminator === "\t" ||
      terminator === " "
    ) {
      index += 1;
    }
    const codePoint = Number.parseInt(hex, 16);
    decoded +=
      codePoint === 0 || codePoint > 0x10ffff
        ? "\uFFFD"
        : String.fromCodePoint(codePoint);
  }
  return { valid: false };
}

function parseLocatorName(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function roleNameMatches(actual, expected, mode = "exact") {
  if (mode === "exact") return actual === expected;
  return normalizeText(actual)
    .toLowerCase()
    .includes(normalizeText(expected).toLowerCase());
}

function normalizeRole(value) {
  const role = String(value || "").toLowerCase();
  return (
    {
      listboxoption: "option",
      textfield: "textbox",
    }[role] || role
  );
}

function boxModelCenter(model: any = {}) {
  const content = model.content || [];
  if (content.length < 8) {
    // Returning a fake (0,0) here would silently click the viewport corner.
    // Treat a missing/degenerate box model as "element not ready" so callers
    // with retry semantics (waitForElement, ref fallback) can poll.
    throw new ElementResolutionError(
      "Element has no box model (not rendered or zero-sized)",
      "transient",
    );
  }
  return {
    x: (content[0] + content[2] + content[4] + content[6]) / 4,
    y: (content[1] + content[3] + content[5] + content[7]) / 4,
  };
}

function extractAxString(value) {
  const raw = value?.value;
  if (typeof raw === "string") {
    return raw;
  }
  if (typeof raw === "number" || typeof raw === "boolean") {
    return String(raw);
  }
  return "";
}

function send(cdp, method, params: any = {}, sessionId = undefined) {
  return cdp.sendRaw(method, params, sessionId);
}
