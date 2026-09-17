<div align="center">

<img src="docs/assets/banner.png" alt="ego lite" width="100%" />

**AI 에이전트가 웹 자동화를 가장 빠르게 실행하는 브라우저**

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
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <b>한국어</b> ·
  <a href="README.pt.md">Português</a> ·
  <a href="README.es.md">Español</a>
</p>

</div>

ego (lite)는 여러분과 AI 에이전트가 나란히 작업할 수 있는 브라우저입니다. 에이전트가 각자의 Space에서 여러 브라우저 작업을 수행하는 동안, 여러분은 자신만의 Space에서 자유롭게 웹을 탐색할 수 있으며, 에이전트가 여러분 브라우저의 제어권을 빼앗는 일은 없습니다. 이와 동시에 웹 자동화 작업은 더 빠르게 끝나고 토큰도 더 적게 소모됩니다.

browser-use나 agent-browser 같은 기존 도구는 본질적으로 브라우저 자동화 브리지 도구입니다. 구동할 별도 브라우저가 필요하고, 완전한 브라우저 데이터를 그대로 가져가기 어렵고, 연결도 불안정하며, 결국 여러분과 에이전트가 브라우저의 현재 제어권을 두고 다투게 됩니다. 반면 ego lite는 처음부터 여러분과 에이전트가 함께 쓰도록 설계된 하나의 브라우저입니다. 추가 설정 없이, 에이전트는 `ego-browser`를 통해 언제든 실제 로그인 상태와 탭에 접근할 수 있습니다.

## Demo

https://github.com/user-attachments/assets/ffe7954b-58ee-411e-b35d-ec30c58a08bc

## 빠른 시작

