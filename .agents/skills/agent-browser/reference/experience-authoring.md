# Experience Authoring

Use this guide to maintain Agent Browser site experience during a real website
task. Runtime experience belongs in the current installed skill root, for
example `.agents/skills/agent-browser/reference/sites/<site>/`.

## What to maintain

Keep a candidate list while working. Before final response, apply these gates.
When all pass, write/update without asking; otherwise report the skip reason.

- Observed in the current task, not generic or assumed.
- Site-specific and likely stable enough for reuse.
- Prevents a mistake, captures recovery, or removes repeated browser work.
- Recordable without private content, credentials, or one-off data.

Strong write signals:

- Stable selectors, UI labels, URL/query patterns, constraints, or side effects.
- Pagination, scrolling, extraction, waiting, or aggregation loops.
- A failed browser action followed by a reliable workaround.
- A parameterized script or repeated command sequence that emits YAML.

Private or authenticated sessions are allowed. Maintain mechanics only: selectors,
labels, URL/query shapes, pagination/extraction rules, waits, recovery paths,
and validation strategy. Do not store accounts, credentials, tokens, message
bodies, subjects, sender lists, result values, screenshots, or revealing query
terms.

Skip generic habits, low-confidence guesses, clean one-off success, or anything
inseparable from private data. Ask only when the artifact itself would contain
sensitive content, credentials, destructive side effects, or an ambiguous
tradeoff.

Use existing artifacts first. Inspect related site notes, workflows, and tools;
update or generalize the closest fit before adding anything; add a new artifact only when the mechanic has no clear home.
Tool and workflow budgets are limited.

Use the smallest useful artifact:

- Site note: stable site knowledge such as host aliases, interaction
  constraints, side effects, or easy-to-misread areas.
- Workflow: non-obvious sequence, meaningful mistake, recovery path, validation
  strategy, or known side effect. Workflows compose tools and explain strategy;
  they do not record every clean success.
- Tool: reusable automation that reduces future clicking, snapshot inspection,
  extraction, waiting, pagination, navigation, or other manual browser steps.
  Keep tools atomic: one reusable action such as search, open a visible result,
  read the current item, or navigate back.

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
Tools may call `agent-browser` commands, including JavaScript evaluation for
read-only diagnostics, but visible user actions should stay aligned with normal
Agent Browser UI operations when possible. Prefer parameters over hardcoded
queries, account names, selectors derived from private content, or current
result values.

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
