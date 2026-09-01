export type PageKeyboardServices = {
  cdp(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<any>;
  sleep(ms: number): Promise<void>;
  withTemporaryClipboardText<T>(
    content: PageClipboardContent,
    action: () => Promise<T>,
  ): Promise<T>;
  platform?: string;
};

export type PageClipboardContent =
  | string
  | {
      text: string;
      html?: string;
    };

export type PageKeyboardPressOptions = {
  delay?: number;
};

export type PageKeyboardTypeOptions = {
  delay?: number;
};

type KeyDefinition = {
  code: string;
  key: string;
  keyCode: number;
  keyCodeWithoutLocation: number;
  location: number;
  text: string;
  shifted?: KeyDefinition;
};

type LayoutEntry = {
  key: string;
  keyCode: number;
  keyCodeWithoutLocation?: number;
  location?: number;
  shiftKey?: string;
  shiftKeyCode?: number;
  text?: string;
};

const KEYPAD_LOCATION = 3;
const MODIFIER_NAMES = ["Alt", "Control", "Meta", "Shift"] as const;
const MODIFIER_ALIASES = new Map<string, string>([
  ["alt", "Alt"],
  ["control", "Control"],
  ["meta", "Meta"],
  ["shift", "Shift"],
  ["controlormeta", "ControlOrMeta"],
]);
const MODIFIER_MASKS: Record<(typeof MODIFIER_NAMES)[number], number> = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
};

/**
 * Page keyboard state follows Playwright's model: physical keys and modifiers
 * remain pressed until `up`, mouse input can read the same modifier state, and
 * `type` uses real key events for characters present on a US keyboard.
 */
export class PageKeyboardController {
  readonly #services: PageKeyboardServices;
  readonly #run: (
    operation: (sessionId: string) => Promise<void>,
  ) => Promise<unknown>;
  readonly #runObserved: (
    operation: (sessionId: string) => Promise<void>,
  ) => Promise<unknown>;
  readonly #pressedCodes = new Set<string>();
  readonly #pressedModifiers = new Set<string>();

  constructor(
    services: PageKeyboardServices,
    run: (operation: (sessionId: string) => Promise<void>) => Promise<unknown>,
    runObserved = run,
  ) {
    this.#services = services;
    this.#run = run;
    this.#runObserved = runObserved;
  }

  modifierMask(): number {
    return modifierMask(this.#pressedModifiers);
  }

  async down(key: string): Promise<unknown> {
    return this.#run((sessionId) => this.#down(sessionId, key));
  }

  async up(key: string): Promise<unknown> {
    return this.#run((sessionId) => this.#up(sessionId, key));
  }

  async press(
    chord: string,
    options: PageKeyboardPressOptions = {},
  ): Promise<unknown> {
    return this.#runObserved((sessionId) =>
      this.pressInSession(sessionId, chord, options),
    );
  }

  /** Press a chord inside an existing Page action boundary. */
  async pressInSession(
    sessionId: string,
    chord: string,
    options: PageKeyboardPressOptions = {},
  ): Promise<void> {
    const tokens = splitChord(chord);
    const pressed: string[] = [];
    let actionError: unknown;
    try {
      for (const token of tokens) {
        pressed.push(token);
        await this.#down(sessionId, token);
      }
      if (options.delay) await this.#services.sleep(options.delay);
    } catch (error) {
      actionError = error;
    }

    let releaseError: unknown;
    // Releasing in reverse order prevents a failed shortcut from leaving a
    // modifier held for every later mouse or keyboard action on this Page.
    for (const token of pressed.reverse()) {
      try {
        await this.#up(sessionId, token);
      } catch (error) {
        releaseError ??= error;
      }
    }
    if (actionError) throw actionError;
    if (releaseError) throw releaseError;
  }

  async paste(content: PageClipboardContent): Promise<unknown> {
    assertClipboardContent(content);
    return this.#runObserved((sessionId) =>
      this.#services.withTemporaryClipboardText(content, () =>
        this.pressInSession(sessionId, "ControlOrMeta+V"),
      ),
    );
  }

  async insertText(text: string): Promise<unknown> {
    assertText(text, "page.keyboard.insertText");
    return this.#run((sessionId) => this.#insertText(sessionId, text));
  }

  async type(
    text: string,
    options: PageKeyboardTypeOptions = {},
  ): Promise<unknown> {
    assertText(text, "page.keyboard.type");
    return this.#run(async (sessionId) => {
      for (const character of text) {
        if (keyboardLayout.has(character)) {
          await this.#down(sessionId, character);
          if (options.delay) await this.#services.sleep(options.delay);
          await this.#up(sessionId, character);
        } else {
          if (options.delay) await this.#services.sleep(options.delay);
          await this.#insertText(sessionId, character);
        }
      }
    });
  }

  async #down(sessionId: string, input: string): Promise<void> {
    const keyName = resolveSmartModifier(input, this.#services.platform);
    const definition = keyDefinitionForString(
      keyName,
      this.#pressedModifiers.has("Shift"),
    );
    const autoRepeat = this.#pressedCodes.has(definition.code);
    this.#pressedCodes.add(definition.code);
    if (isModifier(definition.key)) {
      this.#pressedModifiers.add(definition.key);
    }

    const text = keyText(definition, this.#pressedModifiers);
    const commands = editingCommands(
      definition.code,
      this.#pressedModifiers,
      this.#services.platform,
    );
    await dispatchKey(this.#services, sessionId, {
      type: text ? "keyDown" : "rawKeyDown",
      modifiers: this.modifierMask(),
      windowsVirtualKeyCode: definition.keyCodeWithoutLocation,
      code: definition.code,
      commands,
      key: definition.key,
      text,
      unmodifiedText: text,
      autoRepeat,
      location: definition.location,
      isKeypad: definition.location === KEYPAD_LOCATION,
    });
  }

  async #up(sessionId: string, input: string): Promise<void> {
    const keyName = resolveSmartModifier(input, this.#services.platform);
    const definition = keyDefinitionForString(
      keyName,
      this.#pressedModifiers.has("Shift"),
    );
    if (isModifier(definition.key)) {
      this.#pressedModifiers.delete(definition.key);
    }
    this.#pressedCodes.delete(definition.code);
    await dispatchKey(this.#services, sessionId, {
      type: "keyUp",
      modifiers: this.modifierMask(),
      key: definition.key,
      windowsVirtualKeyCode: definition.keyCodeWithoutLocation,
      code: definition.code,
      location: definition.location,
    });
  }

  async #insertText(sessionId: string, text: string): Promise<void> {
    await this.#services.cdp("Input.insertText", { text }, sessionId);
  }
}

