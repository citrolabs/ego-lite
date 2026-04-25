# Experience Authoring

Use this guide to maintain Agent Browser site experience during a real website
task. Runtime experience belongs in the current installed skill root, for
example `.agents/skills/agent-browser/reference/sites/<site>/`.

## Decision gates

Keep a candidate list while working. Before the final response, write or update
site experience only when all gates pass:

- Observed in the current task, not generic or assumed.
- Site-specific and likely stable enough for reuse.
- Prevents a mistake, captures recovery, or removes repeated browser work.
- Recordable as mechanics without private content, credentials, or one-off data.

Update existing artifacts first; add a new artifact only when no close home
exists. Skip generic habits, low-confidence guesses, clean one-off successes, or
mechanics inseparable from private data. Ask only when the artifact itself would
contain sensitive content, credentials, destructive side effects, or an
ambiguous tradeoff.

## Artifact choice

Use the smallest artifact that preserves reuse:

- Site note: labels, URL shapes, constraints, side effects, recovery hints, or
  easy-to-misread areas.
- Tool: one runnable action that reduces clicking, inspection, extraction,
  waiting, pagination, navigation, or other repeated browser work. Examples
  include JavaScript evaluation, read-only page-context requests, CDP calls,
  scrolling loops, deduplication, polling/wait logic, and parameterized command
  sequences. Tools emit YAML.
- Workflow: a multi-step sequence, validation strategy, known side effect, or
  recovery path. Workflows compose tools and explain strategy; they do not record
  every clean success.

Escalate beyond a site note when reusable mechanics would otherwise be copied
into prose as executable behavior. Site notes can summarize or point to tools
and workflows; runnable logic belongs in tools, and ordering or validation logic
belongs in workflows. Tool and workflow budgets are limited, so keep tools
atomic and workflows focused.

Private or authenticated sessions are allowed. Maintain mechanics only:
data-free selectors, labels, URL/query shapes, extraction rules, waits, recovery
paths, and validation strategy. Do not store accounts, credentials, tokens,
message bodies or subjects, sender lists, result values, screenshots, or
revealing query terms.

## File layout

Each site lives under `reference/sites/<site>/`:

```text
reference/sites/example.com/
  site.md
  tools/<category>/<tool>.py
  workflows/<category>/<workflow>.md
```

The Markdown body of `site.md` is the site notes area and must stay under 2000 characters.
Each immediate `tools/<category>/` directory and each immediate
`workflows/<category>/` directory may contain at most 20 files. Split by a
clearer category before adding more files.
Do not save `@eN` refs in notes, workflows, or tools; refs are snapshot-local
except as temporary variables inside one tool run.

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
Tools may call `agent-browser`, JavaScript evaluation, read-only page-context
requests, or CDP when those are the stable way to perform diagnostics or
parameterized extraction. Visible user actions should stay aligned with normal
Agent Browser UI operations when possible. Prefer parameters over hardcoded
queries, account names, private-derived selectors, or current result values.

Workflows are Markdown files with frontmatter:

```markdown
---
name: read-results
description: Read visible results and summarize them.
tools:
  - reference/sites/example.com/tools/search/search-site.py
---
```

A workflow should describe strategy, validation, side effects, and composed
tools. It should not store credentials, private content, or one-off task data.

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
