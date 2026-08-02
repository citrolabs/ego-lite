import { cdp } from "../cdp-eval.js";
import { browserCdp } from "../browser-runtime.js";
import { withHandle, resolveAndCall } from "./element-ops.js";
import { click } from "./pointer.js";
import { waitForSelector } from "./waits.js";
import { state } from "../state.js";

type FillOptions = {
  clearFirst?: boolean;
  timeout?: number;
};

type PressSequentiallyOptions = {
  delay?: number;
  timeout?: number;
};

type SelectOption =
  | string
  | number
  | { value?: string; label?: string; index?: number };

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
  PageDown: { vk: 34, key: "PageDown", code: "PageDown", text: "" },
  Shift: { vk: 16, key: "Shift", code: "ShiftLeft", text: "" },
  Control: { vk: 17, key: "Control", code: "ControlLeft", text: "" },
  Alt: { vk: 18, key: "Alt", code: "AltLeft", text: "" },
  Meta: { vk: 91, key: "Meta", code: "MetaLeft", text: "" },
};

const PRINTABLE_CODE_RE = /^[A-Za-z0-9]$/;
const CTRL_MODIFIER = 2;
const META_MODIFIER = 4;
const INPUT_EVENT_DELAY_MS = 25;
const INPUT_DISPATCH_TIMEOUT_MS = 1000;

function keyDefinition(key) {
  const special = KEYS[key];
  if (special) {
    return special;
  }
  if (key.length !== 1) {
    return { vk: 0, key, code: key, text: "" };
  }
  const vk = key.toUpperCase().codePointAt(0);
  const code = PRINTABLE_CODE_RE.test(key)
    ? `${/[0-9]/.test(key) ? "Digit" : "Key"}${key.toUpperCase()}`
    : key;
  return { vk, key, code, text: key };
}

function editingCommandsForKey(key, modifiers) {
  if (
    (modifiers === CTRL_MODIFIER || modifiers === META_MODIFIER) &&
    key.toLowerCase() === "a"
  ) {
    return ["selectAll"];
  }
  if (modifiers === 0 && key === "Backspace") {
    return ["deleteBackward"];
  }
  if (modifiers === 0 && key === "Delete") {
    return ["deleteForward"];
  }
  return undefined;
}

const MODIFIER_BITS: Record<string, number> = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
};
const MODIFIER_KEYS: Record<string, string> = {
  Alt: "Alt",
  Control: "Control",
  ControlLeft: "Control",
  ControlRight: "Control",
  Meta: "Meta",
  MetaLeft: "Meta",
  MetaRight: "Meta",
  Shift: "Shift",
  ShiftLeft: "Shift",
  ShiftRight: "Shift",
};
const pressedModifiers = new Set<string>();

/**
 * Parse a Playwright-style key combo ("Control+a", "Shift+Tab") into a base key
 * and a CDP modifier bitfield. Modifiers: Control, Shift, Alt, Meta, ControlOrMeta.
 */
function parseKeyCombo(combo: string) {
  const parts = combo.split("+");
  let key = parts.pop() ?? combo;
  if (key === "" && parts.length > 0) {
    // A trailing "+" denotes the literal plus key, e.g. "+", "Shift++". split()
    // turns that "+" into two empty segments; the pop above consumed one, so
    // drop the remaining empty slot too instead of reading it as a modifier.
    key = "+";
    if (parts[parts.length - 1] === "") {
      parts.pop();
    }
  }
  let modifiers = 0;
  for (const name of parts) {
    if (name === "ControlOrMeta") {
      modifiers |=
        process.platform === "darwin" ? META_MODIFIER : CTRL_MODIFIER;
      continue;
    }
    const bit = MODIFIER_BITS[name];
    if (bit === undefined) {
      throw new Error(`press: unknown key modifier ${JSON.stringify(name)}`);
    }
    modifiers |= bit;
  }
  return { key, modifiers };
}

function modifierName(key: string) {
  return MODIFIER_KEYS[key];
}

function modifierBitForKey(key: string) {
  const name = modifierName(key);
  return name ? MODIFIER_BITS[name] : 0;
}

function activeModifierBits() {
  let bits = 0;
  for (const name of pressedModifiers) {
    bits |= MODIFIER_BITS[name] || 0;
  }
  return bits;
}

function keyEventBase(key: string, modifiers: number) {
  const { vk, code } = keyDefinition(key);
  return {
    key,
    code,
    modifiers,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
  };
}

/**
 * Dispatch a keydown event and keep modifier keys active until keyboard.up().
 * @param {string} keyCombo Key or modifier+key combo.
 * @returns {Promise<void>}
 */