function assertClipboardContent(
  content: unknown,
): asserts content is PageClipboardContent {
  if (typeof content === "string") return;
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    throw new TypeError(
      "page.keyboard.paste requires a string or { text, html? }",
    );
  }
  const value = content as Record<string, unknown>;
  const unknown = Object.keys(value).find(
    (key) => key !== "text" && key !== "html",
  );
  if (unknown) {
    throw new TypeError(
      `page.keyboard.paste received unknown content field: ${unknown}`,
    );
  }
  if (typeof value.text !== "string") {
    throw new TypeError("page.keyboard.paste content.text must be a string");
  }
  if (value.html !== undefined && typeof value.html !== "string") {
    throw new TypeError("page.keyboard.paste content.html must be a string");
  }
}

/** Split a chord without losing a literal `+` key, matching Playwright. */
export function splitChord(chord: string): string[] {
  if (typeof chord !== "string" || chord.length === 0) {
    throw new TypeError("page.keyboard.press requires a non-empty key");
  }
  const tokens: string[] = [];
  let building = "";
  for (const character of chord) {
    if (character === "+" && building) {
      tokens.push(building);
      building = "";
    } else {
      building += character;
    }
  }
  tokens.push(building);
  if (tokens.some((token) => token.length === 0)) {
    throw new TypeError(`page.keyboard.press received invalid chord: ${chord}`);
  }
  return tokens;
}

function resolveSmartModifier(
  key: string,
  platform: string = process.platform,
): string {
  const lower = key.toLowerCase();
  const normalized =
    MODIFIER_ALIASES.get(lower) ?? NAMED_KEY_NAMES.get(lower) ?? key;
  if (normalized === "ControlOrMeta") {
    return platform === "darwin" ? "Meta" : "Control";
  }
  return normalized;
}

