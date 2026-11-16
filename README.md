<div align="center">

<img src="docs/assets/banner.png" alt="ego lite" width="100%" />

**The fastest browser for AI agents to run web automation**

<a href="https://trendshift.io/repositories/42334?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-42334" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/42334" alt="citrolabs%2Fego-lite | Trendshift" width="250" height="55"/></a>

<p>
  <a href="https://cdn.ego.app/setup/macos/arm64/egolite-Y7MbxKIuhzFB.dmg"><img src="https://img.shields.io/badge/Download-Apple%20Silicon-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download for Apple Silicon" /></a>
  <a href="https://cdn.ego.app/setup/macos/x64/egolite-Y7MbxKIuhzFB.dmg"><img src="https://img.shields.io/badge/Download-Intel-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download for Intel" /></a>
  <a href="https://cdn.ego.app/setup/windows/x64/egoliteSetup-Y7MbxKIuhzFB.exe"><img src="https://img.shields.io/badge/Download-Windows-000000?style=for-the-badge&logo=data:image/svg%2Bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI%2BPHBhdGggZmlsbD0iI2ZmZiIgZD0iTTAgMGgxMS4zNzd2MTEuMzcySDB6bTEyLjYyMyAwSDI0djExLjM3MkgxMi42MjN6TTAgMTIuNjIzaDExLjM3N1YyNEgwem0xMi42MjMgMEgyNFYyNEgxMi42MjN6Ii8%2BPC9zdmc%2B" alt="Download for Windows" /></a>
  <a href="https://discord.gg/5eGZVvHbTq"><img src="https://img.shields.io/badge/Discord-Join-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord" /></a>
  <a href="https://x.com/ego_agent"><img src="https://img.shields.io/badge/Follow-%40ego__agent-000000?style=for-the-badge&logo=x&logoColor=white" alt="Follow @ego_agent on X" /></a>
  <a href="https://lite.ego.app/document/"><img src="https://img.shields.io/badge/Docs-lite.ego.app-1E90FF?style=for-the-badge&logo=gitbook&logoColor=white" alt="Docs" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-3DA639?style=for-the-badge" alt="License MIT" /></a>
</p>

<p>
  <b>English</b> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.pt.md">Português</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.it.md">Italiano</a> ·
  <a href="README.ru.md">Русский</a>
</p>

</div>

ego (lite) is a browser where you and your AI agents work in parallel. Your agents run their browser tasks in their own Spaces, isolated workspaces inside the same browser, while you keep browsing in yours, so no agent ever takes the browser away from you. And the automation itself finishes faster, on fewer tokens.

Existing tools like browser-use and agent-browser are a bridge to the browser, not a browser of their own: they need a separate one to drive, your browser data rarely carries over intact, the connection is unstable, and you and the agent end up fighting over control of the browser. ego lite is one browser designed from the start for the two of you to share. No extra setup, and the agent can always reach your real logins and tabs through `ego-browser`.

## Demo

https://github.com/user-attachments/assets/ffe7954b-58ee-411e-b35d-ec30c58a08bc

## Quick Start

