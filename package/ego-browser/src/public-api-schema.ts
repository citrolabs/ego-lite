export type PublicApiOptionKind =
  | "boolean"
  | "clip"
  | "finiteNumber"
  | "nonNegativeNumber"
  | "nonEmptyString"
  | "pageRetention"
  | "positiveInteger"
  | "positiveMilliseconds"
  | "string"
  | "stringRecord"
  | "point";

export type PublicApiOption = {
  description: string;
  kind: PublicApiOptionKind;
  values?: readonly string[];
};

export type PublicApiEntry = {
  name: string;
  signature: string;
  summary: string;
  options?: Record<string, PublicApiOption>;
};

const option = (
  kind: PublicApiOptionKind,
  description: string,
  values?: readonly string[],
): PublicApiOption => ({ kind, description, values });

const timeout = option(
  "positiveMilliseconds",
  "Maximum duration in milliseconds.",
);
const actionTimeout = option(
  "positiveMilliseconds",
  "Maximum wait for the element to become usable in milliseconds; defaults to 3000.",
);
const delay = option("nonNegativeNumber", "Input delay in milliseconds.");
const button = option("string", "Mouse button.", ["left", "middle", "right"]);
const position = option(
  "point",
  "CSS-pixel offset from the element's top-left corner.",
);
const force = option("boolean", "Bypass pointer interception checks.");

/**
 * Single source of truth for the v2 surface shown to Agents. Runtime option
 * validation, default help, and the generated Markdown reference all consume
 * this schema. Legacy helpers intentionally remain outside it.
 */