export async function down(keyCombo) {
  const { key, modifiers } = parseKeyCombo(keyCombo);
  const keyModifierBit = modifierBitForKey(key);
  const eventModifiers = activeModifierBits() | modifiers | keyModifierBit;
  await dispatchKeyEvent({
    type: "keyDown",
    ...keyEventBase(key, eventModifiers),
  });
  const name = modifierName(key);
  if (name) {
    pressedModifiers.add(name);
  }
}

/**
 * Dispatch a keyup event and release modifier keys.
 * @param {string} keyCombo Key or modifier+key combo.
 * @returns {Promise<void>}
 */
export async function up(keyCombo) {
  const { key, modifiers } = parseKeyCombo(keyCombo);
  const keyModifierBit = modifierBitForKey(key);
  const eventModifiers = activeModifierBits() | modifiers | keyModifierBit;
  await dispatchKeyEvent({
    type: "keyUp",
    ...keyEventBase(key, eventModifiers),
  });
  const name = modifierName(key);
  if (name) {
    pressedModifiers.delete(name);
  }
}

/**
 * Dispatch a key press through CDP. Combine modifiers with "+".
 * @param {string} keyCombo Key or modifier+key combo: "Enter", "a", "Control+a", "Shift+Tab". Modifiers: Control, Shift, Alt, Meta, ControlOrMeta.
 * @returns {Promise<void>}
 */
export async function press(keyCombo) {
  const { key, modifiers } = parseKeyCombo(keyCombo);
  const effectiveModifiers = activeModifierBits() | modifiers;
  const downModifiers = effectiveModifiers | modifierBitForKey(key);
  const { vk, code, text } = keyDefinition(key);
  const base = {
    key,
    code,
    modifiers: effectiveModifiers,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
  };
  const commands = editingCommandsForKey(key, effectiveModifiers);
  const probeId = await installKeyProbe(key);
  let dispatchError: unknown = null;
  try {
    await dispatchKeyEvent({
      type: "keyDown",
      ...base,
      modifiers: downModifiers,
      ...(text ? { text, unmodifiedText: text } : {}),
      ...(commands ? { commands } : {}),
    });
    await inputEventDelay();
    await dispatchKeyEvent({
      type: "keyUp",
      ...base,
      modifiers: downModifiers,
    });
  } catch (error) {
    if (!isKeyDispatchTimeout(error)) throw error;
    dispatchError = error;
  }
  const completed = await finishKeyProbe(probeId, {
    key,
    code,
    text,
    commands,
  });
  if (dispatchError && !completed) throw dispatchError;
}

/**
 * Insert text at the focused input using CDP Input.insertText.
 * @param {string} text Text to insert.
 * @returns {Promise<void>}
 */
export async function insertText(text) {
  await cdp("Input.insertText", { text });
}

/**
 * Type text with key events, Playwright-style keyboard.type().
 * @param {string} text Text to type.
 * @param {{delay?: number}} [options] delay in milliseconds between key presses.
 * @returns {Promise<void>}
 */
export async function typeText(text, options: PressSequentiallyOptions = {}) {
  await pressSequentially(String(text), options);
}

/**
 * Focus an element.
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the element.
 * @returns {Promise<void>}
 */
export async function focus(selector) {
  await resolveAndCall(selector, "function(){this.focus();}");
}

/**
 * Focus an input, optionally clear it, write a value, and fire input/change events.
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the input-like element.
 * @param {string} value Text to write.
 * @param {{clearFirst?: boolean, timeout?: number}} [options] clearFirst defaults to true (Playwright fill always clears); clearFirst:false appends (ego-browser extension). timeout in milliseconds.
 * @returns {Promise<void>}
 */
export async function fill(selector, value, options: FillOptions = {}) {
  const clearFirst = options.clearFirst ?? true;
  const timeout = options.timeout ?? state.defaultTimeout;
  if (timeout > 0 && !(await waitForSelector(selector, { timeout }))) {
    throw new Error(`fill: element not found: ${JSON.stringify(selector)}`);
  }
  await withHandle(selector, async ({ objectId, sessionId }) => {
    const focusSource = clearFirst
      ? "function(){this.focus(); if(this.isContentEditable){const range=document.createRange();range.selectNodeContents(this);const sel=getSelection();sel.removeAllRanges();sel.addRange(range);}else if(typeof this.select==='function') this.select();}"
      : "function(){this.focus();}";
    await cdp(
      "Runtime.callFunctionOn",
      {
        functionDeclaration: focusSource,
        objectId,
        returnByValue: true,
        awaitPromise: false,
      },
      sessionId,
    );
    if (clearFirst) {
      await cdp(
        "Runtime.callFunctionOn",
        {
          functionDeclaration:
            "function(){if(this.isContentEditable){this.textContent='';}else if('value' in this){this.value='';}else{throw new Error('fill target is not editable');} this.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));}",
          objectId,
          returnByValue: true,
          awaitPromise: false,
        },
        sessionId,
      );
    }
    await cdp("Input.insertText", { text: value }, sessionId);
    await cdp(
      "Runtime.callFunctionOn",
      {
        functionDeclaration:
          "function(){this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true}));}",
        objectId,
        returnByValue: true,
        awaitPromise: false,
      },
      sessionId,
    );
  });
}