function keyDefinitionForString(input: string, shift: boolean): KeyDefinition {
  const definition = keyboardLayout.get(input);
  if (!definition) {
    const arrow = new Map([
      ["Left", "ArrowLeft"],
      ["Right", "ArrowRight"],
      ["Up", "ArrowUp"],
      ["Down", "ArrowDown"],
    ]).get(input);
    const hint = arrow ? `. Use ${JSON.stringify(arrow)}` : "";
    throw new Error(`Unknown key: ${JSON.stringify(input)}${hint}`);
  }
  return shift && definition.shifted ? definition.shifted : definition;
}

function keyText(
  definition: KeyDefinition,
  modifiers: ReadonlySet<string>,
): string {
  if (modifiers.size > 1) return "";
  if (modifiers.size === 1 && !modifiers.has("Shift")) return "";
  return definition.text;
}

function isModifier(key: string): key is (typeof MODIFIER_NAMES)[number] {
  return (MODIFIER_NAMES as readonly string[]).includes(key);
}

function modifierMask(modifiers: ReadonlySet<string>): number {
  let mask = 0;
  for (const modifier of MODIFIER_NAMES) {
    if (modifiers.has(modifier)) mask |= MODIFIER_MASKS[modifier];
  }
  return mask;
}

async function dispatchKey(
  services: PageKeyboardServices,
  sessionId: string,
  params: Record<string, unknown>,
): Promise<void> {
  await services.cdp("Input.dispatchKeyEvent", params, sessionId);
}

function assertText(
  value: unknown,
  operation: string,
): asserts value is string {
  if (typeof value !== "string") {
    throw new TypeError(`${operation} text must be a string`);
  }
}

