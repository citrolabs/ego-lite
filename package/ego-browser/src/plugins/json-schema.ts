/**
 * The JSON Schema subset plugin manifests use for `args` and `returns`.
 *
 * Plugins describe their inputs and outputs so the runtime can reject bad
 * arguments before a plugin touches the site, and detect a site change when a
 * plugin returns data that no longer has the promised shape. A full JSON
 * Schema engine is not needed for that, and the SDK has no runtime
 * dependencies besides acorn, so this file implements only the keywords
 * below. Unknown keywords are ignored rather than rejected.
 */

export type JsonSchema = {
  type?: JsonType | JsonType[];
  description?: string;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  anyOf?: JsonSchema[];
};

type JsonType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "null";

export type SchemaIssue = { path: string; message: string };

/**
 * Validate `value` and return every issue found. With `applyDefaults`, a
 * missing object property that has a `default` is filled in on a copy, and
 * the copy is returned as `value`.
 */
export function validateJsonSchema(
  schema: JsonSchema | undefined,
  value: unknown,
  { applyDefaults = false }: { applyDefaults?: boolean } = {},
): { value: unknown; issues: SchemaIssue[] } {
  const issues: SchemaIssue[] = [];
  if (!schema) return { value, issues };
  const result = visit(schema, value, "$", issues, applyDefaults);
  return { value: result, issues };
}

/** One-line description of the first issues, for error messages. */
export function formatSchemaIssues(issues: SchemaIssue[], limit = 3): string {
  const shown = issues
    .slice(0, limit)
    .map((issue) => `${issue.path}: ${issue.message}`);
  if (issues.length > limit) shown.push(`${issues.length - limit} more`);
  return shown.join("; ");
}

function visit(
  schema: JsonSchema,
  value: unknown,
  path: string,
  issues: SchemaIssue[],
  applyDefaults: boolean,
): unknown {
  if (schema.anyOf) {
    const { anyOf, ...siblings } = schema;
    let matched: { result: unknown } | undefined;
    for (const option of anyOf) {
      const nested: SchemaIssue[] = [];
      const result = visit(option, value, path, nested, applyDefaults);
      if (nested.length === 0) {
        matched = { result };
        break;
      }
    }
    if (!matched) {
      issues.push({ path, message: "does not match any allowed shape" });
      return value;
    }
    // Sibling keywords still apply, to the value with the branch's defaults.
    return visit(siblings, matched.result, path, issues, applyDefaults);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(type, value))) {
      issues.push({
        path,
        message: `expected ${types.join(" or ")}, got ${describe(value)}`,
      });
      return value;
    }
  }
  if (schema.const !== undefined && !sameJson(schema.const, value)) {
    issues.push({ path, message: `must be ${JSON.stringify(schema.const)}` });
  }
  if (schema.enum && !schema.enum.some((option) => sameJson(option, value))) {
    issues.push({
      path,
      message: `must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`,
    });
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      issues.push({
        path,
        message: `must be at least ${schema.minLength} characters`,
      });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      issues.push({
        path,
        message: `must be at most ${schema.maxLength} characters`,
      });
    }
    if (
      schema.pattern !== undefined &&
      !new RegExp(schema.pattern).test(value)
    ) {
      issues.push({ path, message: `must match /${schema.pattern}/` });
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push({ path, message: `must be >= ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push({ path, message: `must be <= ${schema.maximum}` });
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issues.push({
        path,
        message: `must have at least ${schema.minItems} items`,
      });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      issues.push({
        path,
        message: `must have at most ${schema.maxItems} items`,
      });
    }
    if (schema.items) {
      const items = schema.items;
      return value.map((item, index) =>
        visit(items, item, `${path}[${index}]`, issues, applyDefaults),
      );
    }
    return value;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = applyDefaults ? { ...value } : value;
    const properties = schema.properties || {};
    for (const name of schema.required || []) {
      if (
        value[name] === undefined &&
        !(applyDefaults && properties[name]?.default !== undefined)
      ) {
        issues.push({ path: `${path}.${name}`, message: "is required" });
      }
    }
    for (const [name, propertySchema] of Object.entries(properties)) {
      const propertyPath = `${path}.${name}`;
      if (value[name] === undefined) {
        if (applyDefaults && propertySchema.default !== undefined) {
          out[name] = structuredClone(propertySchema.default);
        }
        continue;
      }
      out[name] = visit(
        propertySchema,
        value[name],
        propertyPath,
        issues,
        applyDefaults,
      );
    }
    if (schema.additionalProperties !== undefined) {
      for (const name of Object.keys(value)) {
        if (name in properties) continue;
        if (schema.additionalProperties === false) {
          const known = Object.keys(properties);
          issues.push({
            path: `${path}.${name}`,
            message: known.length
              ? `is not allowed (expected ${known.join(", ")})`
              : "is not allowed",
          });
        } else if (typeof schema.additionalProperties === "object") {
          out[name] = visit(
            schema.additionalProperties,
            value[name],
            `${path}.${name}`,
            issues,
            applyDefaults,
          );
        }
      }
    }
    return out;
  }
  return value;
}

function matchesType(type: JsonType, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value === undefined) return "nothing";
  return typeof value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

/**
 * Compact call shape for hints: `{ user?, limit? }`. Required properties have
 * no question mark. Only top-level properties are shown.
 */
export function schemaCallShape(schema: JsonSchema | undefined): string {
  const properties = Object.keys(schema?.properties || {});
  if (properties.length === 0) return "{}";
  const required = new Set(schema?.required || []);
  return `{ ${properties
    .map((name) => (required.has(name) ? name : `${name}?`))
    .join(", ")} }`;
}

/** Compact result shape for hints: `{ user, posts[] }`. */
export function schemaResultShape(schema: JsonSchema | undefined): string {
  if (!schema) return "any";
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "array") {
    const inner = schema.items ? schemaResultShape(schema.items) : "any";
    return `${inner}[]`;
  }
  if (type === "object" && schema.properties) {
    return `{ ${Object.entries(schema.properties)
      .map(([name, property]) => {
        const propertyType = Array.isArray(property.type)
          ? property.type[0]
          : property.type;
        return propertyType === "array" ? `${name}[]` : name;
      })
      .join(", ")} }`;
  }
  return type || "any";
}