/**
 * Press a sequence of characters, optionally focusing a target first.
 * @param {string} selectorOrText Selector when text is provided, otherwise text for the current focus.
 * @param {string|{delay?: number, timeout?: number}} [textOrOptions] Text to type, or options when typing into current focus.
 * @param {{delay?: number, timeout?: number}} [options] delay in milliseconds between key presses.
 * @returns {Promise<void>}
 */
export async function pressSequentially(
  selectorOrText,
  textOrOptions: string | PressSequentiallyOptions | undefined = undefined,
  options: PressSequentiallyOptions = {},
) {
  let text;
  let effectiveOptions;
  if (typeof textOrOptions === "string") {
    await focusWithTimeout(selectorOrText, options.timeout);
    text = textOrOptions;
    effectiveOptions = options;
  } else {
    text = selectorOrText;
    effectiveOptions = textOrOptions || {};
  }
  for (const char of String(text)) {
    await press(char);
    const delay = Number(effectiveOptions.delay ?? 0);
    if (delay > 0) {
      await state.sleep(delay);
    }
  }
}

/**
 * Focus an element and press a key combo, Playwright-style locator.press().
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the element.
 * @param {string} keyCombo Key or modifier+key combo.
 * @param {{timeout?: number}} [options] timeout in milliseconds.
 * @returns {Promise<void>}
 */
export async function pressOnSelector(
  selector,
  keyCombo,
  options: { timeout?: number } = {},
) {
  await focusWithTimeout(selector, options.timeout);
  await press(keyCombo);
}

/**
 * Set a checkbox or radio to checked.
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the input.
 * @returns {Promise<void>}
 */
export async function check(selector) {
  await setChecked(selector, true);
}

/**
 * Set a checkbox to unchecked.
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the checkbox.
 * @returns {Promise<void>}
 */
export async function uncheck(selector) {
  await setChecked(selector, false);
}

// Page-side guard shared by the read before the click and the read after it:
// rejects non checkbox/radio targets and radio unchecking, then reports the
// current state. One source string so both reads validate identically.
const CHECKED_STATE_SOURCE = `function(checked){
  if (!(this instanceof HTMLInputElement) || (this.type !== "checkbox" && this.type !== "radio")) {
    throw new Error("setChecked target must be a checkbox or radio input");
  }
  if (this.type === "radio" && !checked) {
    throw new Error("setChecked cannot uncheck a radio input");
  }
  return this.checked;
}`;

/**
 * Set the checked state of a checkbox or radio, Playwright-style.
 *
 * Toggles through a real click rather than assigning `this.checked`: an
 * assignment updates the DOM property without the activation behavior a click
 * runs, so frameworks that track the property (React's controlled inputs) never
 * see a change and silently drop the update. The state is read back afterwards
 * and a click that did not take throws instead of reporting success.
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the input.
 * @param {boolean} checked Desired checked state.
 * @returns {Promise<void>}
 */
export async function setChecked(selector, checked) {
  const target = Boolean(checked);
  if ((await readCheckedState(selector, target)) === target) return;
  await click(selector);
  if ((await readCheckedState(selector, target)) !== target) {
    throw new Error(
      `setChecked: clicking ${JSON.stringify(selector)} did not make it ${target ? "checked" : "unchecked"}`,
    );
  }
}

async function readCheckedState(selector, target: boolean) {
  const { result } = await resolveAndCall(selector, CHECKED_STATE_SOURCE, [
    target,
  ]);
  return result.result?.value;
}

/**
 * Select one or more options in a <select>.
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the select.
 * @param {string|number|object|Array<string|number|object>} values Option value(s), labels, or indexes.
 * @returns {Promise<string[]>} Selected option values.
 */
