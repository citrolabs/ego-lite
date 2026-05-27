import { parseRef } from "./ref-map.js";

export async function resolveElementCenter(cdp, sessionId, refMap, selectorOrRef, iframeSessions = new Map()) {
  const refId = parseRef(selectorOrRef);
  if (refId) {
    const entry = refMap.get(refId);
    if (!entry) {
      throw new Error(`Unknown ref: ${refId}`);
    }
    const effectiveSessionId = resolveFrameSession(entry.frameId, sessionId, iframeSessions);
    if (entry.backendNodeId !== undefined && entry.backendNodeId !== null) {
      try {
        const result = await send(cdp, "DOM.getBoxModel", { backendNodeId: entry.backendNodeId }, effectiveSessionId);
        return { ...boxModelCenter(result.model), sessionId: effectiveSessionId };
      } catch {
        // The backend node can become stale after DOM updates; fall back to role/name lookup below.
      }
    }
    const backendNodeId = await findBackendNodeIdByRoleName(cdp, sessionId, entry.role, entry.name, entry.nth, entry.frameId, iframeSessions);
    const result = await send(cdp, "DOM.getBoxModel", { backendNodeId }, effectiveSessionId);
    return { ...boxModelCenter(result.model), sessionId: effectiveSessionId };
  }

  const locator = parseLocator(selectorOrRef);
  if (locator) {
    return resolveLocatorCenter(cdp, sessionId, locator);
  }

  const result = await send(cdp, "Runtime.evaluate", {
    expression: buildSelectorCenterJs(selectorOrRef),
    returnByValue: true,
    awaitPromise: false
  }, sessionId);
  const value = result.result?.value;
  if (typeof value?.x !== "number" || typeof value?.y !== "number") {
    throw new Error(`Element not found: ${selectorOrRef}`);
  }
  return { x: value.x, y: value.y, sessionId };
}

