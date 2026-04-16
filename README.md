> **Note:** For information about the Agent Skills standard, see [agentskills.io](http://agentskills.io).


# Install SKill

## npx
Install all:
```sh
npx skills add citrolabs/ego-skills
```
Install only this skill:
```sh
npx skills add citrolabs/ego-skills --skill ego-cli
```

## OpenClaw

## Claude Code
You can register this repository as a Claude Code Plugin marketplace by running the following command in Claude Code:
```
/plugin marketplace add citrolabs/ego-skills
```

Then, to install a specific set of skills:
1. Select `Browse and install plugins`
2. Select `ego-agent-skills`
3. Select `document-skills`
4. Select `Install now`

Alternatively, directly install either Plugin via:
```
/plugin install browser-skills@ego-agent-skills
```

After installing the plugin, you can use the skill by just mentioning it. For instance, if you install the `document-skills` plugin from the marketplace, you can ask Claude Code to do something like: "Use the PDF skill to extract the form fields from `path/to/some-file.pdf`"

## Codex
