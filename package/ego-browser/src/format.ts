type FunctionParamDoc = {
  name: string;
  type: string;
  required?: boolean;
  description?: string;
};

type FunctionDoc = {
  signature: string;
  description: string;
  params?: FunctionParamDoc[];
  returns?: string;
  example?: string;
};

const FUNCTION_DOCS: Record<string, FunctionDoc> = {
  "page.setDefaultTimeout": {
    signature: "page.setDefaultTimeout(timeoutMs) => void",
    description:
      "Set the default timeout, in milliseconds, for page helper operations.",
    params: [
      {
        name: "timeoutMs",
        type: "number",
        required: true,
        description: "Timeout in milliseconds.",
      },
    ],
    returns: "void",
    example: "page.setDefaultTimeout(10000)",
  },
  "page.goto": {
    signature: "page.goto(url, options?) => Promise<any>",
    description: "Navigate the current tab to a URL.",
    params: [
      {
        name: "url",
        type: "string",
        required: true,
        description: "Destination URL.",
      },
      {
        name: "options",
        type: "object",
        description: "Supports timeout, waitUntil, and settle options.",
      },
    ],
    returns: "Promise<any>",
    example: "await page.goto('https://example.com', { timeout: 20000 })",
  },
  "page.reload": {
    signature: "page.reload(options?) => Promise<any>",
    description:
      "Reload the current page and optionally wait for a load state.",
    params: [
      {
        name: "options",
        type: "object",
        description: "Supports ignoreCache, waitUntil, and timeout.",
      },
    ],
    returns: "Promise<any>",
    example: "await page.reload({ waitUntil: 'load', timeout: 10000 })",
  },
  "page.info": {
    signature: "page.info() => Promise<object>",
    description:
      "Return current page URL, title, viewport, scroll, and page size information.",
    returns: "Promise<{ url, title, w, h, sx, sy, pw, ph }>",
    example: "console.log(await page.info())",
  },
  "page.url": {
    signature: "page.url() => Promise<string>",
    description: "Asynchronously return the current page URL.",
    returns: "Promise<string>",
    example: "console.log(await page.url())",
  },
  "page.title": {
    signature: "page.title() => Promise<string>",
    description: "Return the current page title.",
    returns: "Promise<string>",
    example: "console.log(await page.title())",
  },
  "page.locator": {
    signature: "page.locator(selector) => Locator",
    description:
      "Create a locator for CSS, XPath, text, loc=..., or @ref selectors.",
    params: [
      {
        name: "selector",
        type: "string",
        required: true,
        description:
          "CSS selector, xpath=..., text=..., loc=..., or @N snapshot ref.",
      },
    ],
    returns: "Locator",
    example: "await page.locator('button[type=submit]').click()",
  },
  "page.getByRole": {
    signature: "page.getByRole(role, options?) => Locator",
    description:
      "Create a locator by accessibility role and optional accessible name.",
    params: [
      {
        name: "role",
        type: "string",
        required: true,
        description: "ARIA role such as button, link, textbox.",
      },
      {
        name: "options",
        type: "{ name?: string }",
        description: "Accessible name filter.",
      },
    ],
    returns: "Locator",
    example: "await page.getByRole('button', { name: 'Submit' }).click()",
  },
  "page.getByText": {
    signature: "page.getByText(text, options?) => Locator",
    description: "Create a locator by visible text.",
    params: [
      {
        name: "text",
        type: "string",
        required: true,
        description: "Text to match.",
      },
      {
        name: "options",
        type: "{ exact?: boolean }",
        description: "Set exact true for exact text.",
      },
    ],
    returns: "Locator",
    example: "await page.getByText('Save', { exact: true }).click()",
  },
  "page.getByLabel": {
    signature: "page.getByLabel(text, options?) => Locator",
    description: "Create a locator for a form control by label text.",
    params: [
      {
        name: "text",
        type: "string",
        required: true,
        description: "Label text.",
      },
      {
        name: "options",
        type: "{ exact?: boolean }",
        description: "Set exact true for exact label matching.",
      },
    ],
    returns: "Locator",
    example: "await page.getByLabel('Email').fill('me@example.com')",
  },
  "page.getByPlaceholder": {
    signature: "page.getByPlaceholder(text, options?) => Locator",
    description: "Create a locator for an input by placeholder text.",
    params: [
      {
        name: "text",
        type: "string",
        required: true,
        description: "Placeholder text.",
      },
      {
        name: "options",
        type: "{ exact?: boolean }",
        description: "Set exact true for exact placeholder matching.",
      },
    ],
    returns: "Locator",
    example: "await page.getByPlaceholder('Search').fill('openai')",
  },
  "page.getByAltText": {
    signature: "page.getByAltText(text, options?) => Locator",
    description: "Create a locator for an element by image alt text.",
    params: [
      {
        name: "text",
        type: "string",
        required: true,
        description: "Alt text.",
      },
      {
        name: "options",
        type: "{ exact?: boolean }",
        description: "Set exact true for exact alt matching.",
      },
    ],
    returns: "Locator",
    example: "await page.getByAltText('Logo').click()",
  },
  "page.getByTitle": {
    signature: "page.getByTitle(text, options?) => Locator",
    description: "Create a locator by title attribute.",
    params: [
      {
        name: "text",
        type: "string",
        required: true,
        description: "Title text.",
      },
      {
        name: "options",
        type: "{ exact?: boolean }",
        description: "Set exact true for exact title matching.",
      },
    ],
    returns: "Locator",
    example: "await page.getByTitle('More').click()",
  },
  "page.waitForTimeout": {
    signature: "page.waitForTimeout(ms) => Promise<void>",
    description:
      "Wait for a fixed duration. Prefer locator/page state waits for page readiness.",
    params: [
      {
        name: "ms",
        type: "number",
        required: true,
        description: "Milliseconds to wait.",
      },
    ],
    returns: "Promise<void>",
    example: "await page.waitForTimeout(250)",
  },
  "page.waitForLoadState": {
    signature: "page.waitForLoadState(state?, options?) => Promise<void>",
    description:
      "Wait for a load state such as load, domcontentloaded, or networkidle.",
    params: [
      {
        name: "state",
        type: "string",
        description: "Load state. Defaults to load.",
      },
      {
        name: "options",
        type: "{ timeout?: number }",
        description: "Timeout in milliseconds.",
      },
    ],
    returns: "Promise<void>",
    example: "await page.waitForLoadState('networkidle', { timeout: 10000 })",
  },
  "page.waitForSelector": {
    signature: "page.waitForSelector(selector, options?) => Promise<any>",
    description: "Wait for a selector or locator to reach a desired state.",
    params: [
      {
        name: "selector",
        type: "string",
        required: true,
        description: "CSS, XPath, loc=..., text, or @ref selector.",
      },
      {
        name: "options",
        type: "{ state?: string, timeout?: number }",
        description: "State and timeout options.",
      },
    ],
    returns: "Promise<any>",
    example:
      "await page.waitForSelector('button.submit', { state: 'visible' })",
  },
  "page.waitForFunction": {
    signature: "page.waitForFunction(pageFunction, options?) => Promise<any>",
    description:
      "Poll browser-side JavaScript until it returns a truthy value.",
    params: [
      {
        name: "pageFunction",
        type: "string | Function",
        required: true,
        description: "Browser-side predicate.",
      },
      {
        name: "options",
        type: "{ timeout?: number, polling?: number }",
        description: "Wait options.",
      },
    ],
    returns: "Promise<any>",
    example:
      "await page.waitForFunction(() => document.readyState === 'complete')",
  },
  "page.waitForURL": {
    signature: "page.waitForURL(url, options?) => Promise<boolean>",
    description:
      "Wait until the current URL matches a string, glob, regex, or predicate receiving a URL object, then wait for load by default.",
    params: [
      {
        name: "url",
        type: "string | RegExp | Function",
        required: true,
        description:
          "URL matcher. Predicate functions receive a URL object; use url.href, url.pathname, or url.searchParams.",
      },
      {
        name: "options",
        type: "{ timeout?: number, waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit' }",
        description:
          "Timeout in milliseconds and completion state; waitUntil defaults to 'load'.",
      },
    ],
    returns: "Promise<boolean>",
    example:
      "await page.waitForURL(url => url.pathname === '/done', { timeout: 10000 })",
  },
  "page.waitForRequest": {
    signature:
      "page.waitForRequest(urlOrPredicate, options?) => Promise<Request>",
    description:
      "Wait for a network request matching an exact URL, regex, or synchronous predicate.",
    params: [
      {
        name: "urlOrPredicate",
        type: "string | RegExp | Function",
        required: true,
        description: "Exact URL, URL regex, or request predicate.",
      },
      {
        name: "options",
        type: "{ timeout?: number }",
        description: "Timeout in milliseconds; 0 disables timeout.",
      },
    ],
    returns:
      "Promise<{ url(), method(), headers(), postData(), resourceType() }>",
    example: "const req = await page.waitForRequest(/\\/api\\/search/)",
  },
  "page.waitForResponse": {
    signature:
      "page.waitForResponse(urlOrPredicate, options?) => Promise<Response>",
    description:
      "Wait for a network response matching an exact URL, regex, or synchronous predicate.",
    params: [
      {
        name: "urlOrPredicate",
        type: "string | RegExp | Function",
        required: true,
        description: "Exact URL, URL regex, or response predicate.",
      },
      {
        name: "options",
        type: "{ timeout?: number }",
        description: "Timeout in milliseconds; 0 disables timeout.",
      },
    ],
    returns:
      "Promise<{ url(), status(), ok(), headers(), request(), text(), json(), body() }>",
    example:
      "const res = await page.waitForResponse(r => r.url().includes('/api') && r.status() === 200)",
  },
  "page.waitForEvent": {
    signature: "page.waitForEvent(eventName, options?) => Promise<any>",
    description: "Wait for a page event. Currently useful for download events.",
    params: [
      {
        name: "eventName",
        type: "string",
        required: true,
        description: "Event name, such as download.",
      },
      {
        name: "options",
        type: "{ timeout?: number }",
        description: "Timeout in milliseconds.",
      },
    ],
    returns: "Promise<any>",
    example: "const download = await page.waitForEvent('download')",
  },
  "page.evaluate": {
    signature: "page.evaluate(expression) => Promise<any>",
    description:
      "Evaluate page-wide browser JavaScript. Prefer locator.evaluateAll for element collections.",
    params: [
      {
        name: "expression",
        type: "string | Function",
        required: true,
        description: "Browser-side expression or function.",
      },
    ],
    returns: "Promise<any>",
    example: "console.log(await page.evaluate('document.title'))",
  },
  "page.screenshot": {
    signature: "page.screenshot(options?) => Promise<string>",
    description:
      "Capture a screenshot and return the saved path or data depending on options.",
    params: [
      { name: "options", type: "object", description: "Screenshot options." },
    ],
    returns: "Promise<string>",
    example: "console.log(await page.screenshot({ path: '/tmp/page.png' }))",
  },
  "page.snapshot": {
    signature: "page.snapshot(options?) => Promise<string>",
    description:
      "Return a semantic page snapshot with refs and stable locators.",
    params: [
      {
        name: "options",
        type: "object",
        description: "Snapshot options such as scope.",
      },
    ],
    returns: "Promise<string>",
    example: "console.log(await page.snapshot())",
  },
  "page.snapshotRaw": {
    signature: "page.snapshotRaw(options?) => Promise<object>",
    description: "Return the raw structured snapshot object.",
    params: [
      { name: "options", type: "object", description: "Snapshot options." },
    ],
    returns: "Promise<object>",
    example: "console.log(await page.snapshotRaw())",
  },
  "page.elementCenter": {
    signature: "page.elementCenter(selector) => Promise<{ x, y }>",
    description: "Resolve an element and return its viewport center point.",
    params: [
      {
        name: "selector",
        type: "string",
        required: true,
        description: "Selector or @ref.",
      },
    ],
    returns: "Promise<{ x: number, y: number }>",
    example: "console.log(await page.elementCenter('@12'))",
  },
  "page.drainEvents": {
    signature: "page.drainEvents() => Promise<object[]>",
    description: "Drain buffered page/CDP events.",
    returns: "Promise<object[]>",
    example: "console.log(await page.drainEvents())",
  },
  "page.keyboard.press": {
    signature: "page.keyboard.press(key, options?) => Promise<void>",
    description: "Press a keyboard key or shortcut.",
    params: [
      {
        name: "key",
        type: "string",
        required: true,
        description: "Key or shortcut such as Enter or Meta+A.",
      },
      { name: "options", type: "object", description: "Keyboard options." },
    ],
    returns: "Promise<void>",
    example: "await page.keyboard.press('Enter')",
  },
  "page.keyboard.insertText": {
    signature: "page.keyboard.insertText(text) => Promise<void>",
    description: "Insert text at the current focus.",
    params: [
      {
        name: "text",
        type: "string",
        required: true,
        description: "Text to insert.",
      },
    ],
    returns: "Promise<void>",
    example: "await page.keyboard.insertText('hello')",
  },
  "page.mouse.click": {
    signature: "page.mouse.click(x, y, options?) => Promise<void>",
    description:
      "Click viewport coordinates. Prefer locators unless using a visual/canvas workflow.",
    params: [
      {
        name: "x",
        type: "number | object | array",
        required: true,
        description: "X coordinate or point object/array.",
      },
      {
        name: "y",
        type: "number",
        description: "Y coordinate when x is numeric.",
      },
      { name: "options", type: "object", description: "Click options." },
    ],
    returns: "Promise<void>",
    example: "await page.mouse.click(420, 260)",
  },
  "page.mouse.dblclick": {
    signature: "page.mouse.dblclick(x, y, options?) => Promise<void>",
    description:
      "Double-click viewport coordinates. Prefer locators when possible.",
    params: [
      {
        name: "x",
        type: "number | object | array",
        required: true,
        description: "X coordinate or point object/array.",
      },
      {
        name: "y",
        type: "number",
        description: "Y coordinate when x is numeric.",
      },
      { name: "options", type: "object", description: "Double-click options." },
    ],
    returns: "Promise<void>",
    example: "await page.mouse.dblclick(420, 260)",
  },
  "page.mouse.move": {
    signature: "page.mouse.move(x, y) => Promise<void>",
    description: "Move the mouse to viewport coordinates.",
    params: [
      {
        name: "x",
        type: "number",
        required: true,
        description: "X coordinate.",
      },
      {
        name: "y",
        type: "number",
        required: true,
        description: "Y coordinate.",
      },
    ],
    returns: "Promise<void>",
    example: "await page.mouse.move(420, 260)",
  },
  "page.mouse.wheel": {
    signature: "page.mouse.wheel(deltaX, deltaY) => Promise<void>",
    description: "Scroll with a mouse wheel. Positive deltaY scrolls down.",
    params: [
      {
        name: "deltaX",
        type: "number",
        required: true,
        description: "Horizontal wheel delta.",
      },
      {
        name: "deltaY",
        type: "number",
        required: true,
        description: "Vertical wheel delta.",
      },
    ],
    returns: "Promise<void>",
    example: "await page.mouse.wheel(0, 900)",
  },
  "page.mouse.drag": {
    signature: "page.mouse.drag(points, options?) => Promise<void>",
    description: "Drag between points or element selectors.",
    params: [
      {
        name: "points",
        type: "array",
        required: true,
        description: "Source and destination points/selectors.",
      },
      { name: "options", type: "object", description: "Drag options." },
    ],
    returns: "Promise<void>",
    example: "await page.mouse.drag([[100, 100], [300, 300]])",
  },
  "browser.listTabs": {
    signature: "browser.listTabs() => Promise<object[]>",
    description: "List tabs in the current task space.",
    returns: "Promise<object[]>",
    example: "console.log(await browser.listTabs())",
  },
  "browser.currentTab": {
    signature: "browser.currentTab() => Promise<object | null>",
    description: "Return the current selected tab.",
    returns: "Promise<object | null>",
    example: "console.log(await browser.currentTab())",
  },
  "browser.switchTab": {
    signature: "browser.switchTab(target) => Promise<string>",
    description:
      "Refresh the current tab list, validate a target id/tab object, then switch to that tab.",
    params: [
      {
        name: "target",
        type: "string | object",
        required: true,
        description: "Target id or tab object.",
      },
    ],
    returns: "Promise<string>",
    example:
      "const tab = (await browser.listTabs()).find(t => t.url.includes('/docs')); if (!tab) throw new Error('docs tab not found'); await browser.switchTab(tab.targetId)",
  },
  "browser.openOrReuseTab": {
    signature: "browser.openOrReuseTab(url, options?) => Promise<object>",
    description: "Open a URL in a new or reusable tab, then select it.",
    params: [
      {
        name: "url",
        type: "string",
        required: true,
        description: "URL to open.",
      },
      {
        name: "options",
        type: "{ wait?: boolean, timeout?: number, settle?: number }",
        description: "Open and wait options.",
      },
    ],
    returns: "Promise<object>",
    example:
      "await browser.openOrReuseTab('https://example.com', { wait: true, timeout: 20000 })",
  },
  "browser.closeTab": {
    signature: "browser.closeTab(target?) => Promise<string>",
    description:
      "Refresh the current tab list, validate, and close a tab by target id/object, or close the current tab when omitted.",
    params: [
      {
        name: "target",
        type: "string | object",
        description: "Target id or tab object.",
      },
    ],
    returns: "Promise<string>",
    example: "await browser.closeTab()",
  },
  "browser.ensureRealTab": {
    signature: "browser.ensureRealTab() => Promise<object | null>",
    description: "Switch to an existing non-internal page tab if one exists.",
    returns: "Promise<object | null>",
    example: "await browser.ensureRealTab()",
  },
  "browser.iframeTarget": {
    signature: "browser.iframeTarget(frameSelector) => Promise<object | null>",
    description: "Resolve an iframe target for advanced CDP interactions.",
    params: [
      {
        name: "frameSelector",
        type: "string",
        required: true,
        description: "Iframe selector.",
      },
    ],
    returns: "Promise<object | null>",
    example: "console.log(await browser.iframeTarget('iframe'))",
  },
  "taskSpaces.list": {
    signature: "taskSpaces.list() => Promise<object[]>",
    description: "List browser task spaces.",
    returns: "Promise<object[]>",
    example: "console.log(await taskSpaces.list())",
  },
  "taskSpaces.switch": {
    signature: "taskSpaces.switch(nameOrId) => Promise<object>",
    description: "Switch to an agent-owned task space.",
    params: [
      {
        name: "nameOrId",
        type: "string | number",
        required: true,
        description: "Task space name, taskId, or numeric id.",
      },
    ],
    returns: "Promise<object>",
    example: "await taskSpaces.switch(3)",
  },
  "taskSpaces.new": {
    signature: "taskSpaces.new(name) => Promise<object>",
    description: "Create and select a new task space.",
    params: [
      {
        name: "name",
        type: "string",
        required: true,
        description: "Task space name.",
      },
    ],
    returns: "Promise<object>",
    example: "const task = await taskSpaces.new('research task')",
  },
  "taskSpaces.useOrCreate": {
    signature: "taskSpaces.useOrCreate(nameOrId) => Promise<object>",
    description: "Reuse an agent-owned task space or create one by name.",
    params: [
      {
        name: "nameOrId",
        type: "string | number",
        required: true,
        description: "Task space name, taskId, or numeric id.",
      },
    ],
    returns: "Promise<object>",
    example: "const task = await taskSpaces.useOrCreate('google sheets task')",
  },
  "taskSpaces.claim": {
    signature: "taskSpaces.claim(nameOrId) => Promise<object>",
    description: "Claim a user-owned task space and select it.",
    params: [
      {
        name: "nameOrId",
        type: "string | number",
        required: true,
        description: "Task space name, taskId, or numeric id.",
      },
    ],
    returns: "Promise<object>",
    example: "await taskSpaces.claim(3)",
  },
  "taskSpaces.complete": {
    signature: "taskSpaces.complete(nameOrId, options) => Promise<object>",
    description: "Finish a task space. options.keep is required.",
    params: [
      {
        name: "nameOrId",
        type: "string | number",
        required: true,
        description: "Task space name, taskId, or numeric id.",
      },
      {
        name: "options",
        type: "{ keep: boolean }",
        required: true,
        description: "Whether to keep the task space open.",
      },
    ],
    returns: "Promise<object>",
    example: "await taskSpaces.complete(task.id, { keep: false })",
  },
  "taskSpaces.handOff": {
    signature: "taskSpaces.handOff(nameOrId?) => Promise<object>",
    description: "Hand control of a task space to the user for manual action.",
    params: [
      {
        name: "nameOrId",
        type: "string | number",
        description:
          "Task space name, taskId, or numeric id. Defaults to current task space.",
      },
    ],
    returns: "Promise<object>",
    example: "await taskSpaces.handOff(task.id)",
  },
  "taskSpaces.takeOver": {
    signature: "taskSpaces.takeOver(nameOrId?) => Promise<object>",
    description:
      "Take control back after the user explicitly confirms continuation.",
    params: [
      {
        name: "nameOrId",
        type: "string | number",
        description:
          "Task space name, taskId, or numeric id. Defaults to current task space.",
      },
    ],
    returns: "Promise<object>",
    example: "await taskSpaces.takeOver(task.id)",
  },
  "taskSpaces.waitForAgentControl": {
    signature:
      "taskSpaces.waitForAgentControl(nameOrId?, options?) => Promise<void>",
    description: "Poll until agent control is restored without taking control.",
    params: [
      {
        name: "nameOrId",
        type: "string | number",
        description: "Task space name, taskId, or numeric id.",
      },
      {
        name: "options",
        type: "{ interval?: number, timeout?: number }",
        description: "Polling options in seconds.",
      },
    ],
    returns: "Promise<void>",
    example: "await taskSpaces.waitForAgentControl(task.id)",
  },
  "site.skills": {
    signature: "site.skills(url?) => Promise<object[]>",
    description:
      "List site learning packs matching a URL, or the current page URL when omitted.",
    params: [
      {
        name: "url",
        type: "string",
        description: "URL to inspect. Defaults to current page URL.",
      },
    ],
    returns: "Promise<object[]>",
    example:
      "console.log(await site.skills('https://www.google.com/search?q=test'))",
  },
  "site.skillsForUrl": {
    signature: "site.skillsForUrl(url) => Promise<object[]>",
    description:
      "List site learning packs whose manifest domains match the URL.",
    params: [
      {
        name: "url",
        type: "string",
        required: true,
        description: "URL or domain to inspect.",
      },
    ],
    returns: "Promise<object[]>",
    example: "console.log(await site.skillsForUrl('https://x.com/home'))",
  },
  "site.runTool": {
    signature: "site.runTool(siteId, toolName, args?) => Promise<tool result>",
    description:
      "Run a Node-side learned site tool. Inspect site.learnContext(url).tools[].args and tools[].returns for the exact schema before calling.",
    params: [
      {
        name: "siteId",
        type: "string",
        required: true,
        description: "Learning pack id, such as google or x-com.",
      },
      {
        name: "toolName",
        type: "string",
        required: true,
        description: "Tool name declared in manifest.json nodeTools.",
      },
      {
        name: "args",
        type: "object",
        description: "Tool arguments matching the manifest schema.",
      },
    ],
    returns:
      "Promise<tool result declared by manifest.json returns; inspect site.learnContext(url).tools[].returns>",
    example:
      "const ctx = await site.learnContext('https://www.google.com/search?q=test'); console.log(ctx.tools); const results = await site.runTool('google', 'search_and_extract', { query: 'openai', maxResults: 5 })",
  },
  "site.runBrowserTool": {
    signature:
      "site.runBrowserTool(siteId, toolName, args?) => Promise<tool result>",
    description:
      "Run a browser-side learned tool in the current page context. Inspect site.learnContext(url).tools[].args and tools[].returns for the exact schema before calling.",
    params: [
      {
        name: "siteId",
        type: "string",
        required: true,
        description: "Learning pack id.",
      },
      {
        name: "toolName",
        type: "string",
        required: true,
        description: "Tool name declared in manifest.json browserTools.",
      },
      {
        name: "args",
        type: "object",
        description: "Tool arguments matching the manifest schema.",
      },
    ],
    returns:
      "Promise<tool result declared by manifest.json returns; inspect site.learnContext(url).tools[].returns>",
    example:
      "const ctx = await site.learnContext('https://x.com/home'); console.log(ctx.tools); const post = await site.runBrowserTool('x-com', 'post_from_active_element')",
  },
  "site.learnContext": {
    signature: "site.learnContext(url?) => Promise<object>",
    description:
      "Load matching learning notes and exact tool schemas, including args and returns, for a URL or the current page URL.",
    params: [
      {
        name: "url",
        type: "string",
        description: "URL to inspect. Defaults to current page URL.",
      },
    ],
    returns:
      "Promise<{ exists, siteId, siteName, knowledge, tools: Array<{ siteId, toolName, toolType, description, args, returns, example }> }>",
    example:
      "console.log(await site.learnContext('https://www.google.com/search?q=test'))",
  },
  "fetch.server": {
    signature: "fetch.server(url, options?) => Promise<string>",
    description: "Fetch text from Node with a browser-like User-Agent.",
    params: [
      {
        name: "url",
        type: "string",
        required: true,
        description: "URL to fetch.",
      },
      {
        name: "options",
        type: "object",
        description:
          "Fetch options including method, headers, body, timeout seconds.",
      },
    ],
    returns: "Promise<string>",
    example: "const html = await fetch.server('https://example.com')",
  },
  "fetch.browser": {
    signature: "fetch.browser(url, options?) => Promise<string>",
    description: "Fetch text inside the current browser page context.",
    params: [
      {
        name: "url",
        type: "string",
        required: true,
        description:
          "URL to fetch. Relative URLs resolve against current page.",
      },
      {
        name: "options",
        type: "object",
        description:
          "Fetch options including method, headers, body, timeout seconds.",
      },
    ],
    returns: "Promise<string>",
    example: "const body = await fetch.browser('/api/data')",
  },
  cdp: {
    signature: "cdp(method, params?) => Promise<any>",
    description:
      "Send a supported raw Chrome DevTools Protocol command to the current target. Browser.grantPermissions and Browser.setPermission are not exposed by the task-space bridge.",
    params: [
      {
        name: "method",
        type: "string",
        required: true,
        description: "CDP method, such as Runtime.evaluate.",
      },
      {
        name: "params",
        type: "object",
        description: "CDP command parameters.",
      },
    ],
    returns: "Promise<any>",
    example:
      "console.log(await cdp('Runtime.evaluate', { expression: 'document.title' }))",
  },
  help: {
    signature: "help(name?) => string",
    description:
      "Print helper documentation. Use this when console output is not enough.",
    params: [
      {
        name: "name",
        type: "string",
        description:
          "Helper or facade name, such as page, locator, browser, site.",
      },
    ],
    returns: "string",
    example: "console.log(help('site'))",
  },
};

