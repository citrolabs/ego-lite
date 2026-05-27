import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";

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

let cache: Map<string, HelperDoc> | null = null;

export function help(helpers: Record<string, unknown>, ...names: string[]): HelperDoc | HelperDoc[] | string {
  const docs = getDocsMap();
  if (names.length === 0) {
    const all = [...docs.values()].filter((d) => d.name in helpers);
    return all;
  }
  if (names.length === 1) {
    const doc = docs.get(names[0]);
    if (!doc) return `Unknown helper: ${names[0]}`;
    return doc;
  }
  return names.map((n) => docs.get(n) || { name: n, signature: n, description: null, params: [], returns: null, async: false });
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
    lines.push(`@param ${p.rest ? "..." : ""}${p.name}${opt}${type}${desc}${def}`);
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
  const source = readSelf();
  if (!source) return cache;

  const comments: any[] = [];
  let ast: any;
  try {
    ast = parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      onComment: comments,
      locations: true
    });
  } catch {
    return cache;
  }

  const commentsByEndLine = new Map<number, any>();
  for (const c of comments) {
    if (c.type === "Block") {
      commentsByEndLine.set(c.loc.end.line, c);
    }
  }

  walkFunctions(ast, (node: any) => {
    const name = extractFunctionName(node);
    if (!name) return;

    const startLine = node.loc.start.line;
    const jsDoc = commentsByEndLine.get(startLine - 1);
    const parsed = jsDoc ? parseJSDoc(jsDoc.value) : null;

    const params = extractParams(node, parsed);
    const isAsync = node.async === true;
    const paramSig = params.map((p) => {
      const rest = p.rest ? "..." : "";
      const opt = p.optional ? "?" : "";
      return `${rest}${p.name}${opt}`;
    }).join(", ");
    const retStr = parsed?.returns || (isAsync ? "Promise<...>" : null);
    const signature = `${name}(${paramSig})${retStr ? ` → ${retStr}` : ""}`;

    cache!.set(name, {
      name,
      signature,
      description: parsed?.description || null,
      params,
      returns: retStr,
      async: isAsync
    });
  });

  walkAliases(ast, (name: string, target: string) => {
    const existing = cache!.get(target);
    if (existing && !cache!.has(name)) {
      cache!.set(name, { ...existing, name });
    }
  });

  return cache;
}

function readSelf(): string | null {
  try {
    const selfPath = fileURLToPath(import.meta.url);
    return readFileSync(selfPath, "utf-8");
  } catch {
    return null;
  }
}

function walkFunctions(node: any, visitor: (node: any) => void) {
  if (!node || typeof node !== "object") return;
  if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression") {
    visitor(node);
  }
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "loc" || key === "start" || key === "end") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item.type === "string") walkFunctions(item, visitor);
      }
    } else if (child && typeof child.type === "string") {
      walkFunctions(child, visitor);
    }
  }
}

function walkAliases(node: any, visitor: (name: string, target: string) => void) {
  if (!node || typeof node !== "object") return;
  if (node.type === "VariableDeclaration") {
    for (const decl of node.declarations || []) {
      if (decl.id?.type === "Identifier" && decl.init?.type === "Identifier") {
        visitor(decl.id.name, decl.init.name);
      }
    }
  }
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "loc" || key === "start" || key === "end") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item.type === "string") walkAliases(item, visitor);
      }
    } else if (child && typeof child.type === "string") {
      walkAliases(child, visitor);
    }
  }
}

function extractFunctionName(node: any): string | null {
  if (node.id?.name) return node.id.name;
  return null;
}

function extractParams(node: any, jsdoc: ParsedJSDoc | null): ParamInfo[] {
  return (node.params || []).map((p: any) => {
    const info = resolveParam(p);
    const jsdocParam = jsdoc?.params.find((jp) => jp.name === info.name);
    return {
      ...info,
      type: jsdocParam?.type || null,
      description: jsdocParam?.description || null
    };
  });
}

type ParsedJSDoc = {
  description: string | null;
  params: Array<{ name: string; type: string | null; description: string | null }>;
  returns: string | null;
};

function parseJSDoc(raw: string): ParsedJSDoc {
  const lines = raw.split("\n").map((l) => l.replace(/^\s*\*\s?/, "").trim());
  const descLines: string[] = [];
  const params: ParsedJSDoc["params"] = [];
  let returns: string | null = null;

  for (const line of lines) {
    const paramMatch = line.match(/^@param\s+(?:\{([^}]*)\}\s+)?(\[?\w+\]?)(?:(?:\s+[-–—]\s*|\s+)(.+))?\s*$/);
    if (paramMatch) {
      const name = paramMatch[2].replace(/^\[|\]$/g, "");
      params.push({ name, type: paramMatch[1] || null, description: paramMatch[3] || null });
      continue;
    }
    const returnsMatch = line.match(/^@returns?\s+(?:\{([^}]*)\}\s*)?(.*)/);
    if (returnsMatch) {
      returns = returnsMatch[1] || returnsMatch[2] || null;
      continue;
    }
    if (line.startsWith("@")) continue;
    if (line) descLines.push(line);
  }

  return {
    description: descLines.join(" ").trim() || null,
    params,
    returns
  };
}

function resolveParam(node: any): { name: string; optional: boolean; rest: boolean; default: string | null } {
  if (node.type === "RestElement") {
    const inner = resolveParam(node.argument);
    return { ...inner, rest: true, optional: true };
  }
  if (node.type === "AssignmentPattern") {
    const inner = resolveParam(node.left);
    const defStr = nodeToString(node.right);
    return { ...inner, optional: true, default: defStr };
  }
  if (node.type === "Identifier") {
    return { name: node.name, optional: false, rest: false, default: null };
  }
  if (node.type === "ObjectPattern") {
    const props = (node.properties || []).map((p: any) => p.key?.name || "?").join(", ");
    return { name: `{${props}}`, optional: false, rest: false, default: null };
  }
  if (node.type === "ArrayPattern") {
    return { name: "[...]", optional: false, rest: false, default: null };
  }
  return { name: "?", optional: false, rest: false, default: null };
}

function nodeToString(node: any): string {
  if (!node) return "?";
  if (node.type === "Literal") return JSON.stringify(node.value);
  if (node.type === "ObjectExpression") return "{}";
  if (node.type === "ArrayExpression") return "[]";
  if (node.type === "Identifier") return node.name;
  return "...";
}
