import { state } from "../state.js";
import { cdp, js } from "../cdp-eval.js";
import { waitForElement } from "./waits.js";
import { elementCenter, fillElement } from "./observe.js";

type TypeOptions = {
  clear?: boolean;
};

type FillInputOptions = {
  clearFirst?: boolean;
  timeout?: number;
};

const KEYS = {
  Enter: [13, "Enter", "\r"],
  Tab: [9, "Tab", "\t"],
  Backspace: [8, "Backspace", ""],
  Escape: [27, "Escape", ""],
  Delete: [46, "Delete", ""],
  " ": [32, "Space", " "],
  ArrowLeft: [37, "ArrowLeft", ""],
  ArrowUp: [38, "ArrowUp", ""],
  ArrowRight: [39, "ArrowRight", ""],
  ArrowDown: [40, "ArrowDown", ""],
  Home: [36, "Home", ""],
  End: [35, "End", ""],
  PageUp: [33, "PageUp", ""],
  PageDown: [34, "PageDown", ""]
};

/**
 * Dispatch a key press through CDP.
 * @param {string} key Key name such as Enter, Tab, ArrowLeft, or a single printable character.
 * @param {number} [modifiers=0] CDP modifier bitfield.
 * @returns {Promise<void>}
 */
export async function pressKey(key, modifiers = 0) {
  const [vk, code, text] = KEYS[key] || [key.length === 1 ? key.codePointAt(0) : 0, key, key.length === 1 ? key : ""];
  const base = { key, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  const printable = text && key.length === 1;
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...base });
  if (printable) {
    await cdp("Input.dispatchKeyEvent", { type: "char", text, ...base });
  }
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
 * Fill an element selected by CSS selector or snapshot ref.
 * @param {string} selectorOrRef CSS selector or @ref from snapshot.
 * @param {string} value Replacement value.
 * @returns {Promise<object>}
 */
export async function fill(selectorOrRef, value) {
  await fillElement(selectorOrRef, value);
  return { ok: true };
}

/**
 * Type text into an element selected by CSS selector or snapshot ref.
 * @param {string} selectorOrRef CSS selector or @ref from snapshot.
 * @param {string} text Text to type.
 * @param {{clear?: boolean}} [options]
 * @returns {Promise<object>}
 */
export async function type(selectorOrRef, text, options: TypeOptions = {}) {
  await focusElement(selectorOrRef);
  if (options.clear) {
    await pressKey("Backspace");
  }
  await typeText(String(text));
  return { ok: true };
}

/**
 * Focus a CSS-selected input, optionally clear it, type text, and fire input/change events.
 * @param {string} selector CSS selector for the input-like element.
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
  const focused = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.focus();return true;})()`);
  if (!focused) {
    throw new Error(`fillInput: element not found: ${JSON.stringify(selector)}`);
  }
  if (clearFirst) {
    const modifiers = state.platform === "darwin" ? 4 : 2;
    const selectAll = {
      key: "a",
      code: "KeyA",
      modifiers,
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65
    };
    await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", ...selectAll });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...selectAll });
    await pressKey("Backspace");
  }
  for (const ch of text) {
    await pressKey(ch);
  }
  await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}

/**
 * Focus a CSS-selected element and dispatch a DOM KeyboardEvent in page JavaScript.
 * @param {string} selector CSS selector for the target element.
 * @param {string} [key="Enter"] Event key.
 * @param {"keydown"|"keypress"|"keyup"|string} [event="keypress"] Event type.
 * @returns {Promise<void>}
 */
export async function dispatchKey(selector, key = "Enter", event = "keypress") {
  const keyCodes = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, " ": 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
  const keyCode = keyCodes[key] || (key.length === 1 ? key.codePointAt(0) : 0);
  await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(e){e.focus();e.dispatchEvent(new KeyboardEvent(${JSON.stringify(event)},{key:${JSON.stringify(key)},code:${JSON.stringify(key)},keyCode:${keyCode},which:${keyCode},bubbles:true}));}})()`);
}

async function focusElement(selectorOrRef) {
  const center = await elementCenter(selectorOrRef);
  await cdp("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: center.x,
    y: center.y,
    button: "left",
    buttons: 1,
    clickCount: 1
  }, center.sessionId);
  await cdp("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: center.x,
    y: center.y,
    button: "left",
    buttons: 0,
    clickCount: 1
  }, center.sessionId);
}