function buildKeyboardLayout(): Map<string, KeyDefinition> {
  const entries: Record<string, LayoutEntry> = {
    Escape: { keyCode: 27, key: "Escape" },
    Backquote: { keyCode: 192, key: "`", shiftKey: "~" },
    Minus: { keyCode: 189, key: "-", shiftKey: "_" },
    Equal: { keyCode: 187, key: "=", shiftKey: "+" },
    Backslash: { keyCode: 220, key: "\\", shiftKey: "|" },
    Backspace: { keyCode: 8, key: "Backspace" },
    Tab: { keyCode: 9, key: "Tab" },
    BracketLeft: { keyCode: 219, key: "[", shiftKey: "{" },
    BracketRight: { keyCode: 221, key: "]", shiftKey: "}" },
    CapsLock: { keyCode: 20, key: "CapsLock" },
    Semicolon: { keyCode: 186, key: ";", shiftKey: ":" },
    Quote: { keyCode: 222, key: "'", shiftKey: '"' },
    Enter: { keyCode: 13, key: "Enter", text: "\r" },
    ShiftLeft: {
      keyCode: 160,
      keyCodeWithoutLocation: 16,
      key: "Shift",
      location: 1,
    },
    ShiftRight: {
      keyCode: 161,
      keyCodeWithoutLocation: 16,
      key: "Shift",
      location: 2,
    },
    Comma: { keyCode: 188, key: ",", shiftKey: "<" },
    Period: { keyCode: 190, key: ".", shiftKey: ">" },
    Slash: { keyCode: 191, key: "/", shiftKey: "?" },
    ControlLeft: {
      keyCode: 162,
      keyCodeWithoutLocation: 17,
      key: "Control",
      location: 1,
    },
    MetaLeft: { keyCode: 91, key: "Meta", location: 1 },
    AltLeft: {
      keyCode: 164,
      keyCodeWithoutLocation: 18,
      key: "Alt",
      location: 1,
    },
    Space: { keyCode: 32, key: " " },
    AltRight: {
      keyCode: 165,
      keyCodeWithoutLocation: 18,
      key: "Alt",
      location: 2,
    },
    AltGraph: { keyCode: 225, key: "AltGraph" },
    MetaRight: { keyCode: 92, key: "Meta", location: 2 },
    ContextMenu: { keyCode: 93, key: "ContextMenu" },
    ControlRight: {
      keyCode: 163,
      keyCodeWithoutLocation: 17,
      key: "Control",
      location: 2,
    },
    PrintScreen: { keyCode: 44, key: "PrintScreen" },
    ScrollLock: { keyCode: 145, key: "ScrollLock" },
    Pause: { keyCode: 19, key: "Pause" },
    PageUp: { keyCode: 33, key: "PageUp" },
    PageDown: { keyCode: 34, key: "PageDown" },
    Insert: { keyCode: 45, key: "Insert" },
    Delete: { keyCode: 46, key: "Delete" },
    Home: { keyCode: 36, key: "Home" },
    End: { keyCode: 35, key: "End" },
    ArrowLeft: { keyCode: 37, key: "ArrowLeft" },
    ArrowUp: { keyCode: 38, key: "ArrowUp" },
    ArrowRight: { keyCode: 39, key: "ArrowRight" },
    ArrowDown: { keyCode: 40, key: "ArrowDown" },
    NumLock: { keyCode: 144, key: "NumLock" },
    NumpadDivide: { keyCode: 111, key: "/", location: 3 },
    NumpadMultiply: { keyCode: 106, key: "*", location: 3 },
    NumpadSubtract: { keyCode: 109, key: "-", location: 3 },
    NumpadAdd: { keyCode: 107, key: "+", location: 3 },
    NumpadDecimal: {
      keyCode: 46,
      shiftKeyCode: 110,
      key: "\0",
      shiftKey: ".",
      location: 3,
    },
    NumpadEnter: { keyCode: 13, key: "Enter", text: "\r", location: 3 },
  };

  for (let number = 0; number <= 9; number += 1) {
    const shifted = ")!@#$%^&*("[number];
    entries[`Digit${number}`] = {
      keyCode: 48 + number,
      key: String(number),
      shiftKey: shifted,
    };
  }
  for (let index = 0; index < 26; index += 1) {
    const upper = String.fromCharCode(65 + index);
    entries[`Key${upper}`] = {
      keyCode: 65 + index,
      key: upper.toLowerCase(),
      shiftKey: upper,
    };
  }
  for (let number = 1; number <= 12; number += 1) {
    entries[`F${number}`] = { keyCode: 111 + number, key: `F${number}` };
  }

  const numpad = [
    ["Numpad7", 36, 103, "Home", "7"],
    ["Numpad8", 38, 104, "ArrowUp", "8"],
    ["Numpad9", 33, 105, "PageUp", "9"],
    ["Numpad4", 37, 100, "ArrowLeft", "4"],
    ["Numpad5", 12, 101, "Clear", "5"],
    ["Numpad6", 39, 102, "ArrowRight", "6"],
    ["Numpad1", 35, 97, "End", "1"],
    ["Numpad2", 40, 98, "ArrowDown", "2"],
    ["Numpad3", 34, 99, "PageDown", "3"],
    ["Numpad0", 45, 96, "Insert", "0"],
  ] as const;
  for (const [code, keyCode, shiftKeyCode, key, shiftKey] of numpad) {
    entries[code] = {
      keyCode,
      shiftKeyCode,
      key,
      shiftKey,
      location: 3,
    };
  }

  const layout = new Map<string, KeyDefinition>();
  for (const [code, entry] of Object.entries(entries)) {
    const definition: KeyDefinition = {
      code,
      key: entry.key,
      keyCode: entry.keyCode,
      keyCodeWithoutLocation: entry.keyCodeWithoutLocation ?? entry.keyCode,
      location: entry.location ?? 0,
      text: entry.text ?? (entry.key.length === 1 ? entry.key : ""),
    };
    if (entry.shiftKey) {
      definition.shifted = {
        ...definition,
        key: entry.shiftKey,
        keyCode: entry.shiftKeyCode ?? definition.keyCode,
        keyCodeWithoutLocation: definition.keyCodeWithoutLocation,
        text: entry.shiftKey,
      };
    }
    layout.set(code, definition);
    // Character input should resolve to the main keyboard, never to the numpad.
    // Numpad shifted keys expose digits, so indexing them would overwrite Digit0-9.
    if (definition.location !== 0) continue;
    if (definition.key.length === 1) {
      layout.set(definition.key, definition);
    }
    if (definition.shifted) {
      layout.set(definition.shifted.key, {
        ...definition.shifted,
        shifted: undefined,
      });
    }
  }

  const aliases: Record<string, string> = {
    Alt: "AltLeft",
    Control: "ControlLeft",
    Meta: "MetaLeft",
    Shift: "ShiftLeft",
    " ": "Space",
    "\n": "Enter",
    "\r": "Enter",
  };
  for (const [alias, code] of Object.entries(aliases)) {
    layout.set(alias, layout.get(code)!);
  }
  return layout;
}

