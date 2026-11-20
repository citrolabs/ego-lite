---
version: "2.3.0"
date: "2026-11-16"
---

# ego-browser usage guide

ego lite is a Chromium browser shared by people and AI Agents. Agents can reuse the user's site logins and work on web pages in their own task space. Submit JavaScript with `ego-browser nodejs`: the tool runs it in Node.js with browser APIs to open pages, read content, click, and type. See "API reference" for the list and "Troubleshooting and special cases" when something goes wrong.

## Core concepts

- **User goal**: one thing the user wants done; it can span many scripts and replies.
- **Task space (TaskSpace)**: holds the tabs for one goal and manages control of them.
- **Page**: a tab the script operates, labeled `p1`, `p2`, and so on.
- **Round**: one `ego-browser nodejs` run, one step toward the goal.

One goal uses one space; use several only when the user explicitly asks. When the user adds a requirement, asks a further question, or asks to adjust the result, continue in that space while it exists. The end of a script or a reply never means opening a new space.

When the request is done, end the reply's browser work with `finish()`, by default `{ keep: [] }` to close the space, without asking. Keeping Pages is a rare exception: keep only the necessary Pages when the user explicitly asks, or when the result must stay in the browser for the user to view or continue with. Do not keep visited Pages, search results, intermediate steps, or a space only for a possible follow-up; a follow-up after the space closed starts a new one.

## Quick start

This example completes the goal "read the example page":

<!-- platform: windows -->

### Bash, Zsh, Git Bash

<!-- /platform -->

```bash
ego-browser nodejs <<'EOF'
const task = await taskSpace("inspect example page");
const page = task.page("p1");
await page.goto("https://example.com");

console.log({ taskSpaceId: task.spaceId, page: page.label });
console.log(await page.snapshot());
EOF
```

A new space comes with Page `p1`; navigate it instead of opening another. Once the output shows the goal is met, close the space in a separate last script:

```bash
ego-browser nodejs <<'EOF'
const task = await taskSpace(7); // the taskSpaceId printed above
await task.finish({ keep: [] });
EOF
```

<!-- platform: windows -->

### PowerShell

Windows PowerShell 5.1 strips double quotes from native-program arguments, so never pass a multi-line or double-quoted script to `-e`. Save the whole script as a UTF-8 `.mjs` file with your file tool, then run:

```powershell
ego-browser nodejs -e "await import('file:///C:/Users/<name>/ego/task.mjs')"
```

The file gets the same APIs and `console`. Use forward slashes in the URL and keep non-ASCII text such as Chinese in the file.

### cmd

cmd supports reading from a file:

```bat
ego-browser nodejs < C:\Users\<name>\ego\task.mjs
```

Write a new, complete file per round (`round-01.mjs`, `round-02.mjs`, ...); editing an old one replays old steps. Keep one goal's files in a new directory named for the goal and time, such as `C:/Users/<name>/ego/laptop-prices-20260922-1405/`, and only run files written in this conversation.

<!-- /platform -->

## Continuing across rounds

Every round is a new Node.js process: JavaScript variables are lost; open spaces, tabs, and Page labels persist. `taskSpace(name)` resumes your own space with that name before creating one, but prefer the printed numeric id. Reuse a Page with `goto()` for another URL. Assuming id `7` and a previous snapshot that showed a sign-in form:

```js
const task = await taskSpace(7);
const page = task.page("p1");
await page.fill("@21", "user@example.com");
await page.click("loc=role:button[name='Sign in']");
await page.waitForSelector("loc=css:#account-home", { state: "visible" });
console.log(await page.snapshot());
```

Act on what you observed, wait for the expected result, then observe. Put actions you can plan ahead in one round and print a snapshot last, so the next round can act on it directly; observe in between only when an intermediate result changes the next action. Collect the cheapest state sufficient to choose the next action: a snapshot for elements and locators, a screenshot for appearance, not both by default. Once the page clearly shows the requested result, finish; do not confirm it through other surfaces.

### Starting a later reply

A message that continues an earlier goal continues in that goal's space if it still exists, whatever state your last reply left it in. Choose the space in the reply's first script:

```js
const SPACE_ID = 7; // printed by your last reply about this goal; null for a new goal
const entry =
  SPACE_ID === null
    ? undefined
    : (await listTaskSpaces()).find((s) => s.id === SPACE_ID);
const task = !entry
  ? await taskSpace("descriptive goal name") // new goal, or the earlier space was closed
  : entry.ownership === "user"
    ? await claimTaskSpace(SPACE_ID) // you finished it with kept Pages
    : entry.ownership === "agentDelegatedToUser"
      ? await takeOverTaskSpace(SPACE_ID) // control is with the user
      : await taskSpace(SPACE_ID); // still in your control
// After a claim, no tab has a label yet: adopt the tab you kept.
const page =
  (await task.pages())[0] ?? (await task.adopt((await task.tabs())[0].page));
console.log({
  taskSpaceId: task.spaceId,
  page: page.label,
  tabs: await task.tabs(),
});
```

Only `claimTaskSpace()` resumes a space you finished with kept Pages. After the claim, adopt each kept tab and use the label `adopt()` returns.

## Observing and operating Pages

### Choosing elements from a snapshot

Prefer snapshots and semantic selectors on ordinary pages. Take a snapshot before choosing an unfamiliar target, and a new one after the page changes. Element actions accept:

| Form                | Use                         |
| ------------------- | --------------------------- |
| `@21`, `ref=21`     | Ref from a snapshot         |
| `text=...`          | Page text                   |
| `loc=css:`, raw CSS | CSS selector                |
| `loc=role:`         | Accessibility role and name |
| `loc=href:`         | Link address                |
| `xpath=...`         | XPath                       |

Snapshot node names are accessibility roles. Use a ref now and `loc=...` to find the element again. When a useful node has no ref, build a selector from its role, text, or context. Selectors must match exactly one element.

`page.snapshot()` captures the current viewport, including visible iframe content. Use `page.snapshot({ scope: "full_page" })` for content outside it. To focus on an iframe, pass the ref on its `iframe` line: `console.log(await page.snapshot({ scope: "subtree", root: "@12" }));` and use the subtree's refs inside it.

### Waiting for the result of an action

Clicking, filling, and selecting are only steps; wait for the expected result:

| Expected change                      | Wait with                                |
| ------------------------------------ | ---------------------------------------- |
| URL changes                          | `waitForURL()`                           |
| Element appears, shows, or goes away | `waitForSelector()`                      |
| Application state holds              | `waitForFunction()`                      |
| Load state reached                   | `waitForLoadState()` (`load` by default) |

All time values are milliseconds. Avoid fixed delays when a condition exists. `snapshot()` does not wait for stability. Actions stop waiting for a missing target once the page is idle, so `waitForSelector()` first when an element is expected later. `waitForFunction()` takes Playwright's args (`undefined` before options if no arg) but resolves to `true`, not the value: `await page.waitForFunction(() => window.ready, undefined, { timeout: 5000 });`

`click()`, `fill()`, `hover()`, and `dragAndDrop()` scroll their target into view (wheel input, then a programmatic scroll); do not pre-scroll.

Select options by value, visible label, or zero-based index. A string matches value or label; pass an array for a multiple select, `null` or `[]` to clear: `await page.selectOption("select[name=month]", { label: "October" });`

An action receipt records only the dispatched action and any popup or dialog seen right away; it does not verify the resulting application state.

### Visual pages: screenshot, mouse, and keyboard

Canvas, maps, rich-text editors, and spreadsheets may lack useful DOM semantics. Take a screenshot, inspect it with an image-viewing tool, then use the mouse and keyboard with the confirmed coordinates in a later round:

```js
const path = await page.screenshot({ path: "/absolute/path/before.png" });
console.log({ screenshot: path });
// Later round:
await page.mouse.click(420, 260, { label: "open spreadsheet cell" });
await page.keyboard.paste("hello\tworld");
```

`path` must be absolute; omit it to write into the system temporary directory. Coordinates are CSS pixels; key names and `+` chords follow Playwright syntax. Use `ControlOrMeta` for portable shortcuts. `mouse.wheel()` scrolls at the current mouse position and resolves when done; in each round, move or click over the scrollable area first.

On macOS and Windows, `keyboard.paste()` sends the native paste shortcut and restores the user's clipboard; pass `{ text, html }` for rich text, with `text` as the fallback. Elsewhere use `keyboard.insertText()`.

Validate a small rich-text or grid edit before repeating it. Verify canvas content with a screenshot or visible application state.

Only these pointer actions accept a 3-6 word `label` shown by the agent cursor: `click()`, `dblclick()`, `hover()`, `dragAndDrop()`, `mouse.click()`, `mouse.move()`, and `mouse.wheel()`.

## Managing Pages and control

### Using several Pages

Create another blank Page with `await task.newPage()` and navigate it with `goto()`. Pages get permanent labels `p1`, `p2`, `p3`; prefer them to custom `{ as }` values, and reuse or close Pages when the runtime reports the Page budget. `task.page(label)` gets an existing Page. `await task.pages()` lists managed Pages; `await task.tabs()` lists every tab as `{ label?, page, targetId, title, url, active, openedBy }`. Adopt an unmanaged tab (no `label`) before operating it:

```js
const active = (await task.tabs()).find((item) => item.active);
if (active && !active.label) {
  const page = await task.adopt(active.page);
  console.log({ page: page.label, url: await page.url() });
}
```

Close Agent-created Pages with `page.close()` while the task runs. Treat `openedBy: "unknown"` as user-owned; `release(label)` returns it to the user without closing the tab.

## User control

Stop when the user takes control or the space is inactive or unassigned. Do not retry or route around the stop. Set site permissions in advance as in "Browser permission requests"; prompts and device choosers already shown are the user's.

When the user must act in the browser (login without credentials the user gave, CAPTCHA or human verification, 2FA, or other manual step), call `await task.handOff()`, end the round, and explain what they should do. Do not guess credentials or work around it silently.

After the user confirms, resume the same space:

```js
const task = await takeOverTaskSpace(7);
const userPage = task.userPage();
```

Adopt `userPage` if it is unmanaged. Use `waitForControl()` only when the script must wait in place.

### Finishing a task

Run `await task.finish({ keep: [] })` once, in a separate last script after output has shown the request is done, and wait for it before you report. To keep Pages for the exceptions above, list only those labels instead, such as `{ keep: ["p2"] }`; do not close the others one by one. The default also closes tabs kept in an earlier reply.

`finish()` ends all Page labels, kept Pages included; operate no Page after it in this reply. Do not call it when the task stops for user control or an error.

## Popups and files

Start waiting before the action that opens a Page, file chooser, or download.

### Popups and dialogs

```js
const popupPromise = page.waitForEvent("popup");
await page.click('a[target="_blank"]');
const popupPage = await popupPromise;
await popupPage.waitForLoadState();
```

Actions also report immediate popups in `receipt.popups` as `{ label, targetId }`; use `task.page(receipt.popups[0].label)`, and wait for its URL when the destination matters.

A synchronous JavaScript dialog appears in `receipt.dialog` or `page.info()`. Handle it before continuing:

```js
await page.acceptDialog("prompt response");
// Or: await page.dismissDialog();
```

### Uploading files

Set an existing file input with absolute paths: `await page.setInputFiles("input[type=file]", ["/absolute/path/report.pdf"]);` If a click creates the input, wait for the chooser first:

```js
const chooserPromise = page.waitForFileChooser({ timeout: 10_000 });
await page.click("button.upload");
const chooser = await chooserPromise;
const result = await chooser.setFiles("/absolute/path/report.pdf");
```

Handle an upload-triggered dialog in `result.dialog` the same way.

### Downloading files

```js
const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
await page.click("button.download");
const download = await downloadPromise;
console.log({
  url: download.url(),
  suggestedFilename: download.suggestedFilename(),
});
await download.saveAs("/absolute/path/report.pdf");
```

`download.saveAs()` waits for completion, creates parent directories, and must run before the script ends: `download.path()` is a round-local temporary file. `failure()`, `cancel()`, and `delete()` manage its lifecycle. Do not set a download directory with raw CDP; the download wait manages the browser's single shared setting.

## Page code and requests

### JavaScript in the Page

The script runs in Node.js; `window`, `document`, `location`, and DOM APIs belong to the Page. Put DOM work in `page.evaluate()`:

```js
const rows = await page.evaluate(
  ({ selector, limit }) =>
    [...document.querySelectorAll(selector)].slice(0, limit).map((node) => ({
      text: node.textContent?.trim(),
      href: node.querySelector("a")?.href,
    })),
  { selector: "article", limit: 20 },
);
```

The callback cannot read script variables or Node.js modules. Pass inputs as the second argument and define helpers inside it; inputs and results must be JSON-serializable. `evaluate()` has no timeout option, so keep long work in bounded calls.

### Network requests

`page.fetch()` runs `window.fetch()` in the Page, with its relative URLs, cookies, service workers, and CORS. It returns `{ ok, status, statusText, url, headers, body }`:

```js
const response = await page.fetch("/api/items", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ limit: 20 }),
  timeout: 10_000,
});
```

Save binary responses without converting them to text: `await page.fetch("/image.png", { saveAs: "/absolute/path/image.png" });` Use Node.js `fetch()` for requests that need no Page behavior.

### Using CDP

