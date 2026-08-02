<div align="center">

<img src="docs/assets/banner.png" alt="ego lite" width="100%" />

**AI エージェントがブラウザ自動化を実行するための最速ブラウザ。**

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

<a href="https://trendshift.io/repositories/42334?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-42334" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/42334" alt="citrolabs%2Fego-lite | Trendshift" width="250" height="55"/></a>

<p>
  <a href="https://cdn.ego.app/channel/github_github_referral/setup/macos/arm64/egolite.dmg"><img src="https://img.shields.io/badge/Download-Apple%20Silicon-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Apple Silicon 版をダウンロード" /></a>
  <a href="https://cdn.ego.app/channel/github_github_referral/setup/macos/x64/egolite.dmg"><img src="https://img.shields.io/badge/Download-Intel-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Intel 版をダウンロード" /></a>
  <a href="https://discord.gg/5eGZVvHbTq"><img src="https://img.shields.io/badge/Discord-Join-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord に参加" /></a>
  <a href="https://x.com/ego_agent"><img src="https://img.shields.io/badge/Follow-%40ego__agent-000000?style=for-the-badge&logo=x&logoColor=white" alt="X で @ego_agent をフォロー" /></a>
  <a href="https://lite.ego.app/document/"><img src="https://img.shields.io/badge/Docs-lite.ego.app-1E90FF?style=for-the-badge&logo=gitbook&logoColor=white" alt="ドキュメント" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-3DA639?style=for-the-badge" alt="MIT ライセンス" /></a>
</p>

</div>

ego (lite) は、あなたと AI エージェントが並行して作業できるブラウザです。エージェントはそれぞれ専用の Space で複数のブラウザタスクを実行し、あなたは自分のタブをそのまま使い続けられます。さらに、タスクをより少ないトークンで、より速く完了できます。

browser-use や agent-browser などの既存ツールはブラウザ自動化フレームワークです。操作対象となる別のブラウザが必要で、ログイン状態をうまく引き継げず、あなたとエージェントが同じタブを取り合うことになります。ego lite は、最初から両者で共有するために設計された一つのブラウザです。追加設定は不要で、エージェントは `ego-browser` を通じて、実際のログイン状態やタブにいつでもアクセスできます。

## デモ

https://github.com/user-attachments/assets/ffe7954b-58ee-411e-b35d-ec30c58a08bc

## クイックスタート