export async function resolveElementObjectId(cdp, sessionId, refMap, selectorOrRef, iframeSessions = new Map()) {
  const refId = parseRef(selectorOrRef);
  if (refId) {
    const entry = refMap.get(refId);
    if (!entry) {
      throw new Error(`Unknown ref: ${refId}`);
    }
    const effectiveSessionId = resolveFrameSession(entry.frameId, sessionId, iframeSessions);
    if (entry.backendNodeId !== undefined && entry.backendNodeId !== null) {
      try {
        const result = await send(cdp, "DOM.resolveNode", {
          backendNodeId: entry.backendNodeId,
          objectGroup: "ego-browser"
        }, effectiveSessionId);
        const objectId = result.object?.objectId;
        if (objectId) {
          return { objectId, sessionId: effectiveSessionId };
        }
      } catch {
        // The backend node can become stale after DOM updates; fall back to role/name lookup below.
      }
    }
    const backendNodeId = await findBackendNodeIdByRoleName(cdp, sessionId, entry.role, entry.name, entry.nth, entry.frameId, iframeSessions);
    const result = await send(cdp, "DOM.resolveNode", { backendNodeId, objectGroup: "ego-browser" }, effectiveSessionId);
    const objectId = result.object?.objectId;
    if (!objectId) {
      throw new Error(`No objectId for ref ${refId}`);
    }
    return { objectId, sessionId: effectiveSessionId };
  }

  const locator = parseLocator(selectorOrRef);
  if (locator) {
    return resolveLocatorObjectId(cdp, sessionId, locator);
  }

  const result = await send(cdp, "Runtime.evaluate", {
    expression: buildFindElementJs(selectorOrRef),
    returnByValue: false,
    awaitPromise: false
  }, sessionId);
  const objectId = result.result?.objectId;
  if (!objectId) {
    throw new Error(`Element not found: ${selectorOrRef}`);
  }
  return { objectId, sessionId };
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

async function resolveLocatorCenter(cdp, sessionId, locator) {
  if (locator.kind === "role") {
    const backendNodeId = await findUniqueBackendNodeIdByRoleName(cdp, sessionId, locator.role, locator.name);
    const result = await send(cdp, "DOM.getBoxModel", { backendNodeId }, sessionId);
    return { ...boxModelCenter(result.model), sessionId };
  }
  const result = await send(cdp, "Runtime.evaluate", {
    expression: buildLocatorCenterJs(locator),
    returnByValue: true,
    awaitPromise: false
  }, sessionId);
  const value = result.result?.value;
  if (value?.error) {
    throw new Error(value.error);
  }
  if (typeof value?.x !== "number" || typeof value?.y !== "number") {
    throw new Error(`Element not found: ${locator.raw}`);
  }
  return { x: value.x, y: value.y, sessionId };
}

async function resolveLocatorObjectId(cdp, sessionId, locator) {
  if (locator.kind === "role") {
    const backendNodeId = await findUniqueBackendNodeIdByRoleName(cdp, sessionId, locator.role, locator.name);
    const result = await send(cdp, "DOM.resolveNode", { backendNodeId, objectGroup: "ego-browser" }, sessionId);
    const objectId = result.object?.objectId;
    if (!objectId) {
      throw new Error(`No objectId for locator ${locator.raw}`);
    }
    return { objectId, sessionId };
  }
  const count = await locatorCount(cdp, sessionId, locator);
  if (count !== 1) {
    throw new Error(`Locator ${locator.raw} matched ${count} elements`);
  }
  const result = await send(cdp, "Runtime.evaluate", {
    expression: buildLocatorFindJs(locator),
    returnByValue: false,
    awaitPromise: false
  }, sessionId);
  const objectId = result.result?.objectId;
  if (!objectId) {
    throw new Error(`Element not found: ${locator.raw}`);
  }
  return { objectId, sessionId };
}

async function locatorCount(cdp, sessionId, locator) {
  const result = await send(cdp, "Runtime.evaluate", {
    expression: buildLocatorCountJs(locator),
    returnByValue: true,
    awaitPromise: false
  }, sessionId);
  return Number(result.result?.value || 0);
}

async function findBackendNodeIdByRoleName(cdp, sessionId, role, name, nth = undefined, frameId = undefined, iframeSessions = new Map()) {
  const [params, effectiveSessionId] = resolveAxSession(frameId, sessionId, iframeSessions);
  const result = await send(cdp, "Accessibility.getFullAXTree", params, effectiveSessionId);
  const nthIndex = nth ?? 0;
  let matchCount = 0;
  for (const node of result.nodes || []) {
    if (node.ignored) {
      continue;
    }
    if (extractAxString(node.role) !== role || extractAxString(node.name) !== name) {
      continue;
    }
    if (matchCount === nthIndex) {
      if (node.backendDOMNodeId === undefined || node.backendDOMNodeId === null) {
        throw new Error(`AX node has no backendDOMNodeId for role=${role} name=${name}`);
      }
      return node.backendDOMNodeId;
    }
    matchCount += 1;
  }
  throw new Error(`Could not locate element with role=${role} name=${name}`);
}

async function findUniqueBackendNodeIdByRoleName(cdp, sessionId, role, name) {
  const result = await send(cdp, "Accessibility.getFullAXTree", {}, sessionId);
  const matches = [];
  for (const node of result.nodes || []) {
    if (node.ignored) {
      continue;
    }
    if (extractAxString(node.role) === role && extractAxString(node.name) === name) {
      matches.push(node);
    }
  }
  if (matches.length !== 1) {
    throw new Error(`Locator role:${role}[name=${JSON.stringify(name)}] matched ${matches.length} elements`);
  }
  const backendNodeId = matches[0].backendDOMNodeId;
  if (backendNodeId === undefined || backendNodeId === null) {
    throw new Error(`AX node has no backendDOMNodeId for role=${role} name=${name}`);
  }
  return backendNodeId;
}

function resolveAxSession(frameId, sessionId, iframeSessions) {
  if (!frameId) {
    return [{}, sessionId];
  }
  const iframeSession = iframeSessions instanceof Map ? iframeSessions.get(frameId) : iframeSessions?.[frameId];
  if (iframeSession) {
    return [{}, iframeSession];
  }
  return [{ frameId }, sessionId];
}

function buildFindElementJs(selector) {
  if (String(selector).startsWith("xpath=")) {
    return `document.evaluate(${JSON.stringify(String(selector).slice(6))}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`;
  }
  return `document.querySelector(${JSON.stringify(selector)})`;
}

function buildLocatorFindJs(locator) {
  if (locator.kind === "css") {
    return `document.querySelector(${JSON.stringify(locator.selector)})`;
  }
  return `(() => ${hrefElementsJs(locator.href)}[0] || null)()`;
}

function buildLocatorCountJs(locator) {
  if (locator.kind === "css") {
    return `document.querySelectorAll(${JSON.stringify(locator.selector)}).length`;
  }
  return `(() => ${hrefElementsJs(locator.href)}.length)()`;
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
  return `Array.from(document.querySelectorAll('a[href]')).filter((el) => {
            try {
              const u = new URL(el.href, location.href);
              const path = u.pathname + u.search + u.hash;
              return path === ${JSON.stringify(href)} || u.href === ${JSON.stringify(href)};
            } catch {
              return false;
            }
          })`;
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
  let value = String(input || "").trim();
  if (value.startsWith("loc=")) {
    value = value.slice(4);
  }
  if (value.startsWith("css:")) {
    const selector = value.slice(4);
    return selector ? { kind: "css", selector, raw: value } : null;
  }
  if (value.startsWith("href:")) {
    const href = value.slice(5);
    return href ? { kind: "href", href, raw: value } : null;
  }
  const roleMatch = /^role:([A-Za-z0-9_-]+)\[name=(.+)\]$/.exec(value);
  if (roleMatch) {
    return {
      kind: "role",
      role: roleMatch[1],
      name: parseLocatorName(roleMatch[2]),
      raw: value
    };
  }
  return null;
}

function parseLocatorName(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
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

function boxModelCenter(model: any = {}) {
  const content = model.content || [];
  if (content.length < 8) {
    return { x: 0, y: 0 };
  }
  return {
    x: (content[0] + content[2] + content[4] + content[6]) / 4,
    y: (content[1] + content[3] + content[5] + content[7]) / 4
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
