> For the Agent Skills standard, see [agentskills.io](https://agentskills.io) and the [specification](https://agentskills.io/specification).

# ego-skills

`ego-skills` is a small Agent Skills repository centered on one thing: giving AI agents a practical, low-token browser automation workflow through `ego-cli`.

The repository currently ships a single production-oriented skill, `ego-cli`, plus supporting reference docs and shell templates. It is designed for agents that need to open websites, inspect pages, click through flows, fill forms, capture screenshots, extract content, and keep browser state across runs.

## What This Repository Contains

- `skills/ego-cli/SKILL.md`
  The main skill definition and usage guide.
- `skills/ego-cli/reference/`
  Reference material for authentication, commands, profiling, proxy support, snapshot refs, task management, and video recording.
- `skills/ego-cli/templates/`
  Reusable shell templates for authenticated sessions, page capture, and form automation.
- `.claude-plugin/marketplace.json`
  Claude Code marketplace metadata for installing this repo as a plugin source.

## What The `ego-cli` Skill Does

The skill teaches an agent to use `ego-cli` as a compact browser automation layer over Chrome/Chromium via CDP.

Its core interaction model is:

```bash
ego-cli open <url>
ego-cli snapshot -i
ego-cli click @e3
ego-cli snapshot -i
```

Instead of reasoning over raw HTML, the agent works from accessibility-tree snapshots and short refs like `@e1`, `@e2`, `@e3`. This keeps browser tasks much more token-efficient and easier to control.

Typical tasks include:

- Opening a page and reading its structure
- Clicking buttons and links
- Filling forms and submitting flows
- Waiting for navigation or content changes
- Extracting text, attributes, and structured data
- Taking screenshots, PDFs, and recordings
- Reusing authenticated browser state
- Running multiple isolated browser sessions in parallel

## Installation

### Option 1: Agent Skills CLI

Install the whole repository:

```bash
npx skills add citrolabs/ego-skills
```

Install only the browser skill:

```bash
npx skills add citrolabs/ego-skills --skill ego-cli
```

### Option 2: Claude Code Marketplace

Add this repository as a marketplace source:

```text
/plugin marketplace add citrolabs/ego-skills
```

Then install the included plugin from the Claude Code UI, or install it directly:

```text
/plugin install browser-skills@ego-agent-skills
```

## When To Use This Skill

Use `ego-cli` when the agent needs to:

- interact with websites
- log into web apps
- click through onboarding or settings flows
- fill and submit forms
- scrape or extract page content
- take screenshots for QA or reporting
- automate repeatable browser tasks in scripts

This repository currently focuses on the core browser skill. It does not bundle the optional specialized skills referenced from `SKILL.md`.

## Quick Examples

Ask an agent something like:

```text
Use ego-cli to open LinkedIn and find growth marketers at AI startups.
```

Or work directly with the CLI:

```bash
npm i -g ego-cli && ego-cli install

ego-cli open https://example.com
ego-cli snapshot -i
ego-cli screenshot home.png
ego-cli close
```

## Included Templates

The `templates/` directory provides ready-to-adapt workflows:

- `authenticated-session.sh`
  Log in once, save browser state, and reuse it later.
- `capture-workflow.sh`
  Capture screenshots, text, structure, and a PDF for a page.
- `form-automation.sh`
  Walk through the snapshot -> fill -> submit -> verify pattern for forms.

## Repository Layout

```text
.
├── README.md
├── LICENSE
├── spec/
│   └── agent-skills-spec.md
├── .claude-plugin/
│   └── marketplace.json
└── skills/
    └── ego-cli/
        ├── SKILL.md
        ├── reference/
        └── templates/
```

## Further Reading

- Core skill: [skills/ego-cli/SKILL.md](skills/ego-cli/SKILL.md)
- References: [skills/ego-cli/reference](skills/ego-cli/reference)
- Agent Skills specification: [agentskills.io/specification](https://agentskills.io/specification)

## License

[MIT](./LICENSE)