const keyboardLayout = buildKeyboardLayout();
const NAMED_KEY_NAMES = new Map(
  [...keyboardLayout.keys()]
    .filter((key) => key.length > 1)
    .map((key) => [key.toLowerCase(), key]),
);

function editingCommands(
  code: string,
  modifiers: ReadonlySet<string>,
  platform: string = process.platform,
): string[] {
  if (platform !== "darwin") return [];
  const parts: string[] = [];
  for (const modifier of ["Shift", "Control", "Alt", "Meta"]) {
    if (modifiers.has(modifier)) parts.push(modifier);
  }
  parts.push(code);
  const value = MAC_EDITING_COMMANDS[parts.join("+")];
  const commands =
    value === undefined ? [] : Array.isArray(value) ? value : [value];
  return commands
    .filter((command) => !command.startsWith("insert"))
    .map((command) => command.slice(0, -1));
}

// Chromium requires macOS editing commands explicitly on raw key events.
// This is the same platform command set used by Playwright's Chromium driver.
const MAC_EDITING_COMMANDS: Record<string, string | string[]> = {
  Backspace: "deleteBackward:",
  Enter: "insertNewline:",
  NumpadEnter: "insertNewline:",
  Escape: "cancelOperation:",
  ArrowUp: "moveUp:",
  ArrowDown: "moveDown:",
  ArrowLeft: "moveLeft:",
  ArrowRight: "moveRight:",
  F5: "complete:",
  Delete: "deleteForward:",
  Home: "scrollToBeginningOfDocument:",
  End: "scrollToEndOfDocument:",
  PageUp: "scrollPageUp:",
  PageDown: "scrollPageDown:",
  "Shift+Backspace": "deleteBackward:",
  "Shift+Enter": "insertNewline:",
  "Shift+NumpadEnter": "insertNewline:",
  "Shift+Escape": "cancelOperation:",
  "Shift+ArrowUp": "moveUpAndModifySelection:",
  "Shift+ArrowDown": "moveDownAndModifySelection:",
  "Shift+ArrowLeft": "moveLeftAndModifySelection:",
  "Shift+ArrowRight": "moveRightAndModifySelection:",
  "Shift+F5": "complete:",
  "Shift+Delete": "deleteForward:",
  "Shift+Home": "moveToBeginningOfDocumentAndModifySelection:",
  "Shift+End": "moveToEndOfDocumentAndModifySelection:",
  "Shift+PageUp": "pageUpAndModifySelection:",
  "Shift+PageDown": "pageDownAndModifySelection:",
  "Shift+Numpad5": "delete:",
  "Control+Tab": "selectNextKeyView:",
  "Control+Enter": "insertLineBreak:",
  "Control+NumpadEnter": "insertLineBreak:",
  "Control+Quote": "insertSingleQuoteIgnoringSubstitution:",
  "Control+KeyA": "moveToBeginningOfParagraph:",
  "Control+KeyB": "moveBackward:",
  "Control+KeyD": "deleteForward:",
  "Control+KeyE": "moveToEndOfParagraph:",
  "Control+KeyF": "moveForward:",
  "Control+KeyH": "deleteBackward:",
  "Control+KeyK": "deleteToEndOfParagraph:",
  "Control+KeyL": "centerSelectionInVisibleArea:",
  "Control+KeyN": "moveDown:",
  "Control+KeyO": ["insertNewlineIgnoringFieldEditor:", "moveBackward:"],
  "Control+KeyP": "moveUp:",
  "Control+KeyT": "transpose:",
  "Control+KeyV": "pageDown:",
  "Control+KeyY": "yank:",
  "Control+Backspace": "deleteBackwardByDecomposingPreviousCharacter:",
  "Control+ArrowUp": "scrollPageUp:",
  "Control+ArrowDown": "scrollPageDown:",
  "Control+ArrowLeft": "moveToLeftEndOfLine:",
  "Control+ArrowRight": "moveToRightEndOfLine:",
  "Shift+Control+Enter": "insertLineBreak:",
  "Shift+Control+NumpadEnter": "insertLineBreak:",
  "Shift+Control+Tab": "selectPreviousKeyView:",
  "Shift+Control+Quote": "insertDoubleQuoteIgnoringSubstitution:",
  "Shift+Control+KeyA": "moveToBeginningOfParagraphAndModifySelection:",
  "Shift+Control+KeyB": "moveBackwardAndModifySelection:",
  "Shift+Control+KeyE": "moveToEndOfParagraphAndModifySelection:",
  "Shift+Control+KeyF": "moveForwardAndModifySelection:",
  "Shift+Control+KeyN": "moveDownAndModifySelection:",
  "Shift+Control+KeyP": "moveUpAndModifySelection:",
  "Shift+Control+KeyV": "pageDownAndModifySelection:",
  "Shift+Control+Backspace": "deleteBackwardByDecomposingPreviousCharacter:",
  "Shift+Control+ArrowUp": "scrollPageUp:",
  "Shift+Control+ArrowDown": "scrollPageDown:",
  "Shift+Control+ArrowLeft": "moveToLeftEndOfLineAndModifySelection:",
  "Shift+Control+ArrowRight": "moveToRightEndOfLineAndModifySelection:",
  "Alt+Backspace": "deleteWordBackward:",
  "Alt+Enter": "insertNewlineIgnoringFieldEditor:",
  "Alt+NumpadEnter": "insertNewlineIgnoringFieldEditor:",
  "Alt+Escape": "complete:",
  "Alt+ArrowUp": ["moveBackward:", "moveToBeginningOfParagraph:"],
  "Alt+ArrowDown": ["moveForward:", "moveToEndOfParagraph:"],
  "Alt+ArrowLeft": "moveWordLeft:",
  "Alt+ArrowRight": "moveWordRight:",
  "Alt+Delete": "deleteWordForward:",
  "Alt+PageUp": "pageUp:",
  "Alt+PageDown": "pageDown:",
  "Shift+Alt+Backspace": "deleteWordBackward:",
  "Shift+Alt+Enter": "insertNewlineIgnoringFieldEditor:",
  "Shift+Alt+NumpadEnter": "insertNewlineIgnoringFieldEditor:",
  "Shift+Alt+Escape": "complete:",
  "Shift+Alt+ArrowUp": "moveParagraphBackwardAndModifySelection:",
  "Shift+Alt+ArrowDown": "moveParagraphForwardAndModifySelection:",
  "Shift+Alt+ArrowLeft": "moveWordLeftAndModifySelection:",
  "Shift+Alt+ArrowRight": "moveWordRightAndModifySelection:",
  "Shift+Alt+Delete": "deleteWordForward:",
  "Shift+Alt+PageUp": "pageUp:",
  "Shift+Alt+PageDown": "pageDown:",
  "Control+Alt+KeyB": "moveWordBackward:",
  "Control+Alt+KeyF": "moveWordForward:",
  "Control+Alt+Backspace": "deleteWordBackward:",
  "Shift+Control+Alt+KeyB": "moveWordBackwardAndModifySelection:",
  "Shift+Control+Alt+KeyF": "moveWordForwardAndModifySelection:",
  "Shift+Control+Alt+Backspace": "deleteWordBackward:",
  "Meta+NumpadSubtract": "cancel:",
  "Meta+Backspace": "deleteToBeginningOfLine:",
  "Meta+ArrowUp": "moveToBeginningOfDocument:",
  "Meta+ArrowDown": "moveToEndOfDocument:",
  "Meta+ArrowLeft": "moveToLeftEndOfLine:",
  "Meta+ArrowRight": "moveToRightEndOfLine:",
  "Shift+Meta+NumpadSubtract": "cancel:",
  "Shift+Meta+Backspace": "deleteToBeginningOfLine:",
  "Shift+Meta+ArrowUp": "moveToBeginningOfDocumentAndModifySelection:",
  "Shift+Meta+ArrowDown": "moveToEndOfDocumentAndModifySelection:",
  "Shift+Meta+ArrowLeft": "moveToLeftEndOfLineAndModifySelection:",
  "Shift+Meta+ArrowRight": "moveToRightEndOfLineAndModifySelection:",
  "Meta+KeyA": "selectAll:",
  "Meta+KeyC": "copy:",
  "Meta+KeyX": "cut:",
  "Meta+KeyV": "paste:",
  "Meta+KeyZ": "undo:",
  "Shift+Meta+KeyZ": "redo:",
};