ego lite는 현재 macOS를 지원합니다. Windows 버전은 곧 비공개 베타를 시작할 예정이며, Linux는 [로드맵](https://lite.ego.app/roadmap)에 있습니다.

### 1. 설치

여러분의 방식에 맞는 방법을 고르세요.

**1.1 macOS 앱 다운로드**

<a href="https://cdn.ego.app/setup/macos/arm64/egolite-Y7MbxKIuhzFB.dmg"><img src="https://img.shields.io/badge/⬇%20Apple%20Silicon-.dmg-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download ego lite for Apple Silicon" /></a>
<a href="https://cdn.ego.app/setup/macos/x64/egolite-Y7MbxKIuhzFB.dmg"><img src="https://img.shields.io/badge/⬇%20Intel-.dmg-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download ego lite for Intel" /></a>

클릭해 다운로드한 뒤 열어서 설치하세요. 어느 방법이든 ego lite는 컴퓨터에 있는 모든 에이전트의 Skill 디렉터리에 `ego-browser` Skill을 추가합니다.

**1.2 npx로 Skill 추가**

`ego-browser` Skill만 설치합니다:

```bash
npx skills add citrolabs/ego-lite
```

에이전트가 처음으로 브라우저 작업을 실행할 때 ego lite 앱 설치 과정을 안내합니다.

**1.3 에이전트가 알아서 설정하게 하기**

에이전트에 다음을 붙여넣으세요:

```
ego lite를 설정해 주세요: https://github.com/citrolabs/ego-lite

`skills/ego-browser/references/install.md`를 읽고 안내에 따라 ego lite를 설치해 주세요.
```

처음 실행하면 ego lite는 Chrome 데이터를 마이그레이션할지 딱 하나만 묻습니다. 여기서 예를 선택하면 에이전트가 기존 로그인 정보, 쿠키, 확장 프로그램, 북마크를 그대로 물려받습니다.

### 2. 첫 작업으로 연습해 보기

에이전트 CLI에서 `/ego-browser`를 입력하고 한 칸 띄운 뒤, 원하는 작업을 자연스러운 말로 설명하세요:

```
ego-browser로 x.com에서 @ego_agent를 팔로우해 주세요
```

에이전트는 `ego-browser` Skill을 불러와 자신의 Space에서 페이지를 열고, Snapshot을 읽고, 페이지에서 동작을 수행한 뒤 결과를 보고합니다. 이 모든 과정에서 여러분의 탭은 전혀 영향을 받지 않습니다.

여러분의 브라우징 데이터, Cookie 등 모든 브라우저 데이터는 기기에 그대로 남습니다. ego lite의 데이터 수집은 매우 제한적이어서, 여러분이 ego lite를 기본 브라우저로 설정했는지 여부 등 간단한 제품 데이터만 확인합니다.

## ego lite의 주요 기능

| 기능 | 하는 일 |
|---|---|
| **CLI가 아닌 코드 기반으로, 복잡한 작업을 더 적은 토큰으로 더 빠르게 실행** | ego lite가 에이전트에 노출하는 기능은 에이전트가 직접 호출하는 JavaScript 함수로 감싸져 있습니다. 에이전트는 가장 잘하는 일, 즉 코드를 작성해 여러 단계의 작업을 하나의 결과로 묶어냅니다. “명령 두 개 호출하고 결과를 보고, 다시 명령 두 개를 호출하는” 루프에 갇히지 않습니다. 기존 CLI 방식과 비교하면 복잡한 워크플로의 실행 속도가 훨씬 빨라지고, 작업 성공률은 더 높으며 작업당 도구 호출 수는 훨씬 적고, 최종적으로 작업에 드는 비용도 크게 줄어듭니다. |
| **에이전트마다 전용 Space** | ego lite는 각 에이전트에 완전히 격리된 전용 Space를 제공합니다. 여러분은 앞에서 브라우징하고 에이전트는 백그라운드에서 작업하며, 서로 방해하지 않습니다. 어느 Space에서 에이전트가 실행 중인지 언제든 확인할 수 있고, 원할 때 직접 넘겨받거나 중단할 수 있습니다. |
| **같은 브라우저 안의 병렬 작업 공간, Space에서 멀티태스킹하는 에이전트** | Space마다 각자의 AI 에이전트 또는 각자의 작업이 배정되어 모두 동시에 실행됩니다. Claude Code가 10개의 병렬 Space에서 리드 10건을 보강하고, Codex가 5개의 Space에서 경쟁사 사이트 5곳을 스크래핑합니다. 서로 충돌하지도, 여러분의 탭을 가로채지도 않습니다. 마우스는 놓아둔 자리에 그대로 있습니다. |
| **시장에서 가장 강력한 페이지 Snapshot** | 커널 수준의 커스터마이징 덕분에 ego lite는 최고 품질의 페이지 Snapshot을 생성합니다. 이는 텍스트 모델이 웹페이지를 "보고" 동작할 때 의존하는 뷰입니다. 깊게 중첩된 iframe처럼 다른 방식들이 늘 무너지는 까다로운 상황도 안정적으로 처리합니다. |
| **어떤 에이전트든 `ego-browser`를 통해 구동 가능** | `ego-browser`는 어떤 에이전트 CLI(Claude Code, Codex, Cursor 또는 직접 만든 에이전트)와 ego lite 사이를 잇는 연결 계층입니다. 브라우저를 snapshot, fill, click, wait, navigate, capture 같은 인페이지 JavaScript 도구 모음으로 노출합니다. 에이전트가 이 도구들을 호출하는 JavaScript 코드를 작성하면 `ego-browser`가 페이지에서 한 번에 실행합니다. |
| **쓸수록 에이전트가 빨라지는 경험 축적** *(출시 예정)* | 에이전트가 브라우저 작업에 쓰는 시간은 대부분 시행착오에 들어갑니다. ego lite의 공식 Skill은 성공한 모든 동작을 재사용 가능한 도구와 워크플로로 정제해, 앞으로 비슷한 작업을 최대 5배 더 빠르게 실행합니다. |

## ego lite와 기존 제품 비교

대부분의 도구는 브라우저를 자동화할 수 있습니다. 진짜 중요한 질문은 에이전트가 어떤 브라우저를 쓰는지, 그와 동시에 여러분도 계속 작업할 수 있는지, 그리고 그 도구가 이미 쓰고 있는 에이전트를 위한 것인지 자체 내장 에이전트를 위한 것인지입니다.

| 기능 | ego lite | Browser-Use | agent-browser (Vercel) | ChatGPT Atlas | Perplexity Comet |
|---|:---:|:---:|:---:|:---:|:---:|
| 병렬 멀티태스킹 | ✓ | — | — | — | — |
| 재사용 가능한 스킬 | ✓ | — | — | — | — |
| Chrome 데이터를 그대로 사용 | ✓ | — | — | ✓ | ✓ |
| 같은 브라우저, 분리된 작업 공간 | ✓ | — | — | — | — |
| 압축된 시맨틱 입력 | ✓ | — | ✓ | — | — |
| 외부 에이전트가 직접 제어 가능 | ✓ | ✓ | ✓ | — | — |
| 데이터는 로컬에만 저장 | ✓ | ✓ | ✓ | — | — |
| 로그인 마찰 없음 | ✓ | — | — | ✓ | ✓ |
| 매일 쓰는 일상 브라우저 | ✓ | — | — | ✓ | ✓ |
| 무료 | ✓ | ✓ | ✓ | — | — |

같은 문제를 푸는 다른 두 갈래도 있습니다. Browser-Use와 Vercel의 agent-browser 같은 브라우저 자동화 프레임워크는 에이전트가 호출하는 라이브러리로, 자체 브라우저를 제공하지 않습니다. 그래서 구동할 별도 브라우저가 필요하고 로그인 정보도 제대로 넘어가지 않습니다. ChatGPT Atlas, Perplexity Comet 같은 AI 브라우저는 자체 에이전트를 내장하고 있고, 그 에이전트만이 브라우저를 구동할 수 있습니다. ego lite는 여러분과 여러분이 데려온 어떤 에이전트가 함께 쓰도록 처음부터 설계된 하나의 브라우저입니다.


## 벤치마크

네 가지 복잡한 브라우저 자동화 작업에서 ego lite를 Vercel의 agent-browser와 비교 벤치마크했습니다. ego lite는 각 작업을 최대 2.5배 더 빠르게, 토큰은 훨씬 적게 써서 끝냈습니다. 작업이 어려울수록 격차는 더 벌어졌습니다. 비교 결과를 확인해 보세요.

<div align="center">

<img src="docs/assets/ego-vs-agent-benchmark.png" alt="ego lite vs agent-browser, speed and cost across four tasks" width="100%" />

</div>

## 문서

튜토리얼, 전체 도구 레퍼런스, 연동 가이드는 [lite.ego.app/document/](https://lite.ego.app/document/)에서 확인할 수 있습니다.

## 커뮤니티

- [Discord](https://discord.gg/5eGZVvHbTq): 질문, 설치 도움, 스킬 공유
- [GitHub Discussions](https://github.com/citrolabs/ego-lite/discussions): 아이디어와 긴 논의
- [X/Twitter](https://x.com/ego_agent): 업데이트와 릴리스

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

## 라이선스

이 저장소의 내용은 [MIT License](LICENSE)에 따라 공개됩니다. ego lite 브라우저는 별도로 제공되는 무료 다운로드입니다.
