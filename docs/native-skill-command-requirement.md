# `ego-browser skill` host requirements

## Background

The published `ego-browser` Skill no longer contains the usage guide. From
Skill 2.1.0, `skills/ego-browser/SKILL.md` only tells agents to run
`ego-browser skill`. The guide itself ships in the SDK release payload, so the
installed Ego Lite always prints the guide that matches its own runtime. A user
can then install any release of the Skill into `~/.agents/skills` without
getting instructions for another browser version.

This repository builds the guide and its renderer. Ego Lite needs to provide
the command and stop installing the full guide into the user's Skill directory.

## Release payload

`npm run build` writes the release payload to `dist/out/`. Ship these files
together, as today:

```text
index.js          SDK
skill.js          guide renderer (new)
ego-browser/
  GUIDE.md        main guide (was SKILL.md)
  topics/*.md     situational guides (new)
  learnings/      site learnings read by the runtime
```

`references/` and `scripts/` are no longer part of the payload.

## 1. Add the `ego-browser skill` command

```text
ego-browser skill [topic] [--skill-dir <dir>] [--help]
```

Run `skill.js` from the directory of the SDK that `ego-browser nodejs` would
load, with the embedded Node.js runtime. Consume host options such as
`--sdk-path` and `--ego-server-name` as `ego-browser nodejs` does, and pass the
remaining arguments after `skill` unchanged:

```text
<embedded node> <dirname(selected SDK)>/skill.js [arguments...]
```

- Select the SDK with the same rules as `ego-browser nodejs`: `--sdk-path`, then
  the debug SDK entry, then the bundled SDK. This lets the guide follow a local
  SDK build during development without another setting.
- `skill.js` parses its own arguments and handles `--skill-dir`,
  `EGO_BROWSER_SKILL_DIR`, and `--help`. Keep the user's environment so
  `EGO_BROWSER_SKILL_DIR` reaches it.
- The renderer only reads files. It must work when the browser is not running
  and does not need `globalThis.ego` or a browser connection.
- Pass stdout and stderr through unchanged and exit with the renderer's status:

  | Status | Meaning                                                |
  | ------ | ------------------------------------------------------ |
  | `0`    | The guide or topic was printed to stdout               |
  | `1`    | The guide could not be read, or the arguments were bad |
  | `2`    | Unknown topic; stderr lists the topics of this version |

- When the selected SDK directory has no `skill.js` (for example `--sdk-path`
  points at an older build), print
  `This ego-browser SDK does not include the usage guide: <dir>` to stderr and
  exit with status `1`.
- Add `skill` to `ego-browser --help` and `ego-browser help skill`.

Acceptance:

1. `ego-browser skill` prints a first line starting
   `[ego-browser:skill] ego-browser guide v` and a last line starting
   `[ego-browser:skill] end of guide v`, with the browser closed.
2. `ego-browser skill windows` prints the Windows topic.
   `ego-browser skill missing` exits with status `2` and lists the available
   topics on stderr.
3. `ego-browser skill --sdk-path <checkout>/package/ego-browser/dist/out/index.js`
   and the debug SDK entry both print a first line naming
   `<checkout>/package/ego-browser/dist/out/ego-browser`.
4. `EGO_BROWSER_SKILL_DIR=<dir> ego-browser skill` prints a first line naming
   `<dir>`.
5. Output is byte-identical to `node <payload>/skill.js` with the same
   arguments, on macOS and Windows, including non-ASCII text.

## 2. Stop installing the full guide as the user's Skill

Ego Lite currently extracts the payload's `ego-browser/` directory to
`~/.local/share/ego/ego-skills` and links `~/.agents/skills/ego-browser` to it.
With this change:

- Do not install the payload's `ego-browser/` directory as a Skill. It no longer
  contains a `SKILL.md`; it is data for `skill.js` and the runtime.
- When Ego Lite installs the Skill for the user, install the published entry
  Skill: the `skills/ego-browser/` directory of this repository at the matching
  release tag. It does not change between browser releases, so reinstalling it
  on every update is unnecessary.
- Do not overwrite `~/.agents/skills/ego-browser` when it already exists and is
  not a link Ego Lite created. Replace an Ego Lite-created link that still
  points at the old extracted guide.
- If the host sets `EGO_BROWSER_AGENT_WORKSPACE`, point it at the bundled
  `ego-browser/` directory, not the user's Skill directory. Site learnings now
  live only in the payload.

Acceptance: after upgrading from a release that installed the full guide,
`~/.agents/skills/ego-browser/SKILL.md` is the entry Skill, `ego-browser skill`
prints the guide, and site learnings still load in `ego-browser nodejs`
(`console.log(await siteSkills())` lists the bundled sites).

## 3. Release order

The entry Skill relies on `ego-browser skill`; for an older Ego Lite it tells
the agent to run `ego-browser upgrade`. Release in this order:

1. Ego Lite with requirements 1 and 2, bundling an SDK payload built from this
   change.
2. After that release is available through `ego-browser upgrade`, publish Skill
   2.1.0 (plugins, marketplaces, and install flows).

Publishing the Skill first leaves every user on an older Ego Lite with a Skill
whose only instruction fails.
