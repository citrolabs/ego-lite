<div align="center">

<img src="docs/assets/banner.png" alt="ego lite" width="100%" />

**AI 智能体执行浏览器自动化任务的最快浏览器。**

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

<a href="https://trendshift.io/repositories/42334?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-42334" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/42334" alt="citrolabs%2Fego-lite | Trendshift" width="250" height="55"/></a>

<p>
  <a href="https://cdn.ego.app/channel/github_github_referral/setup/macos/arm64/egolite.dmg"><img src="https://img.shields.io/badge/Download-Apple%20Silicon-000000?style=for-the-badge&logo=apple&logoColor=white" alt="下载 Apple Silicon 版本" /></a>
  <a href="https://cdn.ego.app/channel/github_github_referral/setup/macos/x64/egolite.dmg"><img src="https://img.shields.io/badge/Download-Intel-000000?style=for-the-badge&logo=apple&logoColor=white" alt="下载 Intel 版本" /></a>
  <a href="https://discord.gg/5eGZVvHbTq"><img src="https://img.shields.io/badge/Discord-Join-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="加入 Discord" /></a>
  <a href="https://x.com/ego_agent"><img src="https://img.shields.io/badge/Follow-%40ego__agent-000000?style=for-the-badge&logo=x&logoColor=white" alt="在 X 上关注 @ego_agent" /></a>
  <a href="https://lite.ego.app/document/"><img src="https://img.shields.io/badge/Docs-lite.ego.app-1E90FF?style=for-the-badge&logo=gitbook&logoColor=white" alt="文档" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-3DA639?style=for-the-badge" alt="MIT 许可证" /></a>
</p>

</div>

ego (lite) 是一款让你与 AI 智能体并行工作的浏览器。智能体可以在各自的 Space 中同时执行多项浏览器任务，而你的标签页仍归你使用；任务还能以更少的 token 更快完成。

browser-use 和 agent-browser 等现有工具属于浏览器自动化框架：它们需要另行驱动一款浏览器，登录状态难以顺利迁移，你和智能体最终还会争用同一批标签页。ego lite 从一开始就是为你与智能体共享而设计的一款浏览器。无需额外配置，智能体始终可以通过 `ego-browser` 使用你真实的登录状态和标签页。

## 演示

https://github.com/user-attachments/assets/ffe7954b-58ee-411e-b35d-ec30c58a08bc

## 快速开始

