import { parse } from "acorn";

import { browserCdp } from "./browser-runtime.js";
import { state } from "./state.js";

let hasWarnedAboutFunctionJs = false;

/**
 * Send a raw Chrome DevTools Protocol command.
 * @param {string} method CDP method name, for example Runtime.evaluate.
 * @param {object} [params] CDP command parameters.
 * @param {string} [sessionId] Optional attached target session id.
 * @returns {Promise<object>} CDP result object.
 */
export async function cdp(method, params: any = {}, sessionId = undefined) {
  const result = state.cdpOverride
    ? await state.cdpOverride(method, params, sessionId)
    : (await browserCdp(method, params, sessionId)).result || {};
  if (
    !sessionId &&
    (method === "Network.enable" || method === "Network.disable")
  ) {
    // Mirror the default session's Network domain state so helpers like
    // waitForNetworkIdle can restore it instead of tearing down a domain
    // the caller still relies on for drainEvents().
    state.networkDomainEnabled = method === "Network.enable";
  }
  return result;
}

/**
 * Evaluate JavaScript in the current page or a target tab.
 * @param {string | Function} expression JavaScript source string or a function whose body should be evaluated.
 *   Passing a function is accepted as a convenience but emits a one-time warning to stderr so callers can
 *   switch to the canonical string form. Top-level return statements in strings are auto-wrapped in an IIFE.
 * @param {string} [targetId] Optional target id to attach and evaluate in.
 * @returns {Promise<any>} Runtime.evaluate return-by-value result.
 */
export async function js(expression, targetId = undefined) {
  if (typeof expression === "function") {
    const source = expression.toString();
    if (!hasWarnedAboutFunctionJs) {
      hasWarnedAboutFunctionJs = true;
      process.stderr.write(
        `[ego-browser] js() received a function and auto-wrapped it (${jsSnippet(source, 80)}).\n` +
          `  js() is a thin wrapper over CDP Runtime.evaluate; it takes a string expression,\n` +
          `  not a Puppeteer/Playwright-style callable. Auto-wrap does NOT capture closure\n` +
          `  variables and has NO args channel.\n` +
          `  Prefer:\n` +
          `    js(\`<expression>\`)  // pure expression or explicit IIFE\n`,
      );
    }
    expression = `(${source})()`;
  } else if (typeof expression !== "string") {
    throw new TypeError(
      `js() expects a string expression or function, got ${expression === null ? "null" : typeof expression}`,
    );
  }
  const sessionId = targetId
    ? (await cdp("Target.attachToTarget", { targetId, flatten: true }))
        .sessionId
    : undefined;
  let finalExpression = expression;
  if (hasReturnStatement(expression)) {
    // Newlines keep a trailing line comment from swallowing the closing
    // brace; async keeps top-level await valid inside the wrapper.
    finalExpression = `(async function(){\n${expression}\n})()`;
  }
  return runtimeEvaluate(finalExpression, sessionId, true);
}

async function runtimeEvaluate(
  expression,
  sessionId = undefined,
  awaitPromise = false,
) {
  try {
    const response = await cdp(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise,
      },
      sessionId,
    );
    return runtimeValue(response, expression);
  } catch (error) {
    if (/timed out/i.test(error?.message || "")) {
      throw new Error(
        `Runtime.evaluate timed out; expression: ${jsSnippet(expression)}`,
      );
    }
    throw error;
  }
}

export function runtimeValue(response, expression) {
  const result = response.result || {};
  const details = response.exceptionDetails;
  if (details || result.subtype === "error") {
    const desc = jsExceptionDescription(result, details);
    const loc =
      details?.lineNumber !== undefined && details?.columnNumber !== undefined
        ? ` at line ${details.lineNumber}, column ${details.columnNumber}`
        : "";
    throw new Error(
      `JavaScript evaluation failed${loc}: ${desc}; expression: ${jsSnippet(expression)}`,
    );
  }
  if (Object.hasOwn(result, "value")) {
    return result.value;
  }
  if (Object.hasOwn(result, "unserializableValue")) {
    return decodeUnserializableJsValue(result.unserializableValue);
  }
  return null;
}

function jsExceptionDescription(result, details) {
  let desc = result.description;
  const exception = details?.exception;
  if (!desc && exception && typeof exception === "object") {
    desc = exception.description;
    if (desc === undefined && Object.hasOwn(exception, "value")) {
      desc = String(exception.value);
    }
    if (desc === undefined) {
      desc = exception.className;
    }
  }
  return desc || details?.text || "JavaScript evaluation failed";
}

export function decodeUnserializableJsValue(value) {
  if (value === "NaN") {
    return Number.NaN;
  }
  if (value === "Infinity") {
    return Number.POSITIVE_INFINITY;
  }
  if (value === "-Infinity") {
    return Number.NEGATIVE_INFINITY;
  }
  if (value === "-0") {
    return -0;
  }
  if (value.endsWith("n")) {
    return BigInt(value.slice(0, -1));
  }
  return value;
}

function jsSnippet(expression, limit = 160) {
  const snippet = expression.trim().replace(/\n/g, "\\n");
  return snippet.length > limit ? `${snippet.slice(0, limit - 3)}...` : snippet;
}

/**
 * Whether the source has a `return` outside any nested function, meaning it
 * must be wrapped in a function before Runtime.evaluate accepts it.
 */
export function hasReturnStatement(expression) {
  try {
    return containsOuterReturn(
      parse(expression, {
        ecmaVersion: "latest",
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
      }),
    );
  } catch {
    // Leave invalid or unsupported syntax untouched for the browser to report.
    return false;
  }
}

function containsOuterReturn(node) {
  if (!node || typeof node !== "object") return false;
  if (node.type === "ReturnStatement") return true;
  if (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  ) {
    return false;
  }
  return Object.values(node).some((child) =>
    Array.isArray(child)
      ? child.some(containsOuterReturn)
      : containsOuterReturn(child),
  );
}
