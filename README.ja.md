<div align="center">

<img src="docs/assets/banner.png" alt="ego lite" width="100%" />

**AI エージェントがブラウザ自動化を実行するための最速ブラウザ**

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
  <b>日本語</b> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.pt.md">Português (BR)</a> ·
  <a href="README.es.md">Español (LatAm)</a>
</p>

</div>

ego (lite) は、あなたと AI エージェントが並行して作業するブラウザです。エージェントはそれぞれの Space で複数のブラウザタスクを実行し、あなたのタブはあなたのまま。タスクはより速く、より少ないトークンで完了します。

browser-use や agent-browser などの既存ツールはブラウザ自動化フレームワークです。操作するには別のブラウザが必要で、ログイン状態をそのまま引き継ぐことも難しく、あなたとエージェントが同じタブを取り合うことになります。ego lite は、最初からあなたとエージェントの 2 者が共有して使うために設計された 1 つのブラウザです。追加のセットアップは不要で、エージェントは `ego-browser` を通じて、実際にログインしているアカウントやタブにいつでもアクセスできます。

## デモ

https://github.com/user-attachments/assets/ffe7954b-58ee-411e-b35d-ec30c58a08bc

## クイックスタート

ego lite は現在 macOS で動作します。Windows と Linux は[ロードマップ](https://lite.ego.app/roadmap)にあります。

### 1. インストール

自分の進め方に合う方法を選んでください。

**1.1 macOS アプリをダウンロードする**

<a href="https://cdn.ego.app/setup/macos/arm64/egolite-Y7MbxKIuhzFB.dmg"><img src="https://img.shields.io/badge/⬇%20Apple%20Silicon-.dmg-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download ego lite for Apple Silicon" /></a>
<a href="https://cdn.ego.app/setup/macos/x64/egolite-Y7MbxKIuhzFB.dmg"><img src="https://img.shields.io/badge/⬇%20Intel-.dmg-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download ego lite for Intel" /></a>

クリックしてダウンロードし、開いてインストールします。どちらの方法でも、ego lite はマシン上のすべてのエージェントの Skill ディレクトリに `ego-browser` Skill を追加します。

**1.2 npx で Skill を追加する**

`ego-browser` Skill だけをインストールする場合：

```bash
npx skills add citrolabs/ego-lite
```

エージェントが初めてブラウザタスクを実行するとき、ego lite アプリのインストールを案内します。

**1.3 エージェントにセットアップさせる**

エージェントに以下を貼り付けてください：

```
ego lite をセットアップしてください：https://github.com/citrolabs/ego-lite

`skills/ego-browser/references/install.md` を読み、手順に従って ego lite をインストールしてください。
```

初回起動時、ego lite が尋ねるのは 1 つだけ、Chrome のデータを移行するかどうかです。「はい」と答えれば、エージェントは既存のログイン情報、Cookie、拡張機能、ブックマークをそのまま引き継ぎます。

### 2. 最初のタスクを実行する

エージェントの CLI で `/ego-browser` と入力し、スペースを空けてから、やりたいことを普通の言葉で伝えます：

```
ego-browser で x.com の @ego_agent をフォローして
```

エージェントは `ego-browser` Skill を読み込み、自分の Space でページを開き、Snapshot を読み取り、ページ上で操作し、結果を報告します。その間、あなたのタブは一切触られません。

閲覧データはお使いのデバイスに残ります。ego lite が記録するのは、セットアップ時に Chrome のデータ移行を選んだかどうかだけです。

## ego lite の特長

| 機能 | できること |
|---|---|
| **CLI ベースではなくコードベース。複雑なタスクをより速く、より少ないトークンで** | ego lite がエージェントに公開する機能は、エージェントが直接呼び出す JavaScript 関数としてラップされています。エージェントは得意なこと、つまりコードを書くことに専念できます。多段階のタスクを 1 回の出力にまとめられるので、「コマンドを 2 つ呼び出し、結果を見て、また 2 つ呼び出す」というループにはまりません。従来の CLI 方式と比べて、複雑なワークフローは最大 2.5× 高速に完了し、タスク成功率も高く、タスクあたりのツール呼び出し回数もはるかに少なくて済みます。 |
| **エージェントごとに専用の Space** | ego lite は各エージェントに、完全に独立した Space を用意します。あなたは前面でブラウジングし、エージェントはバックグラウンドで作業する。互いに邪魔し合うことはありません。どの Space でエージェントが動いているかはいつでも確認でき、好きなタイミングで引き継いだり停止したりできます。 |
| **エージェントは Spaces でマルチタスク。同じブラウザ内にある並列ワークスペース** | 各 Space にはそれぞれの AI エージェント、またはそれぞれのタスクが割り当てられ、すべてが同時に動きます。Claude Code が 10 件のリードを 10 個の並列 Space で強化する。Codex が 5 つの競合サイトをさらに 5 つの Space でスクレイピングする。互いに衝突することも、あなたのタブを奪うこともありません。マウスカーソルも置いた場所のままです。 |
| **市場で最も強力なページ Snapshot** | カーネルレベルのカスタマイズにより、ego lite は最高品質のページ Snapshot を生成します。これはテキストモデルが Web ページを「見て」操作するために頼るビューです。深くネストした iframe のような難所——ほかの手法が必ずと言っていいほど破綻する場面——も確実に処理します。 |
| **どのエージェントからでも `ego-browser` 経由で操作できる** | `ego-browser` は、あらゆるエージェント CLI（Claude Code、Codex、Cursor、あるいは自作のもの）と ego lite をつなぐ接続層です。ブラウザの機能を、snapshot・fill・click・wait・navigate・capture といったページ内 JavaScript ツール群として提供します。エージェントがこれらのツールを呼び出す JavaScript スニペットを書くと、`ego-browser` がそれをページ上で一度に実行します。 |
| **使うほどエージェントが速くなる経験の蓄積** *(近日公開)* | エージェントがブラウザタスクに費やす時間の大半は、試行錯誤に消えています。ego lite 公式の Skill は、成功した操作をすべて再利用可能なツールとワークフローに落とし込み、以降の似たタスクを最大 5x 高速に実行できるようにします。 |

## ego lite と既存プロダクトの比較

ほとんどのツールはブラウザを自動化できます。本当に問われるのは、エージェントがどのブラウザを使うのか、あなたが同時に作業を続けられるのか、そしてそのツールがあなたがすでに使っているエージェント向けなのか、内蔵エージェント向けなのかという点です。

| 機能 | ego lite | Browser-Use | agent-browser (Vercel) | ChatGPT Atlas | Perplexity Comet |
|---|:---:|:---:|:---:|:---:|:---:|
| 並列マルチタスク | ✓ | — | — | — | — |
| 再利用可能なスキル | ✓ | — | — | — | — |
| Chrome のデータを引き継ぐ | ✓ | — | — | ✓ | ✓ |
| 同じブラウザ、独立したワークスペース | ✓ | — | — | — | — |
| 圧縮されたセマンティック入力 | ✓ | — | ✓ | — | — |
| 外部エージェントから制御可能 | ✓ | ✓ | ✓ | — | — |
| データはローカルに保存 | ✓ | ✓ | ✓ | — | — |
| ログインの手間がない | ✓ | — | — | ✓ | ✓ |
| 日常使いのブラウザ | ✓ | — | — | ✓ | ✓ |
| 無料 | ✓ | ✓ | ✓ | — | — |

同じ課題に取り組むカテゴリは、ほかにも 2 つあります。Browser-Use や Vercel の agent-browser のようなブラウザ自動化フレームワークは、エージェントが呼び出すライブラリであり、ブラウザ自体は付属しません。そのため操作するには別のブラウザが必要で、あなたのログイン状態がそのまま引き継がれることはほとんどありません。ChatGPT Atlas や Perplexity Comet のような AI ブラウザは内蔵エージェントを備えており、そのエージェントしかブラウザを操作できません。ego lite は 1 つのブラウザであり、最初からあなたと、あなたが持ち込む任意のエージェントが共有するために設計されています。


## ベンチマーク

Vercel の agent-browser を相手に、4 つの複雑なブラウザ自動化タスクで ego lite をベンチマークしました。ego lite はどのタスクも最大 2.5× 高速に、しかもトークン消費を大幅に抑えて完了しました。タスクが難しいほど、差は広がります。比較結果をご覧ください。

<div align="center">

<img src="docs/assets/ego-vs-agent-benchmark.png" alt="ego lite vs agent-browser, speed and cost across four tasks" width="100%" />

</div>

## ドキュメント

チュートリアル、ツールの完全なリファレンス、連携ガイドは [lite.ego.app/document/](https://lite.ego.app/document/) にあります。

## コミュニティ

- [Discord](https://discord.gg/5eGZVvHbTq)：質問、セットアップの相談、スキルの共有
- [GitHub Discussions](https://github.com/citrolabs/ego-lite/discussions)：アイデアやじっくり議論したいスレッド
- [X/Twitter](https://x.com/ego_agent)：最新情報とリリース

## スター履歴

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

## ライセンス

このリポジトリの内容は [MIT License](LICENSE) の下で公開されています。ego lite ブラウザ本体は、別途無料でダウンロードできるソフトウェアです。
