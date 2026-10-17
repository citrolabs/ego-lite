<div align="center">

<img src="docs/assets/banner.png" alt="ego lite" width="100%" />

**让 AI Agent 以最快速度执行网页自动化的浏览器**

<a href="https://trendshift.io/repositories/42334?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-42334" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/42334" alt="citrolabs%2Fego-lite | Trendshift" width="250" height="55"/></a>

<p>
  <a href="https://cdn.ego.app/setup/macos/arm64/egolite-Y7MbxKIuhzFB.dmg"><img src="https://img.shields.io/badge/Download-Apple%20Silicon-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download for Apple Silicon" /></a>
  <a href="https://cdn.ego.app/setup/macos/x64/egolite-Y7MbxKIuhzFB.dmg"><img src="https://img.shields.io/badge/Download-Intel-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download for Intel" /></a>
  <a href="https://discord.gg/5eGZVvHbTq"><img src="https://img.shields.io/badge/Discord-Join-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord" /></a>
  <a href="https://x.com/ego_agent"><img src="https://img.shields.io/badge/Follow-%40ego__agent-000000?style=for-the-badge&logo=x&logoColor=white" alt="Follow @ego_agent on X" /></a>
  <a href="https://lite.ego.app/document/"><img src="https://img.shields.io/badge/Docs-lite.ego.app-1E90FF?style=for-the-badge&logo=gitbook&logoColor=white" alt="Docs" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-3DA639?style=for-the-badge" alt="License MIT" /></a>
</p>

<p>
  <a href="README.md">English</a> ·
  <b>简体中文</b> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.pt.md">Português</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.it.md">Italiano</a> ·
  <a href="README.ru.md">Русский</a>
</p>

</div>

ego (lite) 是一款能够让你和你的 AI Agent 并行工作的浏览器。你的 Agent 在自己的 Space 里执行多个浏览器任务的同时，你可以在属于自己的 Space 里自由地浏览网页，Agent 再也不会抢走你对浏览器的控制权。与此同时，网页自动化任务完成得更快，Token 消耗也更少。

像 browser-use、agent-browser 这类现有工具本质上是浏览器自动化桥接工具：它们需要另找一个浏览器来驱动，很难完整带过去浏览器数据，连接也不稳定，你和 Agent 最后还要抢浏览器当前的控制权。而 ego lite 从设计之初就是给你们两方共用的浏览器。无需额外配置，Agent 随时都能通过 `ego-browser` 拿到你真实的登录状态和标签页。

## 演示

https://github.com/user-attachments/assets/ffe7954b-58ee-411e-b35d-ec30c58a08bc

## 快速开始

