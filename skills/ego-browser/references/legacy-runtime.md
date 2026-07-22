# Legacy ego-browser runtime compatibility

Read this file only when the installed ego lite app exposes legacy top-level
helpers instead of the Playwright-style `taskSpaces`, `browser`, and `page`
facades documented in `SKILL.md`.

## Confirm the mismatch

Use capability detection because the app and skill have independent version
numbers and may be updated on different schedules:

```bash
ego-browser nodejs <<'EOF'
console.log(JSON.stringify({
  taskSpaces: typeof taskSpaces,
  browser: typeof browser,
  page: typeof page,
  useOrCreateTaskSpace: typeof useOrCreateTaskSpace,
  openOrReuseTab: typeof openOrReuseTab,
  snapshotText: typeof snapshotText,
}, null, 2))
EOF
```

The runtime is legacy when the three facade values are `undefined` and the
top-level helpers are functions. Run `ego-browser upgrade`, restart ego lite,
and repeat the probe first. Use the fallback below only when the public update
channel does not yet provide the Playwright-style runtime.

## Helper mapping

| Playwright-style API | Legacy equivalent |
| --- | --- |
| `taskSpaces.useOrCreate(name)` | `useOrCreateTaskSpace(name)` |
| `taskSpaces.list()` | `listTaskSpaces()` |
| `taskSpaces.claim(id)` | `claimTaskSpace(id)` |
| `taskSpaces.handOff(id)` | `handOffTaskSpace(id)` |
| `taskSpaces.takeOver(id)` | `takeOverTaskSpace(id)` |
| `taskSpaces.complete(id, { keep })` | `completeTaskSpace(id, { keep })` |
| `browser.openOrReuseTab(url, options)` | `openOrReuseTab(url, options)` |
| `browser.listTabs()` | `listTabs()` |
| `browser.switchTab(targetId)` | `switchTab(targetId)` |
| `browser.closeTab(targetId)` | `closeTab(targetId)` |
| `page.info()` | `pageInfo()` |
| `page.snapshot()` | `snapshotText()` |
| `page.screenshot()` | `captureScreenshot()` |
| `page.evaluate(expression)` | `js(expression)` |
| `fetch.server(url, options)` | `serverFetch(url, options)` |
| `fetch.browser(url, options)` | `browserFetch(url, options)` |
| `console.log(value)` | `cliLog(value)` |

Legacy timeouts are in seconds unless a parameter name ends in `Ms`. Do not
copy millisecond values such as `20000` from the Playwright-style examples.
Legacy `js()` accepts a string expression, not a function and argument pair.

## Minimal legacy flow

```bash
ego-browser nodejs <<'EOF'
const task = await useOrCreateTaskSpace('inspect example page')
await openOrReuseTab('https://example.com', { wait: true, timeout: 20 })

const snapshot = await snapshotText()
const info = await pageInfo()
if (!snapshot || !info.url) throw new Error('Example page was not ready')

cliLog(JSON.stringify({
  taskSpaceId: task.id,
  title: info.title,
  url: info.url,
}, null, 2))
EOF
```

Continue with the legacy helpers for the browser task. After a prior command
has verified the final result, complete the task space in its own terminal
command:

```bash
ego-browser nodejs <<'EOF'
const completion = await completeTaskSpace('inspect example page', { keep: false })
if (!completion.done) throw new Error('Task space was not completed: ' + JSON.stringify(completion))
cliLog(JSON.stringify(completion))
EOF
```

Keep the legacy ownership and handoff rules: never reclaim a user-controlled
space without explicit confirmation, and check the `done` result from handoff
and completion calls.
