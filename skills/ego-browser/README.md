# ego-browser Skill

This is the standard skill package for ego-browser. It contains:

- `SKILL.md` and `SKILL.zh.md` for agent-facing runtime guidance.

ego-browser defaults `agentWorkspace()` to this package root when this repository layout is used:

```text
package/ego-browser/
skills/ego-browser/
```

## Installing the CLI

This skill package contains no executable. The `ego-browser` command ships with the code package `package/ego-browser/`. Requires Node.js >= 22.

From inside `package/ego-browser/`, run one of:

```bash
npm link            # dev: symlink the CLI onto your PATH from this checkout
npm install -g .    # global install
```

Or invoke directly without touching PATH:

```bash
node package/ego-browser/bin/ego-browser.js <<'JS'
await newTab("https://example.com")
cliLog(await pageInfo())
JS
```

Once on PATH:

```bash
ego-browser <<'JS'
await newTab("https://example.com")
cliLog(await pageInfo())
JS
```

Set `EGO_BROWSER_AGENT_WORKSPACE` to override that location for isolated runs.