ego lite 目前支持 macOS，且 Windows 版本即将发布内测，与此同时，Linux 已在[路线图](https://lite.ego.app/roadmap)上。

### 1. 安装

选一种适合你的方式。

**1.1 下载 macOS 应用**

<a href="https://cdn.ego.app/setup/macos/arm64/egolite-Y7MbxKIuhzFB.dmg"><img src="https://img.shields.io/badge/⬇%20Apple%20Silicon-.dmg-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download ego lite for Apple Silicon" /></a>
<a href="https://cdn.ego.app/setup/macos/x64/egolite-Y7MbxKIuhzFB.dmg"><img src="https://img.shields.io/badge/⬇%20Intel-.dmg-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download ego lite for Intel" /></a>

点击即可下载，打开后完成安装。无论用哪种方式，ego lite 都会把 `ego-browser` Skill 写进你机器上每个 Agent 的 Skill 目录。

**1.2 用 npx 添加 Skill**

只安装 `ego-browser` Skill：

```bash
npx skills add citrolabs/ego-lite
```

Agent 第一次执行浏览器任务时，会带你完成 ego lite 应用的安装。

**1.3 让 Agent 自己装好**

把下面这段粘进你的 Agent：

```
帮我装好 ego lite：https://github.com/citrolabs/ego-lite

阅读 `skills/ego-browser/references/install.md`，按步骤安装 ego lite。
```

首次启动时，ego lite 只问一个问题：要不要迁移你的 Chrome 数据。选择是，你的 Agent 就能直接继承你现有的登录状态、Cookie、扩展程序和书签。

### 2. 拿第一个任务练练手

在 Agent 的 CLI 里输入 `/ego-browser`，空一格，然后用大白话描述你想要什么：

```
ego-browser 帮我关注 x.com 上的 @ego_agent
```

Agent 会加载 `ego-browser` Skill，在自己的 Space 里打开页面，读取 Snapshot，在页面上执行操作，再把结果汇报给你，整个过程你的标签页完全不受影响。

你的浏览数据、Cookie 等所有浏览器数据都留在本机。ego lite 的数据收集非常克制，只会记录你是否把 ego lite 设为默认浏览器这类简单的产品数据。

## ego lite 的亮点

| 特性 | 它能做什么 |
|---|---|
| **以代码为本，而非 CLI，复杂任务跑得更快、Token 更少** | ego lite 向 Agent 开放的能力都封装成 JavaScript 函数，由 Agent 直接调用。Agent 得以做它最擅长的事：写代码，把多步任务组合成一次输出，而不是陷在「调用两条命令、看结果、再调用两条命令」的循环里。相比传统的 CLI 方式，复杂工作流跑得快很多，任务成功率更高，每个任务的工具调用次数也少得多，最终任务所需的花费也大大减少。 |
| **每个 Agent 都有专属 Space** | ego lite 给每个 Agent 一个完全隔离的 Space。你在前台浏览，Agent 在后台干活，互不干扰。你随时能看到哪个 Space 里有 Agent 在运行，也能随时接管或停止它。 |
| **Agent 在多个 Space 里同时干活，一个浏览器里就有多个并行工作区** | 每个 Space 承载一个 AI Agent 或一个任务，全部同时运行。Claude Code 在 10 个并行 Space 里补全 10 条线索，Codex 在另外 5 个里抓取 5 个竞品网站。它们不会互相冲突，也不会抢走你的标签页。你的鼠标还停在原来的位置。 |
| **市面上最强的页面 Snapshot** | 得益于内核级定制，ego lite 生成的页面 Snapshot 质量最高——这正是文本模型「看懂」网页并对其采取行动所依赖的视图。面对深层嵌套 iframe 这类棘手场景，它依然稳定可靠，而这恰恰是其他方案屡屡失效的地方。 |
| **任何 Agent 都能通过 `ego-browser` 操控它** | `ego-browser` 是任意 Agent CLI（Claude Code、Codex、Cursor 或你自己写的）与 ego lite 之间的连接层。它把浏览器暴露为一组页内 JavaScript 工具：snapshot、fill、click、wait、navigate、capture。Agent 写一段调用这些工具的 JavaScript，`ego-browser` 就在页面上一次性执行完。 |
| **经验积累让 Agent 越用越快** *（即将上线）* | Agent 在浏览器任务上花的时间，大多耗在试错上。ego lite 官方 Skill 会把每一次成功操作沉淀成可复用的工具和工作流，之后再遇到类似任务，最高能快 5x。 |

## ego lite 与现有产品的对比

大多数工具都能实现浏览器自动化。真正的问题在于：Agent 拿到的是哪个浏览器？你能否同时继续做自己的事？这个工具是为你已经在用的 Agent 打造的，还是只服务它自带的那一个？

| 能力 | ego lite | Browser-Use | agent-browser (Vercel) | ChatGPT Atlas | Perplexity Comet |
|---|:---:|:---:|:---:|:---:|:---:|
| 并行多任务 | ✓ | — | — | — | — |
| 可复用技能 | ✓ | — | — | — | — |
| 继承 Chrome 的数据 | ✓ | — | — | ✓ | ✓ |
| 同一个浏览器，独立工作区 | ✓ | — | — | — | — |
| 压缩语义输入 | ✓ | — | ✓ | — | — |
| 由外部 Agent 控制 | ✓ | ✓ | ✓ | — | — |
| 数据存储在本地 | ✓ | ✓ | ✓ | — | — |
| 无登录摩擦 | ✓ | — | — | ✓ | ✓ |
| 日常使用的浏览器 | ✓ | — | — | ✓ | ✓ |
| 免费 | ✓ | ✓ | ✓ | — | — |

另外两类产品也在解同一道题。Browser-Use、Vercel 的 agent-browser 这类浏览器自动化框架，是供 Agent 调用的库；它们自己不带浏览器，所以要另找一个来驱动，你的登录状态也很难完整带过去。ChatGPT Atlas、Perplexity Comet 这类 AI 浏览器自带一个 Agent，而且只有那个 Agent 能驱动浏览器。ego lite 则是一款浏览器，从设计之初就是给你和你带来的任意 Agent 共用的。


## 基准测试

我们在四个复杂的浏览器自动化任务上，把 ego lite 与 Vercel 的 agent-browser 做了对比测试。ego lite 每项任务最多快 2.5×，Token 消耗也大幅减少。任务越难，差距越明显。看看对比结果。

<div align="center">

<img src="docs/assets/ego-vs-agent-benchmark.png" alt="ego lite vs agent-browser, speed and cost across four tasks" width="100%" />

</div>

## 文档

教程、完整的工具参考和集成指南都在 [lite.ego.app/document/](https://lite.ego.app/document/)。

## 社区

- [Discord](https://discord.gg/5eGZVvHbTq)：提问、安装求助、技能分享
- [GitHub Discussions](https://github.com/citrolabs/ego-lite/discussions)：想法和长文讨论
- [X/Twitter](https://x.com/ego_agent)：动态和版本发布

## Star 历史

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

## 许可证

本仓库内容基于 [MIT License](LICENSE) 发布。ego lite 浏览器是独立、免费的下载产品。
