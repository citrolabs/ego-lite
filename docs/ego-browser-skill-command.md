# `ego-browser skill` browser integration

The ego-browser Skill has two layers:

- **Entry Skill** — `skills/ego-browser/` in this repository. It is what skill
  markets, plugins, and `~/.agents/skills/ego-browser` contain. It only tells the
  agent to run `ego-browser skill`, plus the install guide and the
  cookie/cache/storage guide that must be readable before ego lite exists.
- **Usage guide** — `package/ego-browser/skill-body/SKILL.md`. It is versioned
  with the SDK and printed by `ego-browser skill`, so the agent always reads the
  guide that matches the installed browser.

This document lists what the ego lite app and its native `ego-browser` launcher
must implement. Everything else lives in this repository.

## Release payload

`npm run build` writes the payload to `package/ego-browser/dist/out/`
(CI archives the same directory as `ego-browser-release-payload.tar.gz`):

```text
dist/out/
├── index.js                     SDK bundle
├── ego-browser/
│   └── SKILL.md                 usage guide printed by `ego-browser skill`
└── agent-skills/
    └── ego-browser/             entry Skill to install into ~/.agents/skills/ego-browser
        ├── SKILL.md
        ├── references/
        ├── scripts/
        ├── agents/
        └── assets/
```

Ship `dist/out/` as one unit inside the app, keeping `ego-browser/SKILL.md`
next to `index.js`.

## 1. Add the `ego-browser skill` subcommand

1. Resolve the SDK with exactly the same rules as `ego-browser nodejs`:
   `--sdk-path`, then the debug override
   (`~/Library/Application Support/Citro Labs/debug/index.js`), then the bundled
   SDK. Do not implement a separate lookup, or the guide and SDK can come from
   different builds.
2. Read `ego-browser/SKILL.md` from the directory that contains the resolved
   `index.js`.
3. Write it to stdout unchanged and exit 0. The build already adds the first
   line (`[ego-browser:skill] ego-browser usage guide v<version>`) and the last
   line (`[ego-browser:skill] end of guide v<version>`); do not add or parse
   anything else.
4. When the SDK is not the bundled one, print one extra line before the guide so
   developers notice the override:

   ```text
   [ego-browser:skill] source=debug-sdk dir=/path/to/dist/out/ego-browser (override, not the bundled guide)
   ```

   `source` is `sdk-path` or `debug-sdk`.

Errors:

| Case | Behavior |
| --- | --- |
| Any extra argument, e.g. `ego-browser skill foo` | Print usage to stderr, exit non-zero |
| `ego-browser/SKILL.md` missing next to the resolved SDK | Print the path that was checked to stderr, exit non-zero; do not fall back to another source |

Also list `skill` in `ego-browser help`, e.g. "Print the usage guide for this
ego lite version".

Older launchers print `Unknown command: skill` and exit 2. The entry Skill
relies on that to send the agent to `references/install.md`, which asks the user
to run `ego-browser upgrade`.

## 2. Install the entry Skill on launch

On every launch, check `~/.agents/skills/ego-browser`:

| Current state | Action |
| --- | --- |
| Missing | Copy `agent-skills/ego-browser/` there as real files |
| A symlink the browser created earlier (to `~/.local/share/ego/ego-skills`) | Replace it with a copy of `agent-skills/ego-browser/`, then delete `~/.local/share/ego/ego-skills` |
| Anything else (installed by the user or a package manager) | Leave it untouched |

Stop extracting the full Skill to `~/.local/share/ego/ego-skills`. After the
entry Skill is in place, the browser never writes `~/.agents/skills` again;
upgrades only replace the bundled payload.

## Acceptance checks

- [ ] `ego-browser skill` output is byte-identical to the bundled
      `ego-browser/SKILL.md`, starts with the version line, and ends with
      `[ego-browser:skill] end of guide v<version>`.
- [ ] With `--sdk-path <checkout>/package/ego-browser/dist/out/index.js` or the
      debug override, the output is the checkout's guide and starts with a
      `source=` line; removing the override restores the bundled guide.
- [ ] `ego-browser skill foo` and a missing guide both exit non-zero with a
      readable error.
- [ ] `ego-browser help` lists `skill`.
- [ ] Fresh install: `~/.agents/skills/ego-browser` contains the entry Skill.
- [ ] Upgrade from a version that used the `ego-skills` symlink: the symlink is
      replaced by the entry Skill. A user-installed Skill stays unchanged.
