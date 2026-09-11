# ego agent plugin

Package the same `ego-browser` Skill for nine agent hosts. Each distribution
contains only its host entry points, a complete copy of the canonical Skill,
and installation instructions for that host.

## Requirements

- macOS with ego lite installed and open
- `ego-browser` available on the agent's `PATH`
- An agent host that can read Skills and execute local shell commands

## Packaging

From the repository root, build all nine artifacts with one command:

```bash
npm --prefix plugins/ego run package
```

The output directory is `dist/plugins/ego-v2.0.0/`:

| Host             | Artifact                          | Contents                                            |
| ---------------- | --------------------------------- | --------------------------------------------------- |
| Claude Code      | `ego-claude-code-v2.0.0.zip`      | Claude plugin                                       |
| Codex            | `ego-codex-v2.0.0.zip`            | Local marketplace and Codex plugin                  |
| Cursor           | `ego-cursor-v2.0.0.zip`           | Cursor plugin                                       |
| GitHub Copilot   | `ego-github-copilot-v2.0.0.zip`   | Claude-compatible plugin                            |
| Grok Build       | `ego-grok-build-v2.0.0.zip`       | Agent Plugins manifest and Skill                    |
| WorkBuddy        | `ego-workbuddy-v2.0.0.zip`        | Local marketplace and WorkBuddy/CodeBuddy manifests |
| QwenWork Desktop | `ego-qwenwork-v2.0.0.zip`         | Claude-compatible expert kit                        |
| OpenCode         | `ego-opencode-v2.0.0.tgz`         | `@citrolabs/ego-opencode` npm package               |
| DeepSeek Harness | `ego-deepseek-harness-v2.0.0.tgz` | `@citrolabs/ego-deepseek-harness` npm bundle        |

Every ZIP includes a host-specific `README.md` at its root; npm archives include
it under `package/`. Codex and WorkBuddy ZIPs contain a marketplace root with the
plugin under `plugins/ego/`. Other ZIPs start directly at the plugin root.

The two npm packages have separate names and exports so their adapters cannot
be confused by package caches. All nine packages contain real Skill files;
none depends on the source checkout or its symlink.

Override the output parent directory, or package all plugin directories:

```bash
npm --prefix plugins/ego run package -- --output /absolute/path/to/artifacts
node plugins/scripts/package-plugins.mjs --all
```

Each plugin gets its own `<name>-v<version>/` directory. Rebuilding replaces the
nine named artifacts only after all nine have been built. A build failure leaves
previous artifacts intact. Older universal ZIP/npm outputs outside the version
directory are left untouched and are no longer generated.

Packaging requires Node.js, npm, `zip`, and `unzip`. Run this command instead of
`npm pack` in the source directory: npm omits the linked Skill when packing the
source directly.

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
installation uses a plugin marketplace; the repository marketplace exposes
`ego@ego-agent-skills` when that source version is available.

See the [Claude Code plugin reference](https://code.claude.com/docs/en/plugins-reference).

### Codex

Extract the Codex ZIP, keeping `.agents/plugins/marketplace.json` and
`plugins/ego/` together. Add the extracted marketplace root:

```bash
codex plugin marketplace add /absolute/path/to/ego-codex
codex plugin add ego@ego-codex-local
```

Restart Codex if the plugin does not appear, then ask it to use `$ego-browser`.
The contained plugin uses `.codex-plugin/plugin.json`. Remove the installed
plugin with `codex plugin remove ego@ego-codex-local`.

See the [OpenAI plugin guide](https://developers.openai.com/plugins/build/plugins).

### Cursor

Extract the Cursor ZIP and load it with Cursor CLI:

```bash
cursor-agent --plugin-dir /absolute/path/to/ego-cursor
```

The package declares its Skill through `.cursor-plugin/plugin.json`. Use
`/ego-browser` in the session. This command does not install a Cursor Desktop
marketplace entry.

### GitHub Copilot

Extract the GitHub Copilot ZIP and load it with Copilot CLI:

```bash
copilot --plugin-dir /absolute/path/to/ego-github-copilot
```

Use `/ego-browser`. This local session uses the packaged Claude-compatible
manifest. VS Code marketplace installation is a separate host workflow.

Check the Skill's source when a personal `ego-browser` Skill is already
installed. In the tested Copilot CLI, the personal copy takes precedence over
the plugin copy, and a disabled personal copy prevents the plugin Skill from
being invoked. Resolve that duplicate and enable the plugin Skill before use.

See the [GitHub Copilot plugin guide](https://docs.github.com/en/copilot/concepts/agents/about-plugins).

### Grok Build

Extract the Grok Build ZIP, then install the local directory:

```bash
grok plugin install /absolute/path/to/ego-grok-build
```

Use `/ego-browser`. The package contains the Agent Plugins `plugin.json` and
Skill directory. Remove it with `grok plugin uninstall ego`.

### WorkBuddy

Extract the WorkBuddy ZIP as a marketplace root. It contains
`.claude-plugin/marketplace.json` and `plugins/ego/`, including
`.codebuddy-plugin/plugin.json`, `.workbuddy-plugin/plugin.json`, and the
Claude-compatible manifest.

For WorkBuddy versions that expose **添加市场** with local sources, add the
absolute path of the extracted root, select **ego-workbuddy-local**, and install
**ego**. Start a new task and ask it to use the ego-browser Skill.

Local marketplace import still needs verification in WorkBuddy Desktop. The
[official WorkBuddy plugin guide](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Plug-In)
documents marketplace installation but does not establish a direct ZIP import
workflow. If the installed version only accepts a published marketplace, this
local archive must be distributed through that supported marketplace first.

### QwenWork Desktop

Upload the QwenWork ZIP directly through **扩展 → 专家套件 → + 添加 → 上传套件**,
then click **安装**. Start a new task and ask it to use ego-browser.

This package uses `.claude-plugin/plugin.json`, an explicitly supported expert
kit format. The older `.qoder-plugin/plugin.json` source manifest is not used
for this artifact. See the [QwenWork expert-kit guide](https://qwenwork.cn/docs/desktop/expert-kits).

### OpenCode

Extract the local npm archive into a persistent directory, then register its
JavaScript entry point:

```bash
mkdir -p /absolute/path/to/ego-opencode
tar -xzf /absolute/path/to/ego-opencode-v2.0.0.tgz -C /absolute/path/to/ego-opencode
opencode plugin "file:///absolute/path/to/ego-opencode/package/index.js" -g
```

Keep the extracted directory in place. OpenCode 1.14.30 accepts a local `.tgz`
in its installer but fails to resolve that archive's server entry at startup;
the extracted file URL loads successfully. Remove any earlier `.tgz` entry
from the config's `plugin` array when switching to the file URL.

The package is named `@citrolabs/ego-opencode`. Its `.` and `./server` exports
load `index.js`, which adds the packaged Skill instructions and `/ego-browser`
command. To remove it, delete its entry from the applicable `opencode.json`
`plugin` array.

See the [OpenCode plugin guide](https://opencode.ai/docs/plugins/).

### DeepSeek Harness

Extract the npm archive into a persistent directory, then add its `package/`
directory to the desired profile:

```bash
mkdir -p /absolute/path/to/ego-deepseek-harness
tar -xzf /absolute/path/to/ego-deepseek-harness-v2.0.0.tgz -C /absolute/path/to/ego-deepseek-harness
dsh plugin --profile web add /absolute/path/to/ego-deepseek-harness/package
dsh --profile web --dump-config
dsh --profile web
```

The package is named `@citrolabs/ego-deepseek-harness`. Its bundle patch loads
`@citrolabs/ego-deepseek-harness/dsh` and registers the packaged Skill. Use
`/ego-browser`. Remove it with
`dsh plugin --profile web remove @citrolabs/ego-deepseek-harness`.

An existing personal `ego-browser` Skill takes precedence over this bundled
provider. Check the base directory returned by the Skill tool: it must point
inside this extracted package when validating the plugin. Resolve the duplicate
personal Skill if you want named invocation to use the plugin copy.

See the [DeepSeek Harness local package guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md).

## Verification

Packaging tests check all nine payloads, marketplace paths, canonical Skill
contents, source symlink preservation, repeat builds, and failed-batch handling.
They load both npm adapters after extraction outside the repository. These
checks do not establish end-to-end compatibility in all nine host applications.

After installation, confirm that the host discovers ego-browser and can run:

```bash
ego-browser nodejs <<'EOF'
console.log('ego-browser ready')
EOF
```

## Development

`skills/ego-browser` is a relative symlink to `../../../skills/ego-browser`.
Edit the canonical Skill; the packager materializes it in temporary directories
and leaves the source link untouched. Unexpected or broken links fail packaging.

Plugin tests belong in `plugins/ego/tests/` and run independently of browser
runtime tests:

```bash
npm --prefix plugins/ego test
```

CI and the commit hook run this suite for plugin changes.