export async function selectOption(
  selector,
  values: SelectOption | SelectOption[],
) {
  const { result } = await resolveAndCall(
    selector,
    `function(values){
      if (!(this instanceof HTMLSelectElement)) {
        throw new Error("selectOption target must be a select element");
      }
      const wanted = Array.isArray(values) ? values : [values];
      const selected = [];
      for (const option of this.options) option.selected = false;
      for (const wantedOption of wanted) {
        let match;
        if (typeof wantedOption === "object" && wantedOption !== null) {
          if (typeof wantedOption.index === "number") match = this.options[wantedOption.index];
          if (!match && wantedOption.value !== undefined) {
            match = [...this.options].find((option) => option.value === String(wantedOption.value));
          }
          if (!match && wantedOption.label !== undefined) {
            match = [...this.options].find((option) => option.label === String(wantedOption.label) || option.text === String(wantedOption.label));
          }
        } else {
          match = [...this.options].find((option) => option.value === String(wantedOption));
        }
        if (!match) throw new Error("selectOption could not find option " + JSON.stringify(wantedOption));
        match.selected = true;
        selected.push(match.value);
        if (!this.multiple) break;
      }
      this.dispatchEvent(new Event("input", { bubbles: true }));
      this.dispatchEvent(new Event("change", { bubbles: true }));
      return selected;
    }`,
    [values],
  );
  return result.result?.value || [];
}

async function focusWithTimeout(selector, timeout = state.defaultTimeout) {
  if (timeout > 0 && !(await waitForSelector(selector, { timeout }))) {
    throw new Error(`focus: element not found: ${JSON.stringify(selector)}`);
  }
  await focus(selector);
}

// Page-side dispatcher, mirroring Playwright's injected dispatchEvent: the type
// selects the event constructor and eventInit is spread onto the same defaults
// Playwright uses. Types outside this table (input/change, touch*, custom, ...)
// fall back to a generic Event. Kept as a string for Runtime.callFunctionOn.
const DISPATCH_EVENT_SOURCE = `function(type, eventInit){
  const init = { bubbles: true, cancelable: true, composed: true, ...(eventInit || {}) };
  const category = {
    auxclick: "mouse", click: "mouse", dblclick: "mouse", mousedown: "mouse",
    mouseenter: "mouse", mouseleave: "mouse", mousemove: "mouse", mouseout: "mouse",
    mouseover: "mouse", mouseup: "mouse", mousewheel: "mouse",
    keydown: "keyboard", keyup: "keyboard", keypress: "keyboard", textInput: "keyboard",
    pointerover: "pointer", pointerout: "pointer", pointerenter: "pointer",
    pointerleave: "pointer", pointerdown: "pointer", pointerup: "pointer",
    pointermove: "pointer", pointercancel: "pointer", gotpointercapture: "pointer",
    lostpointercapture: "pointer",
    focus: "focus", blur: "focus",
    dragstart: "drag", drag: "drag", dragend: "drag", dragenter: "drag",
    dragleave: "drag", dragover: "drag", dragexit: "drag", drop: "drag",
    wheel: "wheel"
  };
  let event;
  switch (category[type]) {
    case "mouse": event = new MouseEvent(type, init); break;
    case "keyboard": event = new KeyboardEvent(type, init); break;
    case "pointer": event = new PointerEvent(type, init); break;
    case "focus": event = new FocusEvent(type, init); break;
    case "drag": event = new DragEvent(type, init); break;
    case "wheel": event = new WheelEvent(type, init); break;
    default: event = new Event(type, init); break;
  }
  this.dispatchEvent(event);
}`;

/**
 * Dispatch a synthetic DOM event on an element, mirroring Playwright's
 * locator.dispatchEvent. The event type picks the constructor — keydown/keyup/
 * keypress -> KeyboardEvent, click/mousedown/... -> MouseEvent, and pointer* /
 * focus / blur / drag* / wheel -> their typed events; any other type (input,
 * change, touch*, custom events, ...) uses a generic Event. eventInit is spread
 * verbatim onto { bubbles: true, cancelable: true, composed: true } and passed
 * to the constructor.
 * Note: the dispatched event has isTrusted=false; some frameworks ignore it. For
 * real keyboard input prefer press().
 * @param {string} selector CSS selector / @ref / loc= / xpath= for the target element.
 * @param {string} type DOM event type, e.g. "keydown", "click", "input".
 * @param {Record<string, unknown>} [eventInit={}] Event-specific init properties (key, code, clientX, ...).
 * @returns {Promise<void>}
 */