export function formatCliLogValue(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "bigint") {
    return `${value}n`;
  }
  if (value === undefined) {
    return "undefined";
  }
  return JSON.stringify(toLoggable(value, [], new WeakSet<object>()), null, 2);
}

function toLoggable(
  value: unknown,
  path: string[],
  stack: WeakSet<object>,
): unknown {
  if (typeof value === "function") {
    return functionLogValue(value, path);
  }
  if (typeof value === "bigint") {
    return `${value}n`;
  }
  if (value === undefined) {
    return "undefined";
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof RegExp) {
    return value.toString();
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (stack.has(value)) {
    return "[Circular]";
  }

  stack.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        toLoggable(item, [...path, String(index)], stack),
      );
    }

    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = toLoggable(child, [...path, key], stack);
    }
    return out;
  } finally {
    stack.delete(value);
  }
}

function functionLogValue(fn: Function, path: string[]) {
  const key = docKeyForPath(path);
  const doc = key ? FUNCTION_DOCS[key] : undefined;
  const displayName = path.at(-1) || fn.name || "anonymous";
  if (!doc) {
    const callPath = path.length ? path.join(".") : displayName;
    return {
      kind: "function",
      name: fn.name || displayName,
      signature: `${callPath}(...)`,
      description:
        "Callable function. Inspect the surrounding facade or use help(name) when available.",
    };
  }

  return {
    kind: "function",
    name: displayName,
    signature: signatureForPath(doc.signature, path),
    description: doc.description,
    ...(doc.params ? { params: doc.params } : {}),
    ...(doc.returns ? { returns: doc.returns } : {}),
    ...(doc.example ? { example: exampleForPath(doc.example, path) } : {}),
  };
}

function docKeyForPath(path: string[]) {
  if (path[0] === "helpers") {
    return path.slice(1).join(".");
  }
  if (path[0] === "learnings") {
    return ["site", ...path.slice(1)].join(".");
  }
  return path.join(".");
}

function signatureForPath(signature: string, path: string[]) {
  if (path[0] === "learnings") {
    return signature.replace(/^site\./, "learnings.");
  }
  return signature;
}

function exampleForPath(example: string, path: string[]) {
  if (path[0] === "learnings") {
    return example.replace(/\bsite\./g, "learnings.");
  }
  return example;
}
