# Experience Authoring

Use this guide only when maintaining Agent Browser site experience after a real
website task. Runtime experience belongs in the current installed skill root,
for example `.agents/skills/agent-browser/reference/sites/<site>/`.

## What to maintain

After a task, identify maintenance candidates and ask the user before writing
them. Do not add experience only because a task succeeded.

Create or update a tool when a browser operation is reusable and would reduce
future clicking, snapshot inspection, extraction, waiting, pagination, or other
manual browser steps. Keep tools atomic. A tool should perform one reusable
action such as search, open a visible result, read the current item, or navigate
back. Do not create a highly customized one-off tool for a single task unless it
clearly generalizes.

Create or update a workflow only when the task revealed a non-obvious sequence,
a meaningful mistake, a recovery path, an important validation strategy, or a
known side effect that future agents should account for. Workflows should
compose tools and explain strategy; they should not record every clean success.

Create or update site notes when the finding is stable site knowledge but not an
executable action or workflow, such as host aliases, interaction constraints,
dangerous side effects, or site areas that are easy to misread.

## File layout

Each site lives under `reference/sites/<site>/`:

```text
reference/sites/example.com/
  site.md
  tools/<category>/<tool>.py
  workflows/<category>/<workflow>.md
```

The Markdown body of `site.md` is the site notes area. It must stay under 2000 characters.
Each immediate `tools/<category>/` directory and each immediate
`workflows/<category>/` directory may contain at most 30 files. Split by a
clearer category before adding more files. Do not save `@eN` refs as reusable
experience; refs are snapshot-local and must only be used inside one run.

## Metadata

`site.md` uses Markdown frontmatter with `name`, `description`, and optional
`hosts`. Keep the body concise: it is for site notes, not long workflows.

Python tools use YAML comment metadata:

```python
# ---
# name: search-site
# description: Search the site by query.
# inputs:
#   - query
# ---
```

Tool stdout must always be YAML with `status`, `message`, and optional `data`.
Tools may call `agent-browser` commands, including JavaScript evaluation for
read-only diagnostics, but visible user actions should stay aligned with normal
Agent Browser UI operations when possible.

Workflows are Markdown files with frontmatter:

```markdown
---
name: read-results
description: Read visible results and summarize them.
tools:
  - reference/sites/example.com/tools/search/search-site.py
---
```

A workflow should describe strategy, validation, known side effects, and which
atomic tools it composes. It should not store credentials, private content, or
snapshot refs.

## Validation

After editing a site experience folder, run:

```bash
python3 scripts/validate-site-experience.py --site example.com
```

The validator emits YAML only. It checks required metadata, site note length,
workflow tool references, category file limits, Python syntax, and obvious
dangerous command patterns. It is static and does not open browsers or websites.

Development sync currently uses `rsync --delete` from `skills/agent-browser` to
`.agents/skills/agent-browser`. That can overwrite runtime-generated
experience if the source directory does not contain it. Treat generated runtime
experience as separate until a deliberate promotion flow exists.
