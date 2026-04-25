# Experience Authoring

Use this guide to decide or write Agent Browser site experience during a real
website task. Runtime experience belongs in the current installed skill root,
for example `.agents/skills/agent-browser/reference/sites/<site>/`.

## What to maintain

Maintain candidates while working. Before the final response, decide with this
guide: when all evidence gates pass, the default action is to write without
asking; otherwise include the skip reason in the final answer.

- Observed in the current task, not generic or assumed.
- Site-specific and likely stable enough for reuse.
- Prevents a mistake, captures recovery, or removes repeated browser work.
- Recordable without private content, credentials, or one-off data.

Strong write signals:

- Stable selectors, UI labels, URL/query patterns, constraints, or side effects.
- Pagination, scrolling, extraction, waiting, or aggregation loops.
- A failed browser action followed by a reliable workaround.
- A parameterized script or repeated command sequence that emits YAML.

Private or authenticated sessions are allowed. Store mechanics only: selectors,
labels, URL/query shapes, pagination/extraction rules, waits, recovery paths,
and validation strategy. Do not store accounts, credentials, tokens, message
bodies, subjects, sender lists, result values, screenshots, or revealing query
terms.

Skip generic habits, low-confidence guesses, clean one-off success, or anything
inseparable from private data. Ask only when the artifact itself would contain
sensitive content, credentials, destructive side effects, or an ambiguous
tradeoff.

Prefer the smallest useful artifact. Create or update site notes for stable
site knowledge such as host aliases, interaction constraints, side effects, or
areas that are easy to misread.

Create or update a workflow only when the task revealed a non-obvious sequence,
meaningful mistake, recovery path, validation strategy, or known side effect.
Workflows compose tools and explain strategy; they do not record every clean
success.

Create or update a tool when reusable automation would reduce future clicking,
snapshot inspection, extraction, waiting, pagination, navigation, or other
manual browser steps. Keep tools atomic. A tool should perform one reusable
action such as search, open a visible result, read the current item, or navigate
back.

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
`workflows/<category>/` directory may contain at most 30 files. Split by a
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
