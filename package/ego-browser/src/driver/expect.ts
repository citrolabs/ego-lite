import { ElementResolutionError } from "../element-resolver.js";
import { state } from "../state.js";
import * as locator from "./locator.js";
import { pageInfo } from "./nav.js";

export type SoftExpectResult = {
  ok: boolean;
  detail?: string;
  actual?: unknown;
  expected?: unknown;
};

export type RetryOnTransientOptions = {
  attempts?: number;
  interval?: number;
};

const TRANSIENT_MESSAGE = /Unknown ref|not ready|matched 0 elements/i;

/**
 * Whether an error is retryable by retryOnTransient.
 * @param {unknown} error Thrown error.
 * @returns {boolean}
 */
export function isTransientError(error: unknown): boolean {
  if (error instanceof ElementResolutionError) {
    return error.kind === "transient";
  }
  if (error instanceof Error) {
    return TRANSIENT_MESSAGE.test(error.message);
  }
  return false;
}

/**
 * Retry an async action when element resolution is transiently unavailable.
 * @param {Function} fn Action to run.
 * @param {{ attempts?: number, interval?: number }} [options] attempts default 5; interval in seconds, default 0.4.
 * @returns {Promise<any>} fn result on success.
 */
export async function retryOnTransient<T>(
  fn: () => T | Promise<T>,
  options: RetryOnTransientOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 5;
  const intervalMs = (options.interval ?? 0.4) * 1000;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isTransientError(error)) {
        throw error;
      }
      lastError = error;
      if (attempt < attempts) {
        await state.sleep(intervalMs);
      }
    }
  }
  throw lastError;
}

function matchStringOrRegExp(
  actual: string,
  expected: string | RegExp,
): boolean {
  if (expected instanceof RegExp) {
    return expected.test(actual);
  }
  return actual === expected;
}

function softCatch(error: unknown, prefix: string, expected?: unknown) {
  const detail =
    error instanceof Error ? `${prefix}: ${error.message}` : prefix;
  return {
    ok: false as const,
    detail,
    ...(expected !== undefined ? { expected } : {}),
  };
}

/**
 * Soft assertion: element is visible. Returns { ok } instead of throwing.
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the element.
 * @returns {Promise<{ ok: boolean, detail?: string, actual?: unknown, expected?: unknown }>}
 */
export async function expectVisible(
  selector: string,
): Promise<SoftExpectResult> {
  try {
    const visible = await locator.isVisible(selector);
    if (visible) {
      return { ok: true };
    }
    return {
      ok: false,
      detail: "element is not visible",
      actual: visible,
      expected: true,
    };
  } catch (error) {
    return softCatch(error, "expectVisible failed");
  }
}

/**
 * Soft assertion: element is hidden. Returns { ok } instead of throwing.
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the element.
 * @returns {Promise<{ ok: boolean, detail?: string, actual?: unknown, expected?: unknown }>}
 */
export async function expectHidden(
  selector: string,
): Promise<SoftExpectResult> {
  try {
    const hidden = await locator.isHidden(selector);
    if (hidden) {
      return { ok: true };
    }
    return {
      ok: false,
      detail: "element is not hidden",
      actual: !hidden,
      expected: false,
    };
  } catch (error) {
    return softCatch(error, "expectHidden failed");
  }
}

/**
 * Soft assertion: element text matches. Uses innerText. Returns { ok } instead of throwing.
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the element.
 * @param {string|RegExp} expected Expected text.
 * @returns {Promise<{ ok: boolean, detail?: string, actual?: unknown, expected?: unknown }>}
 */
export async function expectText(
  selector: string,
  expected: string | RegExp,
): Promise<SoftExpectResult> {
  try {
    const actual = await locator.innerText(selector);
    if (matchStringOrRegExp(actual, expected)) {
      return { ok: true, actual, expected };
    }
    return {
      ok: false,
      detail: "text mismatch",
      actual,
      expected,
    };
  } catch (error) {
    return softCatch(error, "expectText failed", expected);
  }
}

/**
 * Soft assertion: current URL matches. Returns { ok } instead of throwing.
 * @param {string|RegExp} expected Expected URL or pattern.
 * @returns {Promise<{ ok: boolean, detail?: string, actual?: unknown, expected?: unknown }>}
 */
export async function expectUrl(
  expected: string | RegExp,
): Promise<SoftExpectResult> {
  try {
    const info = await pageInfo();
    if ("dialog" in info && info.dialog) {
      return {
        ok: false,
        detail:
          "page has an open JavaScript dialog; URL is unavailable until the dialog is handled",
        expected,
      };
    }
    const actual = info.url;
    if (matchStringOrRegExp(actual, expected)) {
      return { ok: true, actual, expected };
    }
    return {
      ok: false,
      detail: "URL mismatch",
      actual,
      expected,
    };
  } catch (error) {
    return softCatch(error, "expectUrl failed", expected);
  }
}

/**
 * Soft assertion: input value matches. Returns { ok } instead of throwing.
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the form control.
 * @param {string|RegExp} expected Expected value.
 * @returns {Promise<{ ok: boolean, detail?: string, actual?: unknown, expected?: unknown }>}
 */
export async function expectValue(
  selector: string,
  expected: string | RegExp,
): Promise<SoftExpectResult> {
  try {
    const actual = await locator.inputValue(selector);
    if (matchStringOrRegExp(actual, expected)) {
      return { ok: true, actual, expected };
    }
    return {
      ok: false,
      detail: "value mismatch",
      actual,
      expected,
    };
  } catch (error) {
    return softCatch(error, "expectValue failed", expected);
  }
}