Use Page methods first. If one is missing or unreliable on the current page, use the Chrome DevTools Protocol for diagnosis or control: `page.cdp()` for Page, Runtime, DOM, Network, Input, and similar commands, `task.cdp()` for Target and Browser commands, except permissions (below). Raw CDP invalidates refs; take a new snapshot. Do not persist `page.targetId` across rounds.

## API reference

Call `help()` or `help("page.click")` for signatures and uncommon options; it prints by itself, so do not wrap it in `console.log`.

### TaskSpace

| Category              | API                                                                        |
| --------------------- | -------------------------------------------------------------------------- |
| State and Page refs   | `spaceId`, `name`, `ownership`, `page(label)`, `userPage()`                |
| Pages                 | `pages()`, `tabs()`, `newPage()`, `adopt(page, { as? })`, `release(label)` |
| Control and finishing | `waitForControl(options)`, `handOff()`, `finish({ keep })`                 |
| Protocol              | `cdp(method, params, options)`                                             |

### Page

| Category               | API                                                                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State and observation  | `label`, `spaceId`, `openedBy`, `targetId`, `url()`, `title()`, `info()`, `snapshot()`, `screenshot()`                                                      |
| Navigation and waits   | `goto()`, `reload()`, `waitForURL()`, `waitForEvent()`, `waitForSelector()`, `waitForLoadState()`, `waitForFunction()`, `waitForTimeout()`                  |
| Elements               | `click()`, `dblclick()`, `hover()`, `dragAndDrop()`, `fill()`, `selectOption()`, `focus()`, `press()`, `setInputFiles()`, `waitForFileChooser()`, `close()` |
| Dialogs                | `acceptDialog(promptText?)`, `dismissDialog()`                                                                                                              |
| Mouse                  | `mouse.click()`, `mouse.move()`, `mouse.down()`, `mouse.up()`, `mouse.wheel()`                                                                              |
| Keyboard               | `keyboard.down()`, `keyboard.up()`, `keyboard.press()`, `keyboard.type()`, `keyboard.insertText()`, `keyboard.paste()`                                      |
| Page code and protocol | `evaluate(fnOrString, argument)`, `fetch(url, options)`, `cdp(method, params, options)`, `events()`                                                         |

## Troubleshooting and special cases

### Script input and runtime

When the user explicitly asks for ego-browser, start browser work right after reading this guide; diagnose installation only if a command fails.

- **The sandbox rejects heredoc.** Use `ego-browser nodejs -e '<code>'`, with single quotes around the code and double quotes for JavaScript strings.
- **Local files or environment variables are not found.** The script runs outside your shell's working directory and environment. Use absolute paths for every file, and write inputs into the script instead of `process.env`. Load Node.js built-ins with dynamic imports such as `await import("node:fs/promises")` (ESM).

<!-- platform: windows -->

- **PowerShell truncates the script or corrupts Chinese text.** Use the `.mjs` file form. The 5.1 `Get-Content` pipe corrupts non-ASCII text and truncates strings, and there is no `<` redirection; `Set-Content`, `Out-File`, and `>` write ANSI or UTF-16.
- **A top-level `await` syntax error.** `SyntaxError: await is only valid in async functions and the top level bodies of modules` almost always means the shell damaged the script. Switch to the `.mjs` file; do not wrap the code in an async IIFE, open a new task space, or resend the command.
- **Windows paths are misread.** Backslashes are JavaScript escapes; use forward slashes, such as `C:/Users/<name>/ego-shots/before.png`.

<!-- /platform -->

### Confusing APIs and options

- **Names look like Playwright.** This is not Playwright. Use only the TaskSpace, Page, FileChooser, mouse, and keyboard APIs listed here; do not infer `locator()`, `getByRole()`, `context()`, `expect()`, or `route()`. For anything else, use `page.evaluate()` or `page.cdp()`; do not import Playwright or launch another browser.
- **A `label` option is rejected.** Methods other than the pointer actions above, such as `fill()`, `press()`, `focus()`, `waitForSelector()`, `keyboard.*()`, `mouse.down()`, and `mouse.up()`, reject it. In `selectOption(selector, { label })`, `label` is the option's visible text.

### Browser permission requests

Permissions CDP supports can be set before the request, for the current round only. Use `denied` for unrelated requests and `granted` only when the user explicitly authorized it:

```js
const { targetInfo } = await page.cdp("Target.getTargetInfo");
await page.cdp("Browser.setPermission", {
  permission: { name: "geolocation" },
  setting: "denied",
  origin: new URL(await page.url()).origin,
  browserContextId: targetInfo.browserContextId,
});
```

