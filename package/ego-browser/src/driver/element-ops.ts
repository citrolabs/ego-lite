import { cdp } from "../cdp-eval.js";
import { browserRefMap, ensureRefMapForRef } from "../ref-state.js";
import { resolveElementObjectId } from "../element-resolver.js";
import { parseRef } from "../ref-map.js";

/**
 * Run a v1 resolution in the top document first, then once more across the
 * Page's same-process iframes when nothing matched there.
 *
 * The v1 helpers resolve in the current Page session, where a role locator
 * reads only the top document's accessibility tree and a CSS locator queries
 * only the top document. Searching frames only after a miss keeps every
 * top-document result and ambiguity unchanged. A same-process frame shares
 * the Page session, so each frame maps to the default session (`undefined`)
 * and the resolver addresses it by frame id.
 */
export async function resolveInPageFrames<T>(
  selectorOrRef: string,
  resolve: (iframeSessions: Map<string, string | undefined>) => Promise<T>,
): Promise<T> {
  try {
    return await resolve(new Map());
  } catch (error) {
    if (
      typeof selectorOrRef !== "string" ||
      parseRef(selectorOrRef) ||
      !/ matched 0 elements/.test(error?.message || "")
    ) {
      throw error;
    }
    const iframeSessions = await sameProcessFrames();
    if (iframeSessions.size === 0) throw error;
    return resolve(iframeSessions);
  }
}

async function sameProcessFrames(): Promise<Map<string, string | undefined>> {
  const frames = new Map<string, string | undefined>();
  let tree;
  try {
    tree = (await cdp("Page.getFrameTree"))?.frameTree;
  } catch {
    return frames;
  }
  const visit = (node) => {
    for (const child of node?.childFrames || []) {
      if (typeof child?.frame?.id === "string") {
        frames.set(child.frame.id, undefined);
      }
      visit(child);
    }
  };
  visit(tree);
  return frames;
}

/**
 * Resolve any selector form to a CDP Runtime objectId handle.
 * Accepts @ref / ref=N, loc=css:/loc=role:/loc=href:, text=, xpath=, and raw
 * CSS — the same surface as the pointer/observe helpers, via the unified resolver.
 * Refreshes the RefMap on demand when the input is a ref and the map is empty.
 * @param {string} selectorOrRef Selector or ref string.
 * @returns {Promise<{objectId: string, sessionId?: string}>}
 */
export async function resolveHandle(selectorOrRef) {
  await ensureRefMapForRef(selectorOrRef);
  return resolveInPageFrames(selectorOrRef, (iframeSessions) =>
    resolveElementObjectId(
      { sendRaw: cdp },
      undefined,
      browserRefMap,
      selectorOrRef,
      iframeSessions,
    ),
  );
}

/**
 * Release a Runtime objectId handle. Best-effort: swallows "already gone"
 * errors (stale handle, lost session, destroyed context).
 * @param {string} objectId Runtime remote object id to release.
 * @param {string} [sessionId] Session that owns the handle.
 * @returns {Promise<void>}
 */
export async function releaseHandle(objectId, sessionId) {
  if (!objectId) return;
  try {
    await cdp("Runtime.releaseObject", { objectId }, sessionId);
  } catch {
    // Handle/session already invalid; releasing is best-effort.
  }
}

/**
 * Resolve a handle, run fn(handle), then release the handle — even if fn throws.
 * @param {string} selectorOrRef Selector or ref string.
 * @param {(handle: {objectId: string, sessionId?: string}) => Promise<any>} fn Callback bound to the resolved handle.
 * @returns {Promise<any>} Whatever fn returns.
 */
export async function withHandle(selectorOrRef, fn) {
  const handle = await resolveHandle(selectorOrRef);
  try {
    return await fn(handle);
  } finally {
    await releaseHandle(handle.objectId, handle.sessionId);
  }
}

/**
 * Resolve an element and call a function on it via Runtime.callFunctionOn,
 * with the element bound as `this`. The resolved handle is released afterward;
 * the returned objectId is already freed and must not be reused.
 * @param {string} selectorOrRef Selector or ref string.
 * @param {string} functionDeclaration Function source whose `this` is the element.
 * @param {Array<unknown>} [args=[]] Arguments passed by value.
 * @returns {Promise<{result: any, objectId: string, sessionId?: string}>}
 */
export async function resolveAndCall(
  selectorOrRef,
  functionDeclaration,
  args = [],
) {
  return withHandle(selectorOrRef, async ({ objectId, sessionId }) => {
    const result = await cdp(
      "Runtime.callFunctionOn",
      {
        functionDeclaration,
        objectId,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        awaitPromise: false,
      },
      sessionId,
    );
    return { result, objectId, sessionId };
  });
}
