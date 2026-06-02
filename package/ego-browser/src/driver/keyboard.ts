import { cdp } from "../cdp-eval.js";
import { withHandle, resolveAndCall } from "./element-ops.js";
import { waitForElement } from "./waits.js";

type FillInputOptions = {
  clearFirst?: boolean;
  timeout?: number;
};

const KEYS = {
  Enter: { vk: 13, key: "Enter", code: "Enter", text: "\r" },
  Tab: { vk: 9, key: "Tab", code: "Tab", text: "\t" },
  Backspace: { vk: 8, key: "Backspace", code: "Backspace", text: "" },
  Escape: { vk: 27, key: "Escape", code: "Escape", text: "" },
  Delete: { vk: 46, key: "Delete", code: "Delete", text: "" },
  " ": { vk: 32, key: " ", code: "Space", text: " " },
  ArrowLeft: { vk: 37, key: "ArrowLeft", code: "ArrowLeft", text: "" },
  ArrowUp: { vk: 38, key: "ArrowUp", code: "ArrowUp", text: "" },
  ArrowRight: { vk: 39, key: "ArrowRight", code: "ArrowRight", text: "" },
  ArrowDown: { vk: 40, key: "ArrowDown", code: "ArrowDown", text: "" },
  Home: { vk: 36, key: "Home", code: "Home", text: "" },
  End: { vk: 35, key: "End", code: "End", text: "" },
  PageUp: { vk: 33, key: "PageUp", code: "PageUp", text: "" },
  PageDown: { vk: 34, key: "PageDown", code: "PageDown", text: "" }
};

const PRINTABLE_CODE_RE = /^[A-Za-z0-9]$/;

function keyDefinition(key) {
  const special = KEYS[key];
  if (special) {
    return special;
  }
  if (key.length !== 1) {
    return { vk: 0, key, code: key, text: "" };
  }
  const vk = key.toUpperCase().codePointAt(0);
  const code = PRINTABLE_CODE_RE.test(key) ? `${/[0-9]/.test(key) ? "Digit" : "Key"}${key.toUpperCase()}` : key;
  return { vk, key, code, text: key };
}

/**
 * Dispatch a key press through CDP.
 * @param {string} key Key name such as Enter, Tab, ArrowLeft, or a single printable character.
 * @param {number} [modifiers=0] CDP modifier bitfield.
 * @returns {Promise<void>}
 */
export async function pressKey(key, modifiers = 0) {
  const { vk, code, text } = keyDefinition(key);
  const base = { key, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(text ? { text, unmodifiedText: text } : {}) });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

/**
 * Insert text at the focused input using CDP Input.insertText.
 * @param {string} text Text to insert.
 * @returns {Promise<void>}
 */
export async function typeText(text) {
  await cdp("Input.insertText", { text });
}

/**
 * Focus an input, optionally clear it, type text, and fire input/change events.
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the input-like element.
 * @param {string} text Text to write.
 * @param {{clearFirst?: boolean, timeout?: number}} [options]
 * @returns {Promise<void>}
 */
export async function fillInput(selector, text, options: FillInputOptions = {}) {
  const clearFirst = options.clearFirst ?? true;
  const timeout = options.timeout ?? 0;
  if (timeout > 0 && !await waitForElement(selector, { timeout })) {
    throw new Error(`fillInput: element not found: ${JSON.stringify(selector)}`);
  }
  await withHandle(selector, async ({ objectId, sessionId }) => {
    await cdp("Runtime.callFunctionOn", {
      functionDeclaration: "function(){this.focus(); if(typeof this.select==='function') this.select();}",
      objectId,
      returnByValue: true,
      awaitPromise: false
    }, sessionId);
    if (clearFirst) {
      await cdp("Runtime.callFunctionOn", {
        functionDeclaration: "function(){this.value=''; this.dispatchEvent(new Event('input',{bubbles:true}));}",
        objectId,
        returnByValue: true,
        awaitPromise: false
      }, sessionId);
    }
    await cdp("Input.insertText", { text }, sessionId);
    await cdp("Runtime.callFunctionOn", {
      functionDeclaration: "function(){this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true}));}",
      objectId,
      returnByValue: true,
      awaitPromise: false
    }, sessionId);
  });
}

/**
 * Focus an element and dispatch a DOM KeyboardEvent in page JavaScript.
 * Note: dispatched event has isTrusted=false; some frameworks ignore it (see docs/issues/dispatchKey-synthetic-keyboard-event.md).
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the target element.
 * @param {string} [key="Enter"] Event key.
 * @param {"keydown"|"keypress"|"keyup"|string} [event="keypress"] Event type.
 * @returns {Promise<void>}
 */
export async function dispatchKey(selector, key = "Enter", event = "keypress") {
  const { vk, code } = keyDefinition(key);
  await resolveAndCall(
    selector,
    "function(keyCode, key, code, event){this.focus(); this.dispatchEvent(new KeyboardEvent(event,{key,code,keyCode,which:keyCode,bubbles:true}));}",
    [vk, key, code, event]
  );
}