現在、ego lite は macOS で動作します。Windows と Linux は[ロードマップ](https://lite.ego.app/roadmap)に含まれています。

### 1. インストール

自分の使い方に合う方法を選んでください。

**1.1 macOS アプリをダウンロード**

<a href="https://cdn.ego.app/channel/github_github_referral/setup/macos/arm64/egolite.dmg"><img src="https://img.shields.io/badge/⬇%20Apple%20Silicon-.dmg-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Apple Silicon 用 ego lite をダウンロード" /></a>
<a href="https://cdn.ego.app/channel/github_github_referral/setup/macos/x64/egolite.dmg"><img src="https://img.shields.io/badge/⬇%20Intel-.dmg-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Intel 用 ego lite をダウンロード" /></a>

クリックしてダウンロードし、ファイルを開いてインストールします。どの方法を選んでも、ego lite はマシン上にあるすべてのエージェントのスキルディレクトリへ `ego-browser` スキルを追加します。

**1.2 npx でスキルを追加**

`ego-browser` スキルだけをインストールします。

```bash
npx skills add citrolabs/ego-lite
```

エージェントが初めてブラウザタスクを実行するときに、ego lite アプリのインストール手順を案内します。

**1.3 エージェントにセットアップを任せる**

次の内容をエージェントに貼り付けます。

```
Set up ego lite for me: https://github.com/citrolabs/ego-lite

Read `skills/ego-browser/references/install.md` and follow the steps to install ego lite.
```

初回起動時に、ego lite は Chrome データを移行するかどうかを一度だけ確認します。「はい」を選ぶと、エージェントが既存のログイン状態、Cookie、拡張機能、ブックマークを引き継ぎます。

### 2. 最初のタスクを実行

エージェントの CLI で `/ego-browser` と入力し、空白に続けて実行したい内容を自然言語で記述します。

```
ego-browser follow @ego_agent on x.com for me
```

エージェントは `ego-browser` スキルを読み込み、自分専用の Space でページを開き、Snapshot を読み、ページを操作して結果を報告します。その間も、あなた自身のタブには一切影響しません。

閲覧データは端末内に保存されます。ego lite が記録するのは、セットアップ時に Chrome の移行を選択したかどうかだけです。

## ego lite の特長

| 機能 | 内容 |
|---|---|
| **CLI ではなくコードを基盤にして、複雑なタスクを少ないトークンで高速実行** | ego lite がエージェントに公開する機能は、直接呼び出せる JavaScript 関数としてラップされています。これによりエージェントは、得意とするコード記述を活かし、複数の手順を一度の実行にまとめられます。「コマンドを二つ呼び出して結果を確認し、また二つ呼び出す」というループにはまりません。従来の CLI 方式と比べて、複雑なワークフローを最大 2.5 倍速く完了でき、タスク成功率も高まり、ツール呼び出し回数も大幅に減ります。 |
| **すべてのエージェントに専用 Space** | ego lite は各エージェントに完全に分離された専用 Space を提供します。あなたが手前でブラウジングしている間、エージェントはバックグラウンドで作業し、互いに邪魔をしません。どの Space でエージェントが動いているかをいつでも確認し、必要に応じて操作を引き継いだり停止したりできます。 |
| **同じブラウザ内の並列ワークスペースである Space を使って、エージェントがマルチタスクを実行** | 各 Space には一つの AI エージェントまたは一つのタスクを割り当て、すべてを同時に実行できます。たとえば Claude Code が 10 個の Space で 10 件の見込み顧客情報を充実させ、Codex がさらに 5 個の Space で 5 件の競合サイトを収集できます。互いに衝突したり、あなたのタブを奪ったりせず、マウスも元の位置に留まります。 |
| **市場最高水準のページ Snapshot** | カーネルレベルのカスタマイズにより、ego lite はモデルがウェブページを「見て」操作するために使う高品質なページスナップショットを生成します。他の方式が失敗しやすい、深くネストされた iframe のような難しいケースも確実に処理できます。 |
| **どのエージェントからでも `ego-browser` を介して操作可能** | `ego-browser` は、任意のエージェント CLI（Claude Code、Codex、Cursor、独自エージェント）と ego lite をつなぐレイヤーです。ブラウザをページ内 JavaScript ツールのセットとして公開します。利用できるのは snapshot、fill、click、wait、navigate、capture です。エージェントがこれらのツールを呼び出す JavaScript スニペットを作成し、`ego-browser` がページ上で一度に実行します。 |
| **経験を蓄積し、使うほどエージェントを高速化** *（近日提供予定）* | エージェントがブラウザタスクに費やす時間の大部分は試行錯誤です。ego lite の公式 Skill は成功した各操作を再利用可能なツールとワークフローへ抽出するため、将来同様のタスクを最大 5 倍速く実行できます。 |

## ego lite と既存製品の比較

ほとんどのツールでブラウザ自動化はできます。本当に重要なのは、エージェントがどのブラウザを使うのか、あなたが同時に作業を続けられるのか、そしてそのツールが既に使っているエージェント向けに作られているのか、それとも内蔵エージェント専用なのかという点です。

| 機能 | ego lite | Browser-Use | agent-browser (Vercel) | ChatGPT Atlas | Perplexity Comet |
|---|:---:|:---:|:---:|:---:|:---:|
| 並行してマルチタスクを実行 | ✓ | — | — | — | — |
| 再利用可能なスキル | ✓ | — | — | — | — |
| Chrome のデータを継承 | ✓ | — | — | ✓ | ✓ |
| 同じブラウザ内の独立したワークスペース | ✓ | — | — | — | — |
| 圧縮されたセマンティック入力 | ✓ | — | ✓ | — | — |
| 外部エージェントから制御可能 | ✓ | ✓ | ✓ | — | — |
| データをローカルに保存 | ✓ | ✓ | ✓ | — | — |
| ログイン時の手間なし | ✓ | — | — | ✓ | ✓ |
| 日常用ブラウザとして使用可能 | ✓ | — | — | ✓ | ✓ |
| 無料 | ✓ | ✓ | ✓ | — | — |

同じ問題を解決しようとする製品には、ほかに二つの分類があります。Browser-Use や Vercel の agent-browser のようなブラウザ自動化フレームワークは、エージェントが呼び出すライブラリです。独自のブラウザを提供しないため、別のブラウザを操作する必要があり、ログイン状態もうまく引き継げません。ChatGPT Atlas や Perplexity Comet のような AI ブラウザはエージェントを内蔵していますが、そのエージェントしかブラウザを操作できません。ego lite は、あなたと持ち込んだ任意のエージェントが共有できるよう、最初から設計された一つのブラウザです。

## ベンチマーク

四つの複雑なブラウザ自動化タスクで、ego lite と Vercel の agent-browser を比較しました。ego lite はすべてのタスクを最大 2.5 倍速く完了し、使用するトークンも大幅に少なくなりました。タスクが難しいほど差は大きくなります。比較結果をご覧ください。

<div align="center">

<img src="docs/assets/ego-vs-agent-benchmark.png" alt="四つのタスクにおける ego lite と agent-browser の速度およびコスト比較" width="100%" />

</div>

## ドキュメント

チュートリアル、完全なツールリファレンス、統合ガイドは [lite.ego.app/document/](https://lite.ego.app/document/) にあります。

## コミュニティ

- [Discord](https://discord.gg/5eGZVvHbTq)：質問、セットアップの支援、スキルの共有
- [GitHub Discussions](https://github.com/citrolabs/ego-lite/discussions)：アイデアや詳しい議論
- [X/Twitter](https://x.com/ego_agent)：最新情報とリリース

## Star の推移

<a href="https://www.star-history.com/?repos=citrolabs%2Fego-lite&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=citrolabs/ego-lite&type=date&theme=dark&legend=top-left&sealed_token=REc3U13uyXA_SL88c2BU0N5DOPw40Uiufp-RaA8pQS-JIMVaaxcGBjHmFV3Vwn9GMMIiL5e40DXSqHNcDjtXItvqvpMr013AaU6OkphU5o60GjasXVoXTQRR4TkWQSCPrPIxmKHehNll1TAsdoQ8rD3wPyRaj-Z_iHXqDDWf9b0gSWHxkyYoMUj6yWxY" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=citrolabs/ego-lite&type=date&legend=top-left&sealed_token=REc3U13uyXA_SL88c2BU0N5DOPw40Uiufp-RaA8pQS-JIMVaaxcGBjHmFV3Vwn9GMMIiL5e40DXSqHNcDjtXItvqvpMr013AaU6OkphU5o60GjasXVoXTQRR4TkWQSCPrPIxmKHehNll1TAsdoQ8rD3wPyRaj-Z_iHXqDDWf9b0gSWHxkyYoMUj6yWxY" />
   <img alt="Star の推移グラフ" src="https://api.star-history.com/chart?repos=citrolabs/ego-lite&type=date&legend=top-left&sealed_token=REc3U13uyXA_SL88c2BU0N5DOPw40Uiufp-RaA8pQS-JIMVaaxcGBjHmFV3Vwn9GMMIiL5e40DXSqHNcDjtXItvqvpMr013AaU6OkphU5o60GjasXVoXTQRR4TkWQSCPrPIxmKHehNll1TAsdoQ8rD3wPyRaj-Z_iHXqDDWf9b0gSWHxkyYoMUj6yWxY" />
 </picture>
</a>

## ライセンス

このリポジトリの内容は [MIT ライセンス](LICENSE)で公開されています。ego lite ブラウザは、別途無料でダウンロードできます。
