# ego agent plugin

Package the same `ego-browser` Skill for ten agent hosts. Each distribution
contains only its host entry points, a complete copy of the canonical Skill,
and installation instructions for that host.

## Requirements

- macOS or Windows with ego lite installed and open
- `ego-browser` available on the agent's `PATH`
- An agent host that can read Skills and execute local shell commands

## Packaging

From the repository root, build all ten artifacts with one command:

```bash
npm --prefix plugins/ego run package
```

The output directory is `dist/plugins/ego-v2.2.0/`:

| Host             | Artifact                          | Contents                                           |
| ---------------- | --------------------------------- | -------------------------------------------------- |
| Claude Code      | `ego-claude-code-v2.2.0.zip`      | Claude plugin                                      |
| Codex            | `ego-codex-v2.2.0.zip`            | Codex plugin at the archive root, plus marketplace |
| Cursor           | `ego-cursor-v2.2.0.zip`           | Cursor plugin                                      |
| GitHub Copilot   | `ego-github-copilot-v2.2.0.zip`   | Agent Plugins plugin, plus marketplace             |
| Grok Build       | `ego-grok-build-v2.2.0.zip`       | Agent Plugins and Claude-compatible manifests      |
| WorkBuddy        | `ego-workbuddy-v2.2.0.zip`        | Local marketplace and CodeBuddy manifest           |
| QwenWork Desktop | `ego-qwenwork-v2.2.0.zip`         | Claude-compatible expert kit                       |
| OpenCode         | `ego-opencode-v2.2.0.tgz`         | `@ego-lite/opencode-plugin` npm package            |
| DeepSeek Harness | `ego-deepseek-harness-v2.2.0.tgz` | `@ego-lite/dsh-plugin` npm bundle                  |
| Pi               | `ego-pi-v2.2.0.tgz`               | `@ego-lite/pi-plugin` Pi package                   |

Every ZIP includes a host-specific `README.md` at its root; npm archives include
it under `package/`. The WorkBuddy ZIP contains a marketplace root with the
plugin under `plugins/ego/`. Other ZIPs start directly at the plugin root. The
Codex ZIP starts there too and carries its marketplace file alongside, because
the public plugin directory rejects an archive whose manifest is not at the
root. The GitHub Copilot ZIP carries its marketplace file the same way, because
Copilot CLI deprecates installing a plugin directly from a local path.

The three npm packages have separate names and exports so their adapters cannot
be confused by package caches. They are versioned apart from the plugin:
`npmVersion` in `package.json` sets their version, while the archive names and
the Pi gallery image follow the plugin version. All ten packages contain real Skill files;
none depends on the source checkout.

Every host that reads a plugin logo uses the Skill's
`assets/logo.png`: Codex `interface.logo`, Claude Code `icon`, Cursor `logo`,
and the Pi gallery `pi.image`, which points at the file under the release tag.
The Codex composer icon is the same mark at 256 px.

Override the output parent directory, or package all plugin directories:

```bash
npm --prefix plugins/ego run package -- --output /absolute/path/to/artifacts
node plugins/scripts/package-plugins.mjs --all
```

Each plugin gets its own `<name>-v<version>/` directory. Rebuilding replaces the
ten named artifacts only after all ten have been built. A build failure leaves
previous artifacts intact. Older universal ZIP/npm outputs outside the version
directory are left untouched and are no longer generated.

Packaging requires Node.js, npm, `zip`, and `unzip`. Run this command instead of
`npm pack` in the source directory: the source package mixes every host's entry
points, while each npm artifact carries only its own.

## Repository distribution

`plugins/ego` is a complete plugin directory: its `skills/ego-browser` holds real
files, not a link. Hosts and plugin directories that read a plugin straight
from Git can therefore use this repository, with `plugins/ego` as the plugin
path. The repository root carries the marketplace files that point there:

| File                               | Read by                                    |
| ---------------------------------- | ------------------------------------------ |
| `.claude-plugin/marketplace.json`  | Claude Code, GitHub Copilot CLI, WorkBuddy |
| `.agents/plugins/marketplace.json` | Codex                                      |
| `.cursor-plugin/marketplace.json`  | Cursor                                     |

Directory submissions that take a repository instead of an archive, such as the
Claude plugin directory, awesome-copilot, the Cursor Marketplace, and the Grok
plugin marketplace, use the same plugin path.

## Installation

Choose the artifact for the host. Extract ZIPs into a persistent local directory
unless the host accepts ZIP upload. The paths below are placeholders for that
directory or the downloaded npm archive. Each packaged README repeats only the
matching section and the requirements above.

### Claude Code

Extract the Claude Code ZIP, then load its plugin directory for a session:

```bash
claude --plugin-dir /absolute/path/to/ego-claude-code
```

Use `/ego:ego-browser`. This flag loads the plugin for that session. Persistent
installation uses a plugin marketplace. The repository marketplace exposes
`ego@ego-agent-skills` at the version on its default branch:

```bash
claude plugin marketplace add citrolabs/ego-lite
claude plugin install ego@ego-agent-skills
```

See the [Claude Code plugin reference](https://code.claude.com/docs/en/plugins-reference).

### Codex

The Codex ZIP serves both install routes. `.codex-plugin/plugin.json` and
`skills/` sit at the archive root, and `.agents/plugins/marketplace.json`
points at that same root with `"path": "./"`.

To install locally, extract the ZIP and add the extracted directory:

```bash
codex plugin marketplace add /absolute/path/to/ego-codex
codex plugin add ego@ego-codex-local
```

Restart Codex if the plugin does not appear, then ask it to use `$ego-browser`.
Remove the installed plugin with `codex plugin remove ego@ego-codex-local`.

The repository is a Codex marketplace too, at the version on its default
branch:

```bash
codex plugin marketplace add citrolabs/ego-lite
codex plugin add ego@ego-agent-skills
```

To publish, upload the same ZIP as a skills-only plugin in the submission
portal and select the verified developer identity that matches `author.name`.
The listing copy comes from the manifest's `interface` object, whose `category`
must be one of the values the portal accepts. The portal also blocks the
upload until `interface` declares `websiteURL`, `supportURL`,
`privacyPolicyURL`, and `termsOfServiceURL`. Keep `extensions.com.openai` out
of the root `plugin.json`: once it is present, OpenAI ignores the whole
`.codex-plugin/plugin.json` listing instead of merging the two. See
[Submit plugins](https://developers.openai.com/plugins/deploy/submission) and
the [submission error reference](https://developers.openai.com/plugins/deploy/submission-errors).

See the [OpenAI plugin guide](https://developers.openai.com/plugins/build/plugins).

### Cursor

Extract the Cursor ZIP and load it for a Cursor CLI session:

```bash
agent --plugin-dir /absolute/path/to/ego-cursor
```

`cursor-agent` is the legacy name of the `agent` command. To load the plugin in
Cursor Desktop, extract the ZIP to `~/.cursor/plugins/local/ego`, then run
**Developer: Reload Window**.

The package declares its Skill, logo, category, and tags through
`.cursor-plugin/plugin.json`. Use `/ego-browser` in the session. The Cursor
Marketplace takes submissions as public Git repositories, not ZIP uploads.

See the [Cursor plugin guide](https://cursor.com/docs/plugins).

### GitHub Copilot

Extract the GitHub Copilot ZIP into a persistent directory. Copilot reads its
root `plugin.json`, an Agent Plugins 1.0 manifest, and
`.github/plugin/marketplace.json` lists the plugin at the archive root. Install
it with Copilot CLI:

```bash
copilot plugin marketplace add /absolute/path/to/ego-github-copilot
copilot plugin install ego@ego-github-copilot-local
```

To load it for one session instead, run
`copilot --plugin-dir /absolute/path/to/ego-github-copilot`. Use `/ego-browser`,
and confirm that `copilot skill list` shows `ego-browser` under **Plugin
skills**. Copilot CLI deprecates `copilot plugin install` from a local path, so
use the marketplace route for a persistent install.

See the [GitHub Copilot plugin guide](https://docs.github.com/en/copilot/concepts/agents/about-plugins).

### Grok Build

Extract the Grok Build ZIP, check it, then install the local directory:

```bash
grok plugin validate /absolute/path/to/ego-grok-build
grok plugin install /absolute/path/to/ego-grok-build --trust
```

Without `--trust`, `grok plugin install` exits and tells you to re-run it with
`--trust`. Use `/ego-browser`. Remove it with `grok plugin uninstall ego`.

Grok Build reads the Agent Plugins `plugin.json` first. The package also
carries `.claude-plugin/plugin.json`, because the Grok plugin marketplace
catalog reads only branded manifests.

### WorkBuddy

The WorkBuddy ZIP is a marketplace root. It contains
`.codebuddy-plugin/marketplace.json` and `plugins/ego/` with
`.codebuddy-plugin/plugin.json`, the manifest WorkBuddy reads first.

Extract the ZIP into a persistent directory. In **添加市场**, enter the absolute
path of the extracted root, select **ego-workbuddy-local**, install **ego**,
then start a new task and ask it to use the ego-browser Skill. A directory
marketplace runs the plugin from that directory, so keep it in place. The
bundled CodeBuddy CLI also accepts the ZIP path itself as a marketplace and
copies the plugin into its cache.

The repository is a marketplace too: add `citrolabs/ego-lite` and install
`ego@ego-agent-skills`, which tracks the version on its default branch.

See the [CodeBuddy plugin marketplace guide](https://www.codebuddy.cn/docs/cli/plugin-marketplaces).

### QwenWork Desktop

Upload the QwenWork ZIP directly through **扩展 → 专家套件 → + 添加 → 上传套件**,
then click **安装**. Start a new task and ask it to use ego-browser.

This package uses `.claude-plugin/plugin.json`, an explicitly supported expert
kit format. QwenWork was formed from QoderWork, MuleRun, and Wukong; the
source `.qoder-plugin/plugin.json` manifest from QoderWork is not used for this
artifact. See the [QwenWork expert-kit guide](https://qwenwork.cn/docs/desktop/expert-kits).

### OpenCode

The package works with OpenCode 1 and OpenCode 2, which ships as
`@opencode/cli`. Run `opencode --version` to see which one is installed; the
two install plugins differently.

On OpenCode 1, install the package by name:

```bash
opencode plugin @ego-lite/opencode-plugin -g
```

To remove the plugin, delete its entry from the `plugin` array of the
applicable `opencode.json` or `opencode.jsonc`.

On OpenCode 2, `opencode plugin add` accepts only npm and Git packages:

```bash
opencode plugin add @ego-lite/opencode-plugin
```

Remove it with `opencode plugin remove @ego-lite/opencode-plugin`.

To try a local npm archive instead, extract it into a persistent directory and
keep it in place; OpenCode does not install the `.tgz` itself:

```bash
mkdir -p /absolute/path/to/ego-opencode
tar -xzf /absolute/path/to/ego-opencode-v2.2.0.tgz -C /absolute/path/to/ego-opencode
opencode plugin /absolute/path/to/ego-opencode/package -g
```

The last command registers it on OpenCode 1. On OpenCode 2, add the absolute
path of the extracted `package` directory to the `plugins` array of
`opencode.json` in the folder that `opencode debug paths config` prints.

The package is named `@ego-lite/opencode-plugin`. Its `.` and `./server` exports
load `index.js`, whose default export serves both versions. OpenCode 1 calls
`server()`, which adds the packaged `skills/` directory to its Skill paths and
offers ego-browser as the `/ego-browser` command. OpenCode 2 calls `setup()`,
which adds the packaged ego-browser Skill.

See the plugin guides for [OpenCode 1](https://opencode.ai/docs/plugins/) and
[OpenCode 2](https://opencode.ai/v2/docs/build/plugins/).

### DeepSeek Harness

Add the package to the desired profile by name:

```bash
dsh plugin --profile web add @ego-lite/dsh-plugin
dsh --profile web --dump-config
dsh --profile web
```

Only a package added by name receives update notices. To try a local npm
archive instead, add its path; DSH copies the archive into the profile:

```bash
dsh plugin --profile web add /absolute/path/to/ego-deepseek-harness-v2.2.0.tgz
```

The bundle declares `engines.dsh` as `>=0.2.0`, and DSH refuses it on earlier
versions.

The package is named `@ego-lite/dsh-plugin`. Its bundle patch loads
`@ego-lite/dsh-plugin/dsh` and registers the packaged Skill. Use
`/ego-browser`. Remove it with
`dsh plugin --profile web remove @ego-lite/dsh-plugin`.

See the [DeepSeek Harness local package guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md).

### Pi

Install the npm package, or a local npm archive:

```bash
pi install npm:@ego-lite/pi-plugin
pi install "npm:@ego-lite/pi-plugin@file:/absolute/path/to/ego-pi-v2.2.0.tgz"
```

Pass the archive through the `npm:` source: a bare `.tgz` path installs without
loading any Skill. Use `/skill:ego-browser`. Remove it with
`pi remove npm:@ego-lite/pi-plugin`.

The package declares the `pi-package` keyword, which makes a published package
eligible for the [Pi package gallery](https://pi.dev/packages), and `pi.image`
for its gallery preview.

See the [Pi packages guide](https://pi.dev/docs/latest/packages).

## Verification

Packaging tests check all ten payloads, marketplace paths, canonical Skill
contents, source symlink preservation, repeat builds, and failed-batch handling.
They load the OpenCode and DeepSeek Harness adapters after extraction outside
the repository. These checks do not establish end-to-end compatibility in all
ten host applications.

After installation, confirm that the host discovers ego-browser and can run:

```bash
ego-browser nodejs <<'EOF'
console.log('ego-browser ready')
EOF
```

## Development

`skills/ego-browser` here is a copy of the canonical `skills/ego-browser` at the
repository root, the thin entry Skill. The usage guide it points to lives in
`package/ego-browser/skill-body/SKILL.md` and ships with ego lite. Edit only
the canonical Skill. When a commit stages changes under `skills/ego-browser/`,
the commit hook refreshes the copy from the staged Skill and stages it too, so
unstaged edits and untracked drafts never reach the copy. Without the hook,
refresh the copy yourself:

```bash
npm --prefix plugins/ego run sync-skills
```

The plugin tests compare the copy with the canonical Skill in the Git index and
fail while they differ, so CI catches a commit that skipped the hook. The
packager builds every artifact from the canonical Skill, and unexpected or
broken links fail packaging.

Plugin tests belong in `plugins/ego/tests/` and run independently of browser
runtime tests:

```bash
npm --prefix plugins/ego test
```

CI and the commit hook run this suite for plugin changes.