export async function dispatchEvent(selector, type, eventInit = {}) {
  if (typeof type !== "string" || type === "") {
    throw new Error("dispatchEvent requires an event type string");
  }
  await resolveAndCall(selector, DISPATCH_EVENT_SOURCE, [type, eventInit]);
}

function inputEventDelay() {
  return new Promise((resolve) => setTimeout(resolve, INPUT_EVENT_DELAY_MS));
}

async function dispatchKeyEvent(params: Record<string, unknown>) {
  await browserCdp(
    "Input.dispatchKeyEvent",
    params,
    undefined,
    INPUT_DISPATCH_TIMEOUT_MS,
  );
}

async function installKeyProbe(key: string) {
  if (!canProbeInputFallback()) return null;
  const id = `key_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  try {
    const result = await cdp("Runtime.evaluate", {
      expression: `(() => {
      window.__egoBrowserInputProbes ||= {};
      const probe = { seen: false };
      probe.handler = (event) => {
        if (event.isTrusted && event.key === ${JSON.stringify(key)}) probe.seen = true;
      };
      document.addEventListener("keydown", probe.handler, true);
      window.__egoBrowserInputProbes[${JSON.stringify(id)}] = probe;
      return true;
    })()`,
      returnByValue: true,
      awaitPromise: false,
    });
    return result.result?.value ? id : null;
  } catch {
    return null;
  }
}

async function finishKeyProbe(
  id: string | null,
  definition: { key: string; code: string; text: string; commands?: string[] },
) {
  if (!id) return false;
  await inputEventDelay();
  try {
    const result = await cdp("Runtime.evaluate", {
      expression: `(() => {
      const probes = window.__egoBrowserInputProbes || {};
      const probe = probes[${JSON.stringify(id)}];
      if (!probe) return { seen: false, fallback: false };
      document.removeEventListener("keydown", probe.handler, true);
      delete probes[${JSON.stringify(id)}];
      if (probe.seen) return { seen: true, fallback: false };

      const target = document.activeElement || document.body;
      const key = ${JSON.stringify(definition.key)};
      const code = ${JSON.stringify(definition.code)};
      const text = ${JSON.stringify(definition.text)};
      const commands = ${JSON.stringify(definition.commands || [])};
      const keyboardInit = {
        key,
        code,
        bubbles: true,
        cancelable: true,
        keyCode: ${JSON.stringify(keyDefinition(definition.key).vk)},
        which: ${JSON.stringify(keyDefinition(definition.key).vk)},
      };
      target.dispatchEvent(new KeyboardEvent("keydown", keyboardInit));

      const isEditable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement;
      if (isEditable) {
        if (commands.includes("selectAll") && typeof target.select === "function") {
          target.select();
        } else if (commands.includes("deleteBackward")) {
          const start = target.selectionStart ?? target.value.length;
          const end = target.selectionEnd ?? start;
          const from = start === end ? Math.max(0, start - 1) : start;
          const before = target.value;
          target.dispatchEvent(new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            inputType: "deleteContentBackward",
          }));
          target.value = before.slice(0, from) + before.slice(end);
          target.setSelectionRange(from, from);
          target.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            inputType: "deleteContentBackward",
          }));
        } else if (commands.includes("deleteForward")) {
          const start = target.selectionStart ?? target.value.length;
          const end = target.selectionEnd ?? start;
          const to = start === end ? Math.min(target.value.length, end + 1) : end;
          const before = target.value;
          target.dispatchEvent(new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            inputType: "deleteContentForward",
          }));
          target.value = before.slice(0, start) + before.slice(to);
          target.setSelectionRange(start, start);
          target.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            inputType: "deleteContentForward",
          }));
        } else if (text) {
          const start = target.selectionStart ?? target.value.length;
          const end = target.selectionEnd ?? start;
          const before = target.value;
          target.dispatchEvent(new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            data: text,
            inputType: "insertText",
          }));
          target.value = before.slice(0, start) + text + before.slice(end);
          const next = start + text.length;
          target.setSelectionRange(next, next);
          target.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            data: text,
            inputType: "insertText",
          }));
        }
      }

      target.dispatchEvent(new KeyboardEvent("keyup", keyboardInit));
      return { seen: false, fallback: true };
    })()`,
      returnByValue: true,
      awaitPromise: false,
    });
    const value = result.result?.value;
    return Boolean(value?.seen || value?.fallback);
  } catch {
    return false;
  }
}

function canProbeInputFallback() {
  return Boolean((globalThis as any).ego?.sendCDPMessage);
}

function isKeyDispatchTimeout(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /CDP request timed out: Input\.dispatchKeyEvent/.test(message);
}