If a prompt already appeared and calls fail with `EGO_TASK_SPACE_USER_IN_CONTROL`, leave it to the user and resume as in "User control".

### Space names and resuming

- **The name is taken.** If `taskSpace(name)` fails with `EGO_TASK_SPACE_NAME_IN_USE`, ask the user whether to work in that space (then `claimTaskSpace(id)`), or pick another name.
- **A Page is stuck, blocked, timed out, or unexpected.** Recover in the current space; never open a new TaskSpace instead. If it cannot continue, stop and ask the user.
- **A Page label is missing.** `task.page(label)` never creates a Page and its handle is always truthy, so `task.page("p2") || await task.newPage()` and `if (!page)` do not detect a missing label. Use labels from earlier output or `await task.pages()`.
- **Another user-owned, inactive, or finished space.** Claim it only when the user explicitly asks (your current goal's space is claimed as in "Starting a later reply"). Names may repeat, so use the numeric id: `listTaskSpaces()` entries expose `id` (only a TaskSpace handle has `spaceId`); pass `entry.id` to `claimTaskSpace()`, then adopt `task.userPage()` if unmanaged.
- **The user names a browser profile.** Only then inspect or select profiles; see `help("profiles")`. `profileId` applies only when creating a space.
- **The space survives `finish()`.** User-created and unknown-origin tabs are protected; if any remain, `keep: []` does not close the space, and the output says so. Do not close them for that. Tabs you kept and later claimed are yours, and the blank tab left when `page.close()` closes the last Page is SDK-owned; neither blocks closing.

### Selectors and page scope

- **Text matching.** Unquoted `text=...` normalizes whitespace, ignores case, and matches a substring; `text="Save changes"` is exact and case-sensitive.
- **Compatible syntax.** `css=...`, terminal `:has-text("...")` and `:text-is("...")`, `>> nth=N` after a CSS, text, or href selector (`N` is `-1` or non-negative), and `loc=role:...[name*="..."]` for name substrings. Other Playwright selector syntax is not supported.
- **Wrappers, shadow DOM, iframes.** CSS searches nested open shadow roots. Locators use an actionable match in the top document first, then search frames; several actionable matches in the chosen document are ambiguous. A subtree snapshot does not change this. For a wrapper, `focus()` and `press()` may use its interactive ancestor or unique editable descendant; `fill()` and `setInputFiles()` only continue to a unique compatible control.
- **Expected content is missing.** A final `[more content below the viewport: ...]` line means nodes are omitted, not absent. Scroll or use `full_page` before concluding it is not there.

### An action did not produce the expected result

Inspect the page before retrying; do not blindly repeat it or jump to coordinates or raw CDP. Check the target, whether the app is still working, and whether a dialog or new Page appeared, then choose a wait from the table above.

### Navigation and Page execution timeouts

- **`goto()` or `reload()` times out.** The uncommitted navigation is stopped and the Page stays usable on its previous document; retry with a longer timeout.
- **Calls fail with `EGO_PAGE_UNRESPONSIVE` after a link click.** A call on a Page with a pending navigation waits one bounded period, then stops it and fails; the error says which document is shown and how to load the pending one. `evaluate()` reports `EGO_PAGE_EVALUATION_TIMED_OUT` with `stopped`.
- **`evaluate()` hits a safety timeout.** The Page code may still run. Check `executionStopped` and `mayHaveLateEffects` to decide whether to reload or close the Page before an unsafe follow-up.

### Screenshot timeouts

`page.screenshot()` can sometimes fail after about 15s with `EGO_PAGE_UNRESPONSIVE` on `Page.captureScreenshot`, even if `page.evaluate()` still works. Retry at most once. For a canvas, read pixels through `page.evaluate()` with `canvas.toDataURL("image/png")`; tainted canvases throw and WebGL may read blank, which does not prove the canvas is empty.

### CDP parameters and console events

- **`sessionId` is rejected.** `page.cdp()` and `task.cdp()` do not accept it inside params.
- **No `Runtime.consoleAPICalled`.** Page sessions hide console messages from CDP so sites cannot detect automation. To debug, call `await page.cdp("egoAutomated.disable")`, then `page.cdp("Runtime.enable")`; sites can detect CDP while it is off.

### Update notices

If the final output contains `[ego-browser:notice]`, finish the current task, then tell the user an Ego Lite update is available. Run `ego-browser upgrade` only with their approval, then run `ego-browser skill` again.
