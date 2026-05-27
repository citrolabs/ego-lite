---
name: ego-browser
description: Control a real browser through the installed ego-browser helper, for automation, inspection, scraping, or operating a running browser.
---

# ego-browser

Use this skill when you need to control a real browser.

## Core rules

- When the user explicitly asks to use ego-browser, assume `ego-browser` and the repository runtime are already available; do not check `which ego-browser`, `node -v`, package metadata, or help output beforehand. Only investigate if the first run fails with an environment error.
- Prefer writing one complete `ego-browser nodejs` script that finishes navigation, observation, scrolling, extraction, filtering, aggregation, and final output in a single pass. Do not use a second local `node` script to process the same data.
- Code inside the heredoc body runs in Node.js; code inside `js(...)` runs in the browser page. Put navigation, waits, and `cliLog(...)` in the heredoc body; put `document`, `window`, and page selectors inside `js(...)`.
- `js()` accepts a string; it also accepts a function, but passing a function triggers a one-time warning and is automatically wrapped via `.toString()` — this means no closure variables are captured and there is no argument channel. Do not use `js()` the way you would use Puppeteer / Playwright `page.evaluate(fn, ...args)`.

## Quick start

```bash
ego-browser nodejs <<'EOF'
const task = await useOrCreateTaskSpace('ai-gen-task-name')

await openOrReuseTab('https://example.com', { wait: true, timeout: 20 })

cliLog(await snapshotText())
EOF
```

When you need multi-step logic inside the browser, wrap it in one closure and return once, rather than splitting into multiple `await js()` calls:

```js
const data = await js(String.raw`(() => {
  const items = [...document.querySelectorAll('article')]
  return items.map(el => ({
    text: el.innerText,
    links: [...el.querySelectorAll('a')].map(a => a.href),
  }))
})()`)
```

File inputs can be set directly:

```js
await uploadFile('input[type="file"]', "/absolute/path/to/file.pdf")
```

## Common helpers

- Task spaces: `taskSpaces`, `useOrCreateTaskSpace`, `listTaskSpaces`, `useTaskSpace`, `createTaskSpace`
- Navigation/state: `openOrReuseTab`, `gotoAndWait`, `listTabs`, `currentTab`, `switchTab`, `newTab`, `createTab`, `gotoUrl`, `pageInfo`, `ensureRealTab`
- Observe: `snapshotText`, `captureScreenshot`, `js`, `elementEval`, `cdp`, `drainEvents`
- Scroll/mouse: `scrollBy`, `scrollToBottomUntil`, `scroll`, `click`, `doubleClick`, `hover`, `dragMouse`
- Keyboard and input: `fill`, `type`, `pressKey`, `typeText`, `fillInput`
- File: `uploadFile`
- Wait: `wait`, `waitForLoad`, `waitForElement`, `waitForNetworkIdle`
- Fetch: `httpGet`

> **Tip**
> ego-browser nodejs <<'EOF'
cliLog(help("click")); // see how a function is used
EOF

## Default workflow

1. Reuse or create a task space: `const task = await useOrCreateTaskSpace(name)`.
2. Open or switch pages: prefer `openOrReuseTab(url, { wait: true })`; to navigate within the current tab use `gotoAndWait(url, { timeout, settle })`.
3. Observe the page: use `snapshotText()` to get full-page semantic tree text with `[ref=N, loc=..., url=...]` annotations; refs are automatically registered in the refMap, after which you can `click('@N')` / `fill('@N', ...)` / `elementEval('@N', ...)`. `scope` defaults to `'full_page'`. For structured extraction, use `js(String.raw\`...\`)` directly.
4. Perform actions or extract data: if the logic can be completed in the browser DOM in one pass, wrap it in one browser-side closure and return once.
5. Output the final result: use `cliLog(...)`.

### Choosing a method

- `snapshotText` + ref/loc: first choice when buttons, links, and form controls have clear semantics.
- `js` / `elementEval` / `cdp`: use for reading the DOM, extracting structured data, or handling virtual lists.
- `openOrReuseTab`: reuse an existing matching tab before opening the target URL.
- `gotoAndWait`: navigate in the current tab and wait for load/stability.
- `scrollBy` / `scrollToBottomUntil`: default scrolling for pages and timelines.
- `scroll`: use when real wheel events are needed (nested scroll containers, canvas-like UIs).
- `captureScreenshot` + coordinate clicks: use for visual layouts, canvas, or when accessibility information is incomplete.

Scrolling examples:

```js
// DOM scroll
await scrollBy(900)
await scrollToBottomUntil(
  async () => await js(String.raw`document.querySelectorAll('article').length`) >= 20,
  { step: 900, wait: 1, maxSteps: 20 }
)

// Real wheel
await scroll({ dy: 900 })
```

## Mouse targets

`click`, `doubleClick`, `hover`, `dragMouse`, and other mouse actions accept the same target format. Coordinates are in CSS pixels:

- `string`: CSS selector or `@ref`, clicks the element center.
- `[x, y]` or `{x, y}`: viewport coordinates.
- `{selector}`: CSS selector or `@ref`, clicks the element center.
- `{selector, x, y}`: uses the element's top-left corner as the origin, then applies the `x` / `y` offset.

```js
await click('@21')
await click('button.primary')
await click([420, 260])
await click({ x: 420, y: 260 })
await click({ selector: 'canvas#stage', x: 12, y: 8 })
```

## Notes

- `snapshotText()` `scope` defaults to `'full_page'`, covering the full page. Use the default in most cases; only pass `scope: 'only_within_viewport'` when the task only needs visible-area content (e.g., only the list items currently on screen).
- `wait(...)` and `timeout` are in seconds; only parameters whose names end in `Ms` are in milliseconds.
- `listTaskSpaces()` returns the underlying object, typically structured as `{ taskIds: [...] }`; do not call `.find()` on it directly. Use `taskSpaces()` when you need an array.
- `@N` refs are only valid against the most recent snapshot's refMap — each `snapshotText()` call rebuilds the refMap. Ref numbers come from the element's CDP `backendNodeId`, so the same element keeps the same number across snapshots; however, to operate on `@N`, N must appear in the most recent snapshot output. An element scrolled out of viewport, removed by a DOM re-render, or outside the scope when the previous call used `scope:'only_within_viewport'` will trigger `Unknown ref`. For long-lived element references, use the `loc=...` from the snapshotText output as a stable selector, or write a CSS selector directly.
- `js()` returns the evaluated expression result, not a JSON string; do not wrap it in `JSON.parse(...)`.
- When writing regexes inside `js(...)` template strings, escape backslashes twice (e.g., `\\d`, `\\s`), or use `String.raw`.
- If `js()` source contains a top-level `return`, it is automatically wrapped in an IIFE; a `return` inside a nested callback can also trigger this accidentally. For complex expressions, prefer `(() => { ... })()`.
- ego-browser `nodejs` code should not be written to a `.js` file before execution; run it directly via heredoc instead.