ego lite runs on macOS and Windows, and Linux is on the [roadmap](https://lite.ego.app/roadmap).

### 1. Install

Pick whichever fits your flow.

**1.1 Download the app**

<a href="https://cdn.ego.app/setup/macos/arm64/egolite-Y7MbxKIuhzFB.dmg"><img src="https://img.shields.io/badge/⬇%20Apple%20Silicon-.dmg-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download ego lite for Apple Silicon" /></a>
<a href="https://cdn.ego.app/setup/macos/x64/egolite-Y7MbxKIuhzFB.dmg"><img src="https://img.shields.io/badge/⬇%20Intel-.dmg-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download ego lite for Intel" /></a>
<a href="https://cdn.ego.app/setup/windows/x64/egoliteSetup-Y7MbxKIuhzFB.exe"><img src="https://img.shields.io/badge/⬇%20Windows-.exe-000000?style=for-the-badge&logo=data:image/svg%2Bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI%2BPHBhdGggZmlsbD0iI2ZmZiIgZD0iTTAgMGgxMS4zNzd2MTEuMzcySDB6bTEyLjYyMyAwSDI0djExLjM3MkgxMi42MjN6TTAgMTIuNjIzaDExLjM3N1YyNEgwem0xMi42MjMgMEgyNFYyNEgxMi42MjN6Ii8%2BPC9zdmc%2B" alt="Download ego lite for Windows" /></a>

Click to download, then open it to install. Either way, ego lite adds the `ego-browser` skill to every agent's skills directory on your machine.

**1.2 Add the skill with npx**

Install just the `ego-browser` skill:

```bash
npx skills add citrolabs/ego-lite
```

The first time your agent runs a browser task, it walks you through installing the ego lite app.

**1.3 Let your agent set it up**

Paste this into your agent:

```
Set up ego lite for me: https://github.com/citrolabs/ego-lite

Read `skills/ego-browser/references/install.md` and follow the steps to install ego lite.
```

On first launch, ego lite asks one question, whether to migrate your Chrome data. Say yes and your agent inherits your existing logins, cookies, extensions, and bookmarks.

### 2. Try your first task

In your agent CLI, type `/ego-browser` followed by a space, then describe what you want in plain language:

```
ego-browser follow @ego_agent on x.com for me
```

The agent picks up the `ego-browser` skill, opens the page in its own Space, reads a Snapshot (the page turned into structured text), acts on the page, and reports back, all while your own tabs stay untouched.

Your browsing data, cookies, and everything else the browser holds stay on your device. ego lite keeps its data collection deliberately narrow: simple product signals, like whether you've set ego lite as your default browser.

## Highlights of ego lite

| Feature | What it does |
|---|---|
| **Code-based, not CLI-based: faster runs on fewer tokens for complex tasks** | The capabilities ego lite exposes to the agent are wrapped as JavaScript functions the agent calls directly. The agent gets to do what it does best: write code, composing a multi-step task into a single output instead of getting stuck in a "call two commands, look at the result, call two more commands" loop. Compared to the conventional CLI approach, complex workflows finish far faster, with higher task success rates, far fewer tool calls per task, and a much lower cost per task. |
| **A dedicated Space for every agent** | ego lite gives each agent its own fully isolated Space. You browse up front, your agent works in the background, and they don't get in each other's way. You can see which Space has an agent running at any moment, and take it over or stop it whenever you want. |
| **Your agents multitask in Spaces, parallel workspaces inside the same browser** | Each Space gets its own AI agent or its own task, all running at the same time. Claude Code enriching 10 leads in 10 parallel Spaces. Codex scraping 5 competitor sites in 5 more. They don't collide or steal your tabs. Your mouse stays where you left it. |
| **The strongest page Snapshot on the market** | Thanks to customization inside the browser engine, ego lite produces the highest-quality page snapshots, the view text-only models rely on to "see" and act on a webpage. It reliably handles tough cases like deeply nested iframes, exactly where other approaches consistently break down. |
| **Any agent can drive it through `ego-browser`** | `ego-browser` is the connection layer between any agent CLI (Claude Code, Codex, Cursor, or a custom one) and ego lite. It exposes the browser as a set of in-page JavaScript tools: snapshot, fill, click, wait, navigate, capture. The agent writes a JavaScript snippet calling those tools, and `ego-browser` runs it on the page in one pass. |
| **Experience accumulation that makes your agent faster the more you use it** *(coming soon)* | Most of an agent's time on browser tasks goes to trial and error. ego lite's official Skill distills every successful action into reusable tools and workflows, so similar tasks down the line run up to 5x faster. |

## ego lite vs existing products

Most tools can automate a browser. The real questions are what browser the agent gets, whether you can keep working at the same time, and whether the tool is built for the agent you already use or a built-in one.

| Feature | ego lite | Browser extensions<br><sub>Claude/Codex in Chrome</sub> | Built-in browsers<br><sub>Claude/ChatGPT built-in browser</sub> | Cloud browsers<br><sub>Browserbase/Browser Use</sub> | Browser CLIs<br><sub>playwright-cli/Browser Harness</sub> | AI browsers<br><sub>Comet/Dia</sub> |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Works with any AI agent | ✓ | — | — | ✓ | ✓ | — |
| Uses your browser logins | ✓ | ✓ | — | — | — | ✓ |
| Fewer CAPTCHAs | ✓ | ✓ | — | — | — | ✓ |
| Works across your whole computer | ✓ | — | ✓ | — | ✓ | — |
| Doesn't hijack your browser | ✓ | — | ✓ | ✓ | — | — |
| Parallel multitasking | ✓ | — | — | ✓ | — | — |
| Runs large scraping jobs | ✓ | — | — | ✓ | ✓ | — |
| Works as your daily browser | ✓ | ✓ | — | — | — | ✓ |
| Free | ✓ | — | — | — | ✓ | — |
| Data stored locally | ✓ | ✓ | ✓ | — | ✓ | — |
| Reusable skills (coming soon) | ✓ | — | — | — | — | — |

## Benchmarks

Faster runs, higher success rates, fewer tokens. We ran ego-browser and four other browser tools for AI agents on Real-World Bench: 31 complex browser automation tasks on live websites. ego-browser leads on speed, success rate, and cost, and gets your agent through complex web tasks 47% to 63% faster than the other tools.

<div align="center">

<img src="docs/assets/real-world-bench.jpg" alt="Real-World Bench, 31 tasks: ego-browser vs Browser Harness, playwright-cli, chrome-devtools-cli and agent-browser on turns, rubric average, perfect rate, trajectory efficiency, average duration and average cost" width="100%" />

</div>

Every tool ran the same 31 tasks, driven by the same agent (pi) with the same model (gpt-5.6-sol, thinking effort max) and graded by the same judge against per-task rubrics. A task counts as a full success only when every requirement is met.

## Docs

Tutorials, the full tool reference, and integration guides live at [lite.ego.app/document/](https://lite.ego.app/document/).

## Community

- [Discord](https://discord.gg/5eGZVvHbTq), questions, setup help, and skill sharing
- [GitHub Discussions](https://github.com/citrolabs/ego-lite/discussions), ideas and longer threads
- [X/Twitter](https://x.com/ego_agent), updates and releases

## Star History

<a href="https://github.com/citrolabs/ego-lite/stargazers">
<!-- star-history:start -->
<!-- Generated daily by .github/workflows/star-history.yml and published to the
     'star-history' branch, because main's ruleset will not take a bot commit. -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/citrolabs/ego-lite/star-history/star-history-dark.svg">
  <img alt="Star history" src="https://raw.githubusercontent.com/citrolabs/ego-lite/star-history/star-history-light.svg">
</picture>
<!-- star-history:end -->
</a>

## License

The contents of this repository are released under the [MIT License](LICENSE). The ego lite browser is a separate, free download.