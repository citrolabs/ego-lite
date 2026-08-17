type ParamInfo = {
  name: string;
  type: string | null;
  description: string | null;
  optional: boolean;
  rest: boolean;
  default: string | null;
};

type HelperDoc = {
  name: string;
  signature: string;
  description: string | null;
  params: ParamInfo[];
  returns: string | null;
  async: boolean;
};

// Helper docs are extracted from the bundle at build time and injected here by
// scripts/build.mjs, which replaces the placeholder below with a JSON string.
// The runtime must never introspect its own source: in the shipped browser the
// SDK is loaded from a compiled .pak resource whose import.meta.url is
// "ego://services/node/resources/index.js", which is not a readable file, so
// the previous readFileSync(fileURLToPath(import.meta.url)) approach silently
// produced an empty docs map. See GitHub issue #84.
const EMBEDDED_DOCS_JSON = "__EGO_EMBEDDED_HELP_DOCS__";

let cache: Map<string, HelperDoc> | null = null;

export function help(
  helpers: Record<string, unknown>,
  ...names: string[]
): HelperDoc | HelperDoc[] | string {
  const docs = getDocsMap();
  if (names.length === 0) {
    const fromDocs = [...docs.values()].filter((d) => d.name in helpers);
    if (fromDocs.length > 0) return fromDocs;
    return listFallbackDocs(helpers);
  }
  if (names.length === 1) {
    const name = names[0];
    const doc = docs.get(name) || fallbackDoc(name, helpers[name]);
    if (!doc) return `Unknown helper: ${name}`;
    return doc;
  }
  return names.map((n) => docs.get(n) || fallbackDoc(n, helpers[n]) || emptyDoc(n));
}

export function formatHelp(doc: HelperDoc): string {
  const lines: string[] = [];
  if (doc.description) {
    lines.push(doc.description);
  }
  for (const p of doc.params) {
    const opt = p.optional ? "?" : "";
    const type = p.type ? `: ${p.type}` : "";
    const desc = p.description ? ` — ${p.description}` : "";
    const def = p.default ? ` (default: ${p.default})` : "";
    lines.push(
      `@param ${p.rest ? "..." : ""}${p.name}${opt}${type}${desc}${def}`,
    );
  }
  if (doc.returns) {
    lines.push(`@returns ${doc.returns}`);
  }
  lines.push("");
  lines.push(doc.signature);
  return lines.join("\n");
}

function getDocsMap(): Map<string, HelperDoc> {
  if (cache) return cache;
  cache = new Map();
  for (const doc of parseEmbeddedDocs(EMBEDDED_DOCS_JSON)) {
    cache.set(doc.name, doc);
  }
  return cache;
}

function parseEmbeddedDocs(raw: string): HelperDoc[] {
  // If the build injection did not run (e.g. importing raw TypeScript), `raw`
  // is still the placeholder and JSON.parse throws; there are simply no docs.
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function listFallbackDocs(helpers: Record<string, unknown>): HelperDoc[] {
  return Object.keys(helpers)
    .filter((name) => name !== "help" && typeof helpers[name] === "function")
    .sort()
    .map((name) => fallbackDoc(name, helpers[name]))
    .filter((doc): doc is HelperDoc => Boolean(doc));
}

function fallbackDoc(name: string, value: unknown): HelperDoc | null {
  if (typeof value !== "function") return null;
  const src = Function.prototype.toString.call(value);
  const isAsync = /^\s*async\b/.test(src);
  const paramMatch =
    src.match(/^(?:async\s+)?(?:function[\s\w$]*)?\s*\(([^)]*)\)/) ||
    src.match(/^(?:async\s*)?\(([^)]*)\)\s*=>/);
  const rawParams = paramMatch?.[1]?.trim() ?? "";
  const paramNames = rawParams
    ? rawParams
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
    : [];
  const params: ParamInfo[] = paramNames.map((part) => ({
    name: part.replace(/^\.\.\./, "").replace(/\s*=[\s\S]*$/, "") || part,
    type: null,
    description: null,
    optional: part.includes("=") || part.startsWith("..."),
    rest: part.startsWith("..."),
    default: null,
  }));
  const paramSig = paramNames.join(", ");
  const returns = isAsync ? "Promise<...>" : null;
  return {
    name,
    signature: `${name}(${paramSig})${returns ? ` → ${returns}` : ""}`,
    description:
      "Available helper. Embedded help docs were empty, so this signature was recovered from the live function.",
    params,
    returns,
    async: isAsync,
  };
}

function emptyDoc(name: string): HelperDoc {
  return {
    name,
    signature: name,
    description: null,
    params: [],
    returns: null,
    async: false,
  };
}

export function __setDocsForTests(raw: string | null): void {
  if (raw === null) {
    cache = null;
    return;
  }
  cache = new Map();
  for (const doc of parseEmbeddedDocs(raw)) {
    cache.set(doc.name, doc);
  }
}
