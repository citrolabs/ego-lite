---
name: ego-browser
description: 通过已安装的 ego-browser helper 控制真实浏览器，用于自动化、检查、抓取或操控正在运行的浏览器。
---

# ego-browser

需要操作真实浏览器时使用此 skill。

## 核心规则

- 用户明确要求使用 ego-browser 时，默认 `ego-browser` 和仓库运行时均已就绪，不要事先检查 `which ego-browser`、`node -v`、package metadata 或 help 输出。仅在首次运行出现环境报错时才排查。
- 优先写一个完整的 `ego-browser nodejs` 脚本，一次性完成导航、观察、滚动、抽取、过滤、聚合计算和最终输出。不要再额外用第二个本地 `node` 脚本处理同一批数据。
- heredoc 体内的代码跑在 Node.js；`js(...)` 中的代码跑在浏览器页面。导航、等待、`cliLog(...)` 写在 heredoc 体内；`document`、`window`、页面选择器写在 `js(...)` 中。
- `js()` 接受字符串；也可以传函数，但传函数会触发一次性 warning，并自动以 `.toString()` 方式包裹——此时不会捕获闭包变量，也没有参数通道。不要按 Puppeteer / Playwright 的 `page.evaluate(fn, ...args)` 习惯来使用 `js()`。

## 快速开始

```bash
ego-browser nodejs <<'EOF'
const task = await useOrCreateTaskSpace('ai-gen-task-name')

await openOrReuseTab('https://example.com', { wait: true, timeout: 20 })

cliLog(await snapshotText())
EOF
```

需要在浏览器内执行多步逻辑时，封装进一个闭包并一次性返回，不要拆成多次 `await js()`：

```js
const data = await js(String.raw`(() => {
  const items = [...document.querySelectorAll('article')]
  return items.map(el => ({
    text: el.innerText,
    links: [...el.querySelectorAll('a')].map(a => a.href),
  }))
})()`)
```

文件输入可以直接设置：

```js
await uploadFile('input[type="file"]', "/absolute/path/to/file.pdf")
```

## 常用 helper

- 任务空间：`taskSpaces`, `useOrCreateTaskSpace`, `listTaskSpaces`, `useTaskSpace`, `createTaskSpace`
- 导航/状态：`openOrReuseTab`, `gotoAndWait`, `listTabs`, `currentTab`, `switchTab`, `newTab`, `createTab`, `gotoUrl`, `pageInfo`, `ensureRealTab`
- 观察：`snapshotText`, `captureScreenshot`, `js`, `elementEval`, `cdp`, `drainEvents`
- 滚动/鼠标：`scrollBy`, `scrollToBottomUntil`, `scroll`, `click`, `doubleClick`, `hover`, `dragMouse`
- 键盘与输入：`fill`, `type`, `pressKey`, `typeText`, `fillInput`
- 文件：`uploadFile`
- 等待：`wait`, `waitForLoad`, `waitForElement`, `waitForNetworkIdle`
- Fetch：`httpGet`

> **提示**
> ego-browser nodejs <<'EOF'
cliLog(help("click")); // 查看函数如何使用
EOF

## 默认工作流

1. 复用或创建任务空间：`const task = await useOrCreateTaskSpace(name)`。
2. 打开或切换页面：优先用 `openOrReuseTab(url, { wait: true })`；在当前标签页内导航用 `gotoAndWait(url, { timeout, settle })`。
3. 观察页面：用 `snapshotText()` 获取带 `[ref=N, loc=..., url=...]` 的整页语义树文本，ref 会自动注册到 refMap，之后即可 `click('@N')` / `fill('@N', ...)` / `elementEval('@N', ...)`。`scope` 默认 `'full_page'` 。结构化抽取直接用 `js(String.raw\`...\`)`。
4. 执行动作或抽取数据：能用 DOM 一次性完成的逻辑，封装进一个 browser-side 闭包并一次返回。
5. 输出最终结果：用 `cliLog(...)` 输出。

### 选择方式

- `snapshotText` + ref/loc：按钮、链接、表单控件语义清晰时首选。
- `js` / `elementEval` / `cdp`：读取 DOM、抽取结构化数据、处理虚拟列表时使用。
- `openOrReuseTab`：打开目标 URL 前先复用已有匹配 tab。
- `gotoAndWait`：在当前 tab 导航并等待加载/稳定。
- `scrollBy` / `scrollToBottomUntil`：页面和 timeline 默认滚动方式。
- `scroll`：需要真实 wheel 事件时使用（嵌套滚动容器、类 canvas 界面）。
- `captureScreenshot` + 坐标点击：视觉布局、canvas 或 accessibility 信息残缺时使用。

滚动示例：

```js
// DOM 滚动
await scrollBy(900)
await scrollToBottomUntil(
  async () => await js(String.raw`document.querySelectorAll('article').length`) >= 20,
  { step: 900, wait: 1, maxSteps: 20 }
)

// 真实 wheel
await scroll({ dy: 900 })
```

## 鼠标目标

`click`、`doubleClick`、`hover`、`dragMouse` 等鼠标操作接受相同 target 格式，坐标单位为 CSS 像素：

- `string`：CSS selector 或 `@ref`，点击元素中心。
- `[x, y]` 或 `{x, y}`：viewport 坐标。
- `{selector}`：CSS selector 或 `@ref`，点击元素中心。
- `{selector, x, y}`：以元素左上角为基准，叠加 `x`/`y` 偏移量。

```js
await click('@21')
await click('button.primary')
await click([420, 260])
await click({ x: 420, y: 260 })
await click({ selector: 'canvas#stage', x: 12, y: 8 })
```

## 注意事项

- `snapshotText()` 的 `scope` 默认 `'full_page'`，覆盖整页。绝大多数场景就用默认值；仅在任务只需可见区内容（如只关心当前屏的列表项）时才传 `scope: 'only_within_viewport'`。
- `wait(...)` 和 `timeout` 单位是秒；只有名称以 `Ms` 结尾的参数才是毫秒。
- `listTaskSpaces()` 返回底层对象，结构通常为 `{ taskIds: [...] }`，不能直接 `.find()`；需要数组时用 `taskSpaces()`。
- `@N` 这类 ref 只对最近一次 snapshot 的 refMap 有效——每次调用 `snapshotText()` 都会重建 refMap。ref 编号来自元素的 CDP `backendNodeId`，同一元素在多次 snapshot 中编号相同；但要操作 `@N`，N 必须出现在最近一次 snapshot 的输出中。元素被滚出 viewport、DOM 重渲染，或者上一轮用 `scope:'only_within_viewport'` 而下一轮未能覆盖到该元素，均会触发 `Unknown ref`。需要长期复用某个元素时，可以用 snapshotText 输出里的 `loc=...` 作为稳定 selector，或者直接写 CSS selector。
- `js()` 返回表达式求值结果，不是 JSON 字符串，不要再套 `JSON.parse(...)`。
- 在 `js(...)` 的模板字符串里写正则时，反斜杠要写两次（如 `\\d`、`\\s`），或改用 `String.raw`。
- `js()` 源码若包含顶层 `return` 会被自动包装成 IIFE；嵌套回调里的 `return` 也可能误触发。复杂表达式优先写成 `(() => { ... })()`。
- ego-browser `nodejs` 执行的代码不应先写入 `.js` 文件再运行；直接通过 heredoc 执行即可。