ego lite 目前支持 macOS。Windows 和 Linux 已列入[路线图](https://lite.ego.app/roadmap)。

### 1. 安装

选择最适合你的方式。

**1.1 下载 macOS 应用**

<a href="https://cdn.ego.app/channel/github_github_referral/setup/macos/arm64/egolite.dmg"><img src="https://img.shields.io/badge/⬇%20Apple%20Silicon-.dmg-000000?style=for-the-badge&logo=apple&logoColor=white" alt="下载适用于 Apple Silicon 的 ego lite" /></a>
<a href="https://cdn.ego.app/channel/github_github_referral/setup/macos/x64/egolite.dmg"><img src="https://img.shields.io/badge/⬇%20Intel-.dmg-000000?style=for-the-badge&logo=apple&logoColor=white" alt="下载适用于 Intel 的 ego lite" /></a>

点击下载，然后打开文件进行安装。无论使用哪种方式，ego lite 都会把 `ego-browser` 技能添加到你机器上每个智能体的技能目录中。

**1.2 使用 npx 添加技能**

仅安装 `ego-browser` 技能：

```bash
npx skills add citrolabs/ego-lite
```

当你的智能体首次执行浏览器任务时，它会引导你安装 ego lite 应用。

**1.3 让智能体完成设置**

将以下内容粘贴给你的智能体：

```
Set up ego lite for me: https://github.com/citrolabs/ego-lite

Read `skills/ego-browser/references/install.md` and follow the steps to install ego lite.
```

首次启动时，ego lite 会询问你是否迁移 Chrome 数据。选择“是”，智能体就能继承你现有的登录状态、Cookie、扩展程序和书签。

### 2. 执行第一个任务

在智能体 CLI 中输入 `/ego-browser`，加一个空格，再用自然语言描述你的需求：

```
ego-browser follow @ego_agent on x.com for me
```

智能体会加载 `ego-browser` 技能，在自己的 Space 中打开页面、读取 Snapshot、操作页面并返回结果，而你的标签页始终不受影响。

你的浏览数据会保留在本地设备上。ego lite 只会记录你在设置期间是否选择迁移 Chrome 数据。

## ego lite 的亮点

| 功能 | 作用 |
|---|---|
| **以代码而非 CLI 为基础，在复杂任务中以更少的 token 更快运行** | ego lite 向智能体提供的能力都封装为可直接调用的 JavaScript 函数。这样，智能体就能发挥最擅长的能力：编写代码，把多步骤任务组合成一次执行，而不会陷入“调用两条命令、查看结果、再调用两条命令”的循环。与传统 CLI 方式相比，复杂工作流的完成速度最高可提升 2.5 倍，任务成功率更高，所需工具调用也显著减少。 |
| **每个智能体都有专属 Space** | ego lite 为每个智能体提供完全隔离的 Space。你在前台浏览，智能体在后台工作，彼此互不干扰。你可以随时查看哪个 Space 中有智能体正在运行，也可以接管或停止它。 |
| **智能体可在同一浏览器的多个并行工作区 Space 中多任务处理** | 每个 Space 都可以分配给一个智能体或一项任务，并且全部同时运行。例如，Claude Code 在 10 个并行 Space 中丰富 10 条潜在客户信息，Codex 再用另外 5 个 Space 抓取 5 个竞品网站。它们不会冲突或抢占你的标签页，你的鼠标也始终停留在原处。 |
| **市场上最强的页面 Snapshot** | 得益于内核级定制，ego lite 可以生成高质量的页面快照，也就是模型用于“看见”和操作网页的视觉文本输入。它能可靠处理深层嵌套 iframe 等棘手场景，而其他方案往往正是在这些场景中失效。 |
| **任何智能体都能通过 `ego-browser` 驱动它** | `ego-browser` 是任意智能体 CLI（Claude Code、Codex、Cursor 或自定义智能体）与 ego lite 之间的连接层。它把浏览器能力作为一组页面内 JavaScript 工具开放出来：snapshot、fill、click、wait、navigate、capture。智能体编写调用这些工具的 JavaScript 代码片段，`ego-browser` 再一次性在页面中执行。 |
| **积累经验，让智能体越用越快** *（即将推出）* | 智能体处理浏览器任务的大部分时间都耗在反复试错上。ego lite 的官方 Skill 会把每次成功操作提炼成可复用的工具和工作流，让以后处理类似任务时速度最高提升 5 倍。 |

## ego lite 与现有产品的对比

大多数工具都能自动化浏览器。真正的问题在于：智能体使用的是哪款浏览器、你能否同时继续工作，以及该工具是为你已经在用的智能体构建，还是只能使用其内置智能体。

| 能力 | ego lite | Browser-Use | agent-browser (Vercel) | ChatGPT Atlas | Perplexity Comet |
|---|:---:|:---:|:---:|:---:|:---:|
| 并行处理多项任务 | ✓ | — | — | — | — |
| 可复用技能 | ✓ | — | — | — | — |
| 继承 Chrome 数据 | ✓ | — | — | ✓ | ✓ |
| 同一浏览器中的独立工作区 | ✓ | — | — | — | — |
| 压缩后的语义输入 | ✓ | — | ✓ | — | — |
| 可由外部智能体控制 | ✓ | ✓ | ✓ | — | — |
| 数据存储在本地 | ✓ | ✓ | ✓ | — | — |
| 无登录摩擦 | ✓ | — | — | ✓ | ✓ |
| 可作为日常浏览器使用 | ✓ | — | — | ✓ | ✓ |
| 免费 | ✓ | ✓ | ✓ | — | — |

另有两类产品试图解决同一个问题。Browser-Use、Vercel agent-browser 等浏览器自动化框架是由智能体调用的库；它们本身不提供浏览器，因此需要另行驱动浏览器，你的登录状态也很难顺利迁移。ChatGPT Atlas、Perplexity Comet 等 AI 浏览器则提供内置智能体，而且只有该智能体才能驱动浏览器。ego lite 是一款从一开始就为你和任意自带智能体共享而设计的浏览器。

## 基准测试

我们通过四项复杂的浏览器自动化任务，将 ego lite 与 Vercel 的 agent-browser 进行了对比。ego lite 完成每项任务的速度最高提升 2.5 倍，同时消耗的 token 显著更少。任务越复杂，优势就越明显。请查看对比结果。

<div align="center">

<img src="docs/assets/ego-vs-agent-benchmark.png" alt="ego lite 与 agent-browser 在四项任务中的速度和成本对比" width="100%" />

</div>

## 文档

教程、完整工具参考和集成指南位于 [lite.ego.app/document/](https://lite.ego.app/document/)。

## 社区

- [Discord](https://discord.gg/5eGZVvHbTq)：问题交流、设置帮助和技能分享
- [GitHub Discussions](https://github.com/citrolabs/ego-lite/discussions)：创意和深入讨论
- [X/Twitter](https://x.com/ego_agent)：动态和版本发布

## Star 历史

<a href="https://www.star-history.com/?repos=citrolabs%2Fego-lite&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=citrolabs/ego-lite&type=date&theme=dark&legend=top-left&sealed_token=REc3U13uyXA_SL88c2BU0N5DOPw40Uiufp-RaA8pQS-JIMVaaxcGBjHmFV3Vwn9GMMIiL5e40DXSqHNcDjtXItvqvpMr013AaU6OkphU5o60GjasXVoXTQRR4TkWQSCPrPIxmKHehNll1TAsdoQ8rD3wPyRaj-Z_iHXqDDWf9b0gSWHxkyYoMUj6yWxY" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=citrolabs/ego-lite&type=date&legend=top-left&sealed_token=REc3U13uyXA_SL88c2BU0N5DOPw40Uiufp-RaA8pQS-JIMVaaxcGBjHmFV3Vwn9GMMIiL5e40DXSqHNcDjtXItvqvpMr013AaU6OkphU5o60GjasXVoXTQRR4TkWQSCPrPIxmKHehNll1TAsdoQ8rD3wPyRaj-Z_iHXqDDWf9b0gSWHxkyYoMUj6yWxY" />
   <img alt="Star 历史图表" src="https://api.star-history.com/chart?repos=citrolabs/ego-lite&type=date&legend=top-left&sealed_token=REc3U13uyXA_SL88c2BU0N5DOPw40Uiufp-RaA8pQS-JIMVaaxcGBjHmFV3Vwn9GMMIiL5e40DXSqHNcDjtXItvqvpMr013AaU6OkphU5o60GjasXVoXTQRR4TkWQSCPrPIxmKHehNll1TAsdoQ8rD3wPyRaj-Z_iHXqDDWf9b0gSWHxkyYoMUj6yWxY" />
 </picture>
</a>

## 许可证

本仓库内容采用 [MIT 许可证](LICENSE)发布。ego lite 浏览器是另外提供的免费下载软件。