export const PUBLIC_API_SCHEMA: readonly PublicApiEntry[] = [
  {
    name: "profiles",
    signature: "await profiles()",
    summary: "List browser profiles available for new task spaces.",
  },
  {
    name: "listTaskSpaces",
    signature: "await listTaskSpaces()",
    summary:
      "List Agent-owned and user-owned spaces available to reuse or claim.",
  },
  {
    name: "taskSpace",
    signature: "await taskSpace(nameOrId, { profileId? })",
    summary:
      "Reuse or create an Agent-owned task space; a new space starts with managed Page p1, and profileId applies only when creating it.",
    options: {
      profileId: option(
        "nonEmptyString",
        "Browser profile id returned by profiles(); new spaces only.",
      ),
    },
  },
  {
    name: "claimTaskSpace",
    signature: "await claimTaskSpace(spaceId)",
    summary:
      "Claim a user-owned or inactive space after user approval and return TaskSpace.",
  },
  {
    name: "takeOverTaskSpace",
    signature: "await takeOverTaskSpace(spaceId)",
    summary:
      "Resume an Agent-owned space after user approval and return TaskSpace.",
  },
  {
    name: "TaskSpace.spaceId",
    signature: "task.spaceId",
    summary: "Stable numeric identifier for this task space.",
  },
  {
    name: "TaskSpace.name",
    signature: "task.name",
    summary: "Human-readable task-space name.",
  },
  {
    name: "TaskSpace.ownership",
    signature: "task.ownership",
    summary: "Ownership state captured when this TaskSpace was created.",
  },
  {
    name: "TaskSpace.page",
    signature: "task.page(label)",
    summary: "Create a lazy Page handle for a durable page label.",
  },
  {
    name: "TaskSpace.userPage",
    signature: "task.userPage()",
    summary:
      "Return the tab active at the claim/takeover boundary, when one was captured.",
  },
  {
    name: "TaskSpace.pages",
    signature: "await task.pages()",
    summary: "List the managed Page handles in this space.",
  },
  {
    name: "TaskSpace.tabs",
    signature: "await task.tabs()",
    summary: "List managed Pages and unmanaged tabs in this space.",
  },
  {
    name: "TaskSpace.newPage",
    signature: "await task.newPage()",
    summary: "Create and durably label a blank Page.",
  },
  {
    name: "TaskSpace.adopt",
    signature: "await task.adopt(unmanagedPage, { as? })",
    summary: "Bring an unmanaged tab under the Page lifecycle.",
    options: { as: option("string", "Permanent Page label.") },
  },
  {
    name: "TaskSpace.release",
    signature: "await task.release(label)",
    summary: "Stop managing an unknown-origin Page without closing it.",
  },
  {
    name: "TaskSpace.waitForControl",
    signature: "await task.waitForControl({ interval?, timeout? })",
    summary: "Wait for Agent control without taking it from the user.",
    options: {
      interval: option(
        "positiveMilliseconds",
        "Polling interval in milliseconds.",
      ),
      timeout,
    },
  },
  {
    name: "TaskSpace.handOff",
    signature: "await task.handOff()",
    summary: "Give control of this space to the user.",
  },
  {
    name: "TaskSpace.finish",
    signature: "await task.finish({ keep })",
    summary:
      "Finish the task and keep selected managed Pages; an empty list closes the space when no protected tabs remain.",
    options: {
      keep: option(
        "pageRetention",
        'Required Page retention policy: "all" or an array of managed Page labels.',
      ),
    },
  },
  {
    name: "TaskSpace.cdp",
    signature: "await task.cdp(method, params?, { timeout? })",
    summary: "Send a Target or Browser domain CDP command.",
    options: { timeout },
  },
  {
    name: "Page.label",
    signature: "page.label",
    summary: "Durable Page label used to restore the tab across rounds.",
  },
  {
    name: "Page.spaceId",
    signature: "page.spaceId",
    summary: "Numeric identifier of the Page's task space.",
  },
  {
    name: "Page.openedBy",
    signature: "page.openedBy",
    summary: "Conservative origin attribution for this Page.",
  },
  {
    name: "Page.targetId",
    signature: "page.targetId",
    summary:
      "Internal browser target identifier for advanced Target-domain CDP only.",
  },
  {
    name: "Page.goto",
    signature: "await page.goto(url, { referer?, timeout?, waitUntil? })",
    summary:
      "Navigate this Page in place. Timeout errors report whether the new document committed, plus its URL and readyState when available.",
    options: {
      referer: option(
        "nonEmptyString",
        "HTTP Referer header for the navigation.",
      ),
      timeout,
      waitUntil: option(
        "string",
        "Completion state; defaults to load. networkidle requires 500ms without network activity.",
        ["commit", "domcontentloaded", "load", "networkidle"],
      ),
    },
  },
  {
    name: "Page.reload",
    signature: "await page.reload({ timeout?, waitUntil? })",
    summary: "Reload this Page and wait for the selected navigation state.",
    options: {
      timeout,
      waitUntil: option(
        "string",
        "Completion state; defaults to load. networkidle requires 500ms without network activity.",
        ["commit", "domcontentloaded", "load", "networkidle"],
      ),
    },
  },
  {
    name: "Page.snapshot",
    signature:
      "await page.snapshot({ scope?, includeActionMarks?, includeStableLocator? })",
    summary:
      "Return a semantic snapshot of the current viewport with Page provenance.",
    options: {
      scope: option(
        "string",
        "Snapshot scope; defaults to only_within_viewport.",
        ["full_page", "only_within_viewport"],
      ),
      includeActionMarks: option("boolean", "Include action marks."),
      includeStableLocator: option("boolean", "Include stable locators."),
    },
  },
  {
    name: "Page.screenshot",
    signature:
      "await page.screenshot({ path?, fullPage?, clip?, scale?, raw? })",
    summary: "Capture this Page to a PNG file.",
    options: {
      path: option(
        "string",
        "Output path; missing parent directories are created.",
      ),
      fullPage: option("boolean", "Capture the full scrollable page."),
      clip: option("clip", "CSS-pixel clipping rectangle."),
      scale: option(
        "string",
        "Output scale mode; css uses CSS-pixel sizing and is the default.",
        ["css"],
      ),
      raw: option("boolean", "Bypass device-pixel-ratio correction."),
    },
  },
  {
    name: "Page.url",
    signature: "await page.url()",
    summary: "Read this Page's current URL.",
  },
  {
    name: "Page.waitForURL",
    signature: "await page.waitForURL(urlOrRegExp, { timeout? })",
    summary: "Wait for an exact URL or regular-expression match.",
    options: { timeout },
  },
  {
    name: "Page.waitForEvent",
    signature: 'await page.waitForEvent("popup", { timeout? })',
    summary:
      "Wait for this Page's next popup; call before the triggering action.",
    options: { timeout },
  },
  {
    name: "Page.waitForTimeout",
    signature: "await page.waitForTimeout(timeout)",
    summary:
      "Wait a fixed number of milliseconds without activating this Page.",
  },
  {
    name: "Page.title",
    signature: "await page.title()",
    summary: "Read this Page's current title.",
  },
  {
    name: "Page.info",
    signature: "await page.info()",
    summary: "Read URL, title, viewport, scroll, and dialog state.",
  },
  {
    name: "Page.acceptDialog",
    signature: "await page.acceptDialog(promptText?)",
    summary:
      "Accept this Page's JavaScript dialog, optionally supplying prompt text; return false when none is open.",
  },
  {
    name: "Page.dismissDialog",
    signature: "await page.dismissDialog()",
    summary:
      "Dismiss this Page's JavaScript dialog; return false when none is open.",
  },
  {
    name: "Page.evaluate",
    signature: "await page.evaluate(fnOrString, argument?)",
    summary:
      "Run JavaScript in this Page; callbacks receive JSON data but cannot capture Node.js variables. Safety-timeout errors report executionStopped, pageResponsive, and mayHaveLateEffects.",
  },
  {
    name: "Page.waitForFunction",
    signature:
      "await page.waitForFunction(fnOrString, argument?, { timeout?, polling? })",
    summary: "Wait until a Page function or expression returns a truthy value.",
    options: {
      timeout,
      polling: option(
        "positiveMilliseconds",
        "Polling interval in milliseconds; defaults to 100.",
      ),
    },
  },
  {
    name: "Page.fetch",
    signature: "await page.fetch(url, options?)",
    summary:
      "Run window.fetch in this Page, obey browser CORS, and return a structured response.",
    options: {
      timeout,
      saveAs: option(
        "nonEmptyString",
        "Write the response body to this path without text conversion.",
      ),
      method: option("string", "HTTP method."),
      headers: option("stringRecord", "Request headers."),
      body: option("string", "Request body."),
      cache: option("string", "Fetch cache mode.", [
        "default",
        "no-store",
        "reload",
        "no-cache",
        "force-cache",
        "only-if-cached",
      ]),
      credentials: option("string", "Fetch credentials mode.", [
        "omit",
        "same-origin",
        "include",
      ]),
      integrity: option("string", "Subresource integrity value."),
      keepalive: option("boolean", "Allow the request to outlive the page."),
      mode: option("string", "Fetch request mode.", [
        "cors",
        "no-cors",
        "same-origin",
      ]),
      redirect: option("string", "Redirect handling mode.", [
        "follow",
        "error",
        "manual",
      ]),
      referrer: option("string", "Request referrer."),
      referrerPolicy: option("string", "Request referrer policy."),
    },
  },
  {
    name: "Page.cdp",
    signature: "await page.cdp(method, params?, { timeout? })",
    summary: "Send a CDP command through this Page's target session.",
    options: { timeout },
  },
  {
    name: "Page.waitForSelector",
    signature: "await page.waitForSelector(selector, { timeout?, state? })",
    summary: "Wait for an element state in this Page.",
    options: {
      timeout,
      state: option("string", "Required element state.", [
        "attached",
        "detached",
        "visible",
        "hidden",
      ]),
    },
  },
  {
    name: "Page.waitForLoadState",
    signature: "await page.waitForLoadState(state?, { timeout?, idleMs? })",
    summary:
      "Wait for DOM content, load, or network-idle state; no state defaults to load.",
    options: {
      timeout,
      idleMs: option(
        "positiveMilliseconds",
        "Required network-idle window in milliseconds.",
      ),
    },
  },
  {
    name: "Page.events",
    signature: "await page.events()",
    summary: "Read and clear CDP events buffered for this Page.",
  },
  {
    name: "Page.click",
    signature:
      "await page.click(selector, { button?, clickCount?, delay?, position?, force?, timeout? })",
    summary: "Click an element with native CDP input.",
    options: {
      button,
      clickCount: option("positiveInteger", "Number of clicks."),
      delay,
      position,
      force,
      timeout: actionTimeout,
    },
  },
  {
    name: "Page.dblclick",
    signature:
      "await page.dblclick(selector, { button?, delay?, position?, force?, timeout? })",
    summary: "Double-click an element with native CDP input.",
    options: { button, delay, position, force, timeout: actionTimeout },
  },
  {
    name: "Page.hover",
    signature: "await page.hover(selector, { position?, force?, timeout? })",
    summary: "Move the mouse over an element.",
    options: { position, force, timeout: actionTimeout },
  },
  {
    name: "Page.dragAndDrop",
    signature:
      "await page.dragAndDrop(source, target, { button?, sourcePosition?, targetPosition?, force?, timeout? })",
    summary: "Drag from one element to another.",
    options: {
      button,
      sourcePosition: position,
      targetPosition: position,
      force,
      timeout: actionTimeout,
    },
  },
  {
    name: "Page.fill",
    signature: "await page.fill(selector, value, { clearFirst?, timeout? })",
    summary:
      "Fill the selected field, its editing host, or its unique fillable descendant, then confirm editing took effect.",
    options: {
      clearFirst: option("boolean", "Clear the current value before filling."),
      timeout: actionTimeout,
    },
  },
  {
    name: "Page.selectOption",
    signature: "await page.selectOption(selector, valueOrValues, { timeout? })",
    summary:
      "Select by a value-or-label string or { value?, label?, index? }; arrays select multiple options, while null or [] clears the selection. The select must be enabled, but disabled options remain programmatically selectable.",
    options: { timeout: actionTimeout },
  },
  {
    name: "Page.focus",
    signature: "await page.focus(selector, { timeout? })",
    summary:
      "Focus the element, its nearest interactive ancestor, or its unique editable descendant.",
    options: { timeout: actionTimeout },
  },
  {
    name: "Page.press",
    signature: "await page.press(selector, chord, { delay?, timeout? })",
    summary: "Focus one element and press a key or shortcut chord.",
    options: { delay, timeout: actionTimeout },
  },
  {
    name: "Page.setInputFiles",
    signature: "await page.setInputFiles(selector, pathOrPaths)",
    summary:
      "Set files on a file input resolved from the input, its label, or a unique descendant.",
  },
  {
    name: "Page.waitForFileChooser",
    signature: "page.waitForFileChooser({ timeout? })",
    summary: "Wait for a dynamically created file chooser.",
    options: { timeout },
  },
  {
    name: "FileChooser.isMultiple",
    signature: "fileChooser.isMultiple()",
    summary: "Report whether the chooser accepts multiple files.",
  },
  {
    name: "FileChooser.setFiles",
    signature: "await fileChooser.setFiles(pathOrPaths)",
    summary:
      "Set files on an intercepted chooser and return any JavaScript dialog opened by the upload.",
  },
  {
    name: "Page.close",
    signature: "await page.close()",
    summary: "Close this Page after confirming its tab disappeared.",
  },
  {
    name: "Page.mouse.click",
    signature: "await page.mouse.click(x, y, { button?, clickCount?, delay? })",
    summary: "Click CSS-pixel coordinates with native CDP input.",
    options: {
      button,
      clickCount: option("positiveInteger", "Number of clicks."),
      delay,
    },
  },
  {
    name: "Page.mouse.move",
    signature: "await page.mouse.move(x, y, { steps? })",
    summary: "Move the mouse to CSS-pixel coordinates.",
    options: { steps: option("positiveInteger", "Number of movement steps.") },
  },
  {
    name: "Page.mouse.down",
    signature: "await page.mouse.down({ button?, clickCount? })",
    summary: "Press a mouse button at the current Page position.",
    options: {
      button,
      clickCount: option(
        "positiveInteger",
        "Click count reported to the page.",
      ),
    },
  },
  {
    name: "Page.mouse.up",
    signature: "await page.mouse.up({ button?, clickCount? })",
    summary: "Release a mouse button at the current Page position.",
    options: {
      button,
      clickCount: option(
        "positiveInteger",
        "Click count reported to the page.",
      ),
    },
  },
  {
    name: "Page.mouse.wheel",
    signature: "await page.mouse.wheel(deltaX, deltaY)",
    summary:
      "Send a wheel event at the current Page position; move or click over the intended scroll container first in each process.",
  },
  {
    name: "Page.keyboard.down",
    signature: "await page.keyboard.down(key)",
    summary: "Press and hold a keyboard key.",
  },
  {
    name: "Page.keyboard.up",
    signature: "await page.keyboard.up(key)",
    summary: "Release a keyboard key.",
  },
  {
    name: "Page.keyboard.press",
    signature: "await page.keyboard.press(chord, { delay? })",
    summary: "Press and release a key or portable shortcut chord.",
    options: { delay },
  },
  {
    name: "Page.keyboard.type",
    signature: "await page.keyboard.type(text, { delay? })",
    summary: "Type text using physical keys where possible.",
    options: { delay },
  },
  {
    name: "Page.keyboard.insertText",
    signature: "await page.keyboard.insertText(text)",
    summary: "Insert text without synthesizing key presses.",
  },
  {
    name: "Page.keyboard.paste",
    signature: "await page.keyboard.paste(textOrContent)",
    summary:
      "Send native paste with a string or { text, html? }, then restore the clipboard.",
  },
] as const;

const entriesByName = new Map(
  PUBLIC_API_SCHEMA.map((entry) => [entry.name, entry]),
);

export function publicApiEntry(name: string): PublicApiEntry | undefined {
  return entriesByName.get(name);
}

/** Validate an option object using the same schema shown in help and docs. */
export function validatePublicApiOptions(name: string, value: unknown): void {
  const entry = publicApiEntry(name);
  if (!entry?.options) {
    throw new Error(`public API schema has no options for ${name}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(
      validationMessage(
        entry,
        `${displayName(name)} options must be an object`,
      ),
    );
  }
  for (const [key, optionValue] of Object.entries(value)) {
    const specification = entry.options[key];
    if (!specification) {
      throw new TypeError(
        validationMessage(
          entry,
          `${displayName(name)} received unknown option: ${key}`,
        ),
      );
    }
    if (optionValue === undefined) continue;
    try {
      validateOptionValue(displayName(name), key, optionValue, specification);
    } catch (error) {
      if (error instanceof TypeError) {
        throw new TypeError(validationMessage(entry, error.message), {
          cause: error,
        });
      }
      throw error;
    }
  }
}

function validationMessage(entry: PublicApiEntry, message: string): string {
  return `${message}. Expected: ${entry.signature}`;
}

export function publicApiMarkdown(): string {
  const groups = new Map<string, PublicApiEntry[]>();
  for (const entry of PUBLIC_API_SCHEMA) {
    const group = entry.name.startsWith("TaskSpace.")
      ? "TaskSpace"
      : entry.name.startsWith("Page.mouse.")
        ? "Page.mouse"
        : entry.name.startsWith("Page.keyboard.")
          ? "Page.keyboard"
          : entry.name.startsWith("Page.")
            ? "Page"
            : "Entry points";
    const entries = groups.get(group) || [];
    entries.push(entry);
    groups.set(group, entries);
  }

  const lines = [
    "# ego-browser v2 API reference",
    "",
    "Generated from `package/ego-browser/src/public-api-schema.ts`.",
    "",
    "High-level Page actions return a receipt that may contain `popups` or a synchronous `dialog`. Handle a returned dialog with `page.acceptDialog(promptText?)` or `page.dismissDialog()` before continuing.",
    "",
    'For an explicit popup wait, arm it before the action: `const popupPromise = page.waitForEvent("popup"); await page.click(selector); const popup = await popupPromise;`. Action receipts instead expose `{ label, targetId }` entries in `receipt.popups`; resolve one with `task.page(label)`.',
    "",
    'Selectors accept refs, Ego locators, XPath, and raw CSS. A small compatibility subset also accepts `css=...`, terminal `:has-text("...")` and `:text-is("...")`, `>> nth=N` after CSS/text/href selectors (`N` is `-1` or non-negative), and `loc=role:...[name*="..."]`.',
  ];
  for (const [group, entries] of groups) {
    lines.push(
      "",
      `## ${group}`,
      "",
      "| API | Options | Purpose |",
      "| --- | --- | --- |",
    );
    for (const entry of entries) {
      const options = entry.options
        ? Object.entries(entry.options)
            .map(([name, specification]) => {
              const values = specification.values
                ? ` (${specification.values.join(", ")})`
                : "";
              return `\`${name}\`${values} — ${specification.description}`;
            })
            .join("<br>")
        : "—";
      lines.push(`| \`${entry.signature}\` | ${options} | ${entry.summary} |`);
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function displayName(name: string): string {
  return name.replace(/^TaskSpace/, "task").replace(/^Page/, "page");
}

function validateOptionValue(
  apiName: string,
  optionName: string,
  value: unknown,
  specification: PublicApiOption,
): void {
  let valid = false;
  switch (specification.kind) {
    case "boolean":
      valid = typeof value === "boolean";
      break;
    case "clip":
      valid = isClip(value);
      break;
    case "finiteNumber":
      valid = typeof value === "number" && Number.isFinite(value);
      break;
    case "nonNegativeNumber":
      valid = typeof value === "number" && Number.isFinite(value) && value >= 0;
      break;
    case "nonEmptyString":
      valid = typeof value === "string" && value.length > 0;
      break;
    case "pageRetention":
      valid =
        value === "all" ||
        (Array.isArray(value) &&
          value.every((item) => typeof item === "string" && item.length > 0) &&
          new Set(value).size === value.length);
      break;
    case "positiveInteger":
      valid = Number.isInteger(value) && (value as number) > 0;
      break;
    case "positiveMilliseconds":
      valid = typeof value === "number" && Number.isFinite(value) && value > 0;
      break;
    case "string":
      valid = typeof value === "string";
      break;
    case "stringRecord":
      valid =
        isPlainObject(value) &&
        Object.values(value).every((item) => typeof item === "string");
      break;
    case "point":
      valid = isPoint(value);
      break;
  }
  if (!valid) {
    if (specification.kind === "positiveMilliseconds") {
      throw new TypeError(
        `${optionName} must be a positive number of milliseconds`,
      );
    }
    if (specification.kind === "nonNegativeNumber") {
      throw new TypeError(`${apiName} ${optionName} must be non-negative`);
    }
    if (specification.kind === "nonEmptyString") {
      throw new TypeError(
        `${apiName} ${optionName} must be a non-empty string`,
      );
    }
    if (specification.kind === "positiveInteger") {
      throw new TypeError(
        `${apiName} ${optionName} must be a positive integer`,
      );
    }
    if (specification.kind === "pageRetention") {
      throw new TypeError(
        `${apiName} ${optionName} must be "all" or an array of unique non-empty Page labels`,
      );
    }
    if (specification.kind === "stringRecord") {
      throw new TypeError(
        `${apiName} ${optionName} must be an object with string values`,
      );
    }
    throw new TypeError(
      `${apiName} ${optionName} must be ${specification.kind}`,
    );
  }
  if (specification.values && !specification.values.includes(value as string)) {
    throw new TypeError(
      `${apiName} ${optionName} must be one of ${specification.values.join(", ")}`,
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPoint(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 2 &&
    keys.includes("x") &&
    keys.includes("y") &&
    typeof value.x === "number" &&
    Number.isFinite(value.x) &&
    typeof value.y === "number" &&
    Number.isFinite(value.y)
  );
}

function isClip(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set(["x", "y", "width", "height", "scale"]);
  return (
    keys.every((key) => allowed.has(key)) &&
    typeof value.x === "number" &&
    Number.isFinite(value.x) &&
    typeof value.y === "number" &&
    Number.isFinite(value.y) &&
    typeof value.width === "number" &&
    Number.isFinite(value.width) &&
    value.width > 0 &&
    typeof value.height === "number" &&
    Number.isFinite(value.height) &&
    value.height > 0 &&
    (value.scale === undefined ||
      (typeof value.scale === "number" &&
        Number.isFinite(value.scale) &&
        value.scale > 0))
  );
}
