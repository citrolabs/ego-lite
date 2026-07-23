# ego Linux Host (ego-shaped) — Design Spec

**Date:** 2026-07-23  
**Status:** Approved for planning  
**Repo:** local clone of `citrolabs/ego-lite` at `/home/iago/projeto/ego-lite`  
**Audience:** implementers building a Linux runtime that preserves the product purpose of ego lite

---

## 1. Problem and purpose

ego lite’s purpose (from the upstream README) is:

> The best browser for both you and your AI agents work in parallel.

It is **not** a generic browser-automation framework. Contrasts that define success:

| ego lite is | ego lite is not |
|---|---|
| One browser humans and agents share | A separate automation browser (browser-use, agent-browser) |
| Agents in isolated **Spaces**; user tabs stay user | Agent and human fighting for the same tabs |
| Agents inherit **real logins** | Clean profile with login friction every time |
| **Code-base**: one JS heredoc with helpers | Multi-round CLI loops |
| Semantic snapshot + external agents via `ego-browser` | Only a built-in agent, or only headless drivers |

**Platform fact:** the closed-source ego lite **app** (Chromium customization, kernel-level snapshot, native UI) ships only for macOS today. This repository is the **open-source harness + skill**, not the browser binary (`AGENTS.md`, `CONTRIBUTING.md`).

**Goal of this work:** implement an **ego-shaped Linux host** so that, on Linux/WSL, agents can drive a shared Chromium through the existing `ego-browser` skill and harness, preserving the product model as far as stock Chromium + CDP allow.

**Non-goal:** reverse-engineering or shipping a drop-in clone of the Citro macOS app (native Spaces UI, kernel-level snapshot parity, full Chrome extension migration).

---

## 2. Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Product shape | Shared Chromium host (human + agent), not agent-only headless driver | Matches README purpose |
| Code location | New package `package/ego-linux-host/` in this clone | Keeps harness + skill + host together |
| Task Space isolation | **Tab sets** in one shared profile (shared cookies/logins) | CONTRIBUTING: spaces own their tab set but **inherit user login state** |
| Transport | CDP only — **no Playwright / Puppeteer** | CONTRIBUTING tech stack |
| Browser process | Long-lived Chromium + long-lived host daemon | State lives browser-side, not in the Node heredoc process |
| Default display | Headed (WSLg/DISPLAY); headless only opt-in | Human and agent share the browser |
| Upstream app | Not required for MVP | Host fills `globalThis.ego` that the OSS harness already expects |

---

## 3. Architecture

### 3.1 Components

```text
┌─ package/ego-linux-host (new) ──────────────────────────┐
│  chrome-supervisor   Launch/supervise persistent Chrome │
│  cdp-bridge          WebSocket CDP ↔ sendCDPMessage     │
│  space-manager       Spaces, ownership, tab membership  │
│  snapshot-engine     AX+DOM → { content, refs }         │
│  ego-runtime         Implements globalThis.ego contract │
│  host-daemon         Long process + local control socket│
│  cli-shim            ego-browser → inject ego + harness │
└──────────────────────────────▲──────────────────────────┘
                               │ globalThis.ego
┌──────────────────────────────┴──────────────────────────┐
│  package/ego-browser (OSS harness — keep stable)        │
│  skills/ego-browser (skill / install docs)              │
└─────────────────────────────────────────────────────────┘
```

### 3.2 Runtime flow

1. User or agent invokes `ego-browser` (CLI shim on `PATH`).
2. Shim ensures `ego-linux-hostd` is running; daemon ensures Chromium is running with a fixed `user-data-dir` and loopback CDP port.
3. Each heredoc is a **short-lived Node process** that:
   - connects to the daemon (local socket),
   - installs `globalThis.ego` client bindings,
   - executes the existing OSS harness (`runMain` / built bundle) against stdin JS.
4. **Durable state** (spaces, ownership, tab membership, profile/logins) lives in the daemon + Chromium profile — not in the heredoc process.

### 3.3 What stays unchanged

- Public helper surface and skill workflow (`taskSpaces`, `page`, `browser`, one-heredoc composition).
- OSS unit tests under `package/ego-browser` must keep passing.
- Prefer wiring via shim/env over forking harness contracts.

---

## 4. Task Space model

### 4.1 Definition

A Task Space is a **named browsing workspace** with:

- numeric `id` and string `name` / `taskId`
- `ownership`: `"agent" | "agentDelegatedToUser" | "user"`
- `createdBy`: `"agent" | "user"`
- ordered set of CDP page `targetId`s (its tabs)
- optional `recentTabTitles`

Isolation is of **tabs and control**, not of cookie jars. All spaces share one Chromium `user-data-dir` so logins carry.

### 4.2 System spaces

| Space | ownership | Role |
|---|---|---|
| `user` (fixed low id, e.g. `1`) | `user` | Human’s default tab set |
| Agent-created | `agent` | Default for `useOrCreate` |
| After handoff | `agentDelegatedToUser` | Still agent-owned for policy tables; page ops blocked until `takeOver` |

Ownership **policy tables** already live in `package/ego-browser/src/helpers.ts` and `skills/ego-browser/SKILL.md`. The host enforces boundaries at the native bridge.

### 4.3 Enforcement rules

1. `listTabs` / `createTab` / session attach operate only on the **currently selected** space’s targets (agent view).
2. New tabs from `createTab` join the selected space.
3. Tabs opened by the human in the UI without space metadata join the `user` space (MVP).
4. Agents never receive another space’s `targetId` from `listTabs` (except explicit debug flags).
5. Parallel agent spaces = disjoint tab sets.
6. Selecting a `user`-owned space via `useTaskSpace` is allowed for listing identity, but page-level work and `snapshot` fail with `EGO_TASK_SPACE_USER_IN_CONTROL` until `claim` (or appropriate take-over flow).
7. `handOffTaskSpace` → ownership `agentDelegatedToUser`; page ops / snapshot reject with user-control code.
8. `takeOverTaskSpace` → back to `agent`.
9. `completeTaskSpace` with keep true/false follows harness semantics (`complete` vs `close` on ego bindings).
10. MVP selection: one global selected space id in the daemon (one agent per machine). Multi-client selection is backlog.

### 4.4 Space record shape (harness-compatible)

```ts
{
  taskId: string,
  id: number,
  name: string,
  createdBy: "agent" | "user",
  ownership: "agent" | "agentDelegatedToUser" | "user",
  recentTabTitles?: string[]
}
```

Persistence: best-effort `spaces.json` under the data dir; live membership also in daemon memory. After crash, orphan page targets reattach to `user` unless recoverable metadata says otherwise.

---

## 5. `globalThis.ego` contract (host must implement)

The OSS harness calls these. Signatures are behavioral contracts inferred from `helpers.ts`, `browser-runtime.ts`, `nav.ts`, `observe.ts`, and tests.

### 5.1 CDP channel

| API | Behavior |
|---|---|
| `sendCDPMessage(payloadJson: string)` | Send one CDP message (id/method/params/sessionId) |
| `onCDPMessage` | Host invokes with JSON string responses/events |
| `onSendCDPMessageError` | Host invokes on local send failures (incl. inactive/user-control) |

### 5.2 Tabs

| API | Behavior |
|---|---|
| `listTabs()` | `{ tabs: [{ targetId, title, url, active, index? }] }` filtered to selected space |
| `createTab(url)` | `{ targetId }` in selected space |

### 5.3 Task spaces

| API | Behavior |
|---|---|
| `listTaskSpaces()` | `{ taskSpaces: Space[] }` |
| `createTaskSpace(name)` | create agent-owned space + return record |
| `useTaskSpace(id: number)` | select space; may return `{ error, error_code }` for user control |
| `claimTaskSpace(id, name?)` | user → agent, then usable |
| `completeTaskSpace()` | complete selected (keep path) |
| `closeTaskSpace()` | close selected space and its tabs |
| `handOffTaskSpace()` | agent → agentDelegatedToUser |
| `takeOverTaskSpace()` | restore agent control |

### 5.4 Snapshot

| API | Behavior |
|---|---|
| `snapshot(options)` | `{ content: string, refs: Ref[] }` or reject |

`refs` entries must include `backendNodeId` (required by `browserSnapshotRefsToRefMap` / element resolver). Options include `scope`, `includeActionMarks`, `includeStableLocator`, `maxResultLength`.

Under user-control ownership, `snapshot` **must reject** with `EGO_TASK_SPACE_USER_IN_CONTROL` (used by `waitForAgentControl` probe).

### 5.5 Optional (MVP may no-op)

- `animationHighlightMouseToPosition?(x, y)`
- `setAgentTaskState?(label)`

### 5.6 Error codes

Host should emit stable codes from `package/ego-browser/src/ego-errors.ts`, especially:

- `EGO_TASK_SPACE_USER_IN_CONTROL`
- `EGO_TASK_SPACE_NOT_SELECTED`
- `EGO_TASK_SPACE_NOT_FOUND`
- `EGO_TASK_SPACE_INACTIVE`
- `EGO_BROWSER_UNAVAILABLE`
- `EGO_CDP_CHANNEL_UNAVAILABLE`
- `EGO_CDP_SEND_FAILED`
- `EGO_SNAPSHOT_FAILED`
- `EGO_OPERATION_FAILED`

Shapes: thrown `Error` with `.error_code`, or resolved `{ error, error_code }`.

---

## 6. Daemon, Chromium, CLI, install

### 6.1 Processes

| Process | Lifetime | Role |
|---|---|---|
| `ego-linux-hostd` | Long | Spaces, CDP client, snapshot, RPC |
| Chromium/Chrome | Long | Profile, tabs, logins |
| `ego-browser` | Short per heredoc | Ensure host, inject ego, run harness |

### 6.2 Paths

```text
~/.local/share/ego-lite/
  profile/       # Chromium user-data-dir
  spaces.json
  host.pid
  host.log
  host.sock      # default control socket

~/.config/ego-lite/
  config.json

~/.local/bin/ego-browser
```

- Control: Unix socket default; TCP `127.0.0.1` fallback if needed on WSL.
- Chrome CDP: `127.0.0.1` only (e.g. port `9222`).
- Directory mode `0700`.

### 6.3 Chrome supervisor

Resolve binary: `EGO_CHROME_PATH` → config → `google-chrome` / `chromium` on `PATH` → common paths.

Flags (minimum):

- `--user-data-dir=<profile>`
- `--remote-debugging-port=<port>`
- `--remote-debugging-address=127.0.0.1`
- `--no-first-run`
- `--no-default-browser-check`

Do **not** disable web security. Headed default; `EGO_HEADLESS=1` opt-in. If no display on WSL, fail or headless **with an explicit message**.

Respawn Chrome when dead; CLI respawns daemon when dead. Prefer reusing an already-running debug Chrome on the same profile when safe.

### 6.4 CLI shim behavior

```bash
ego-browser nodejs <<'EOF'
# skill-shaped
EOF

ego-browser <<'EOF'
# harness-shaped
EOF
```

- Treat `nodejs` as an optional no-op subcommand for skill compatibility.
- Support `--doctor`, `--reload`, `-h` / `--help`.
- `--doctor`: chrome path, daemon health, CDP port, profile, space count, selected space, headed/headless, display.
- `--reload`: drop cached CDP sessions; reattach.

### 6.5 Config and env

`config.json` fields: `chromePath`, `userDataDir`, `cdpPort`, `headless`, `seedFromChrome`, `hostSocket`.

Env overrides: `EGO_CHROME_PATH`, `EGO_USER_DATA_DIR`, `EGO_CDP_PORT`, `EGO_HEADLESS`, `EGO_HOST_SOCK`, `EGO_BROWSER_AGENT_WORKSPACE` (existing harness).

### 6.6 Install (Linux)

Add:

- `package/ego-linux-host/` (implementation)
- `skills/ego-browser/scripts/install-linux.sh`
- Linux section in `skills/ego-browser/references/install.md`

`install-linux.sh`:

1. Require Linux + Node ≥ 22.
2. Build `package/ego-browser` and `package/ego-linux-host`.
3. Symlink `ego-browser` into `~/.local/bin`; remind about PATH.
4. Detect Chrome; print install hints if missing (do not silent `apt install` without consent).
5. Create data dirs.
6. Optional `--seed-chrome` only when Chrome is closed; document risk.
7. Smoke: `--doctor` + minimal heredoc when environment allows.

macOS `install.sh` remains macOS-only (DMG). This host does not download Citro’s app.

### 6.7 WSL notes

- Prefer WSLg for headed.
- MVP targets **Linux-side** Chrome/Chromium, not Windows `chrome.exe`.
- Document Windows Chrome as out of scope for MVP.

---

## 7. Snapshot engine

### 7.1 Pipeline (MVP)

1. Resolve active page target in selected space.
2. Fail fast with user-control code when ownership blocks agent work.
3. `Accessibility.getFullAXTree` via CDP; keep nodes with `backendDOMNodeId`.
4. Optionally enrich weak AX with simple DOM labels.
5. Iframes: one level of child targets in MVP.
6. Serialize compact text `content` (roles, names, `@N` marks when `includeActionMarks`).
7. Build `refs[]` with real `backendNodeId` values.

### 7.2 Quality bar

Good enough for skill patterns: `page.snapshot()` + semantic locators + `@N` refs.  
**Not** claimed to match Citro kernel-level snapshot quality. Document the gap in host README / install docs.

---

## 8. Testing strategy

| Layer | Scope | Requires Chrome |
|---|---|---|
| Unit | space-manager, isolation, error codes | No |
| Unit | snapshot serializer from AX fixtures | No |
| Integration | daemon RPC + CLI `--doctor` | Optional |
| E2E smoke | example.com title + snapshot | Yes, opt-in `EGO_LINUX_E2E=1` |
| Regression | `package/ego-browser` `npm test` | No |

---

## 9. Acceptance criteria (MVP)

1. `install-linux.sh` places a working `ego-browser` on `PATH` (with documented PATH fix if needed).
2. `ego-browser --doctor` reports healthy daemon + Chrome + profile.
3. Skill-shaped heredoc works:

```bash
ego-browser nodejs <<'EOF'
const task = await taskSpaces.useOrCreate('linux-smoke')
await browser.openOrReuseTab('https://example.com', { wait: true, timeout: 20000 })
const title = await page.title()
const snap = await page.snapshot()
if (!title) throw new Error('missing title')
if (!snap || !String(snap).trim()) throw new Error('empty snapshot')
console.log(JSON.stringify({ taskSpaceId: task.id, title, snapHead: String(snap).slice(0, 200) }, null, 2))
EOF
```

4. User-space tabs are not listed in an agent space’s `listTabs`.
5. Snapshot/page ops under user-control fail with `EGO_TASK_SPACE_USER_IN_CONTROL`.
6. Two agent spaces keep disjoint tab sets.
7. A second heredoc reattaches the same space by name/id (daemon state).
8. Handoff → blocked snapshot → `takeOver` → snapshot works.
9. `cd package/ego-browser && npm test` remains green.

---

## 10. Delivery phases

| Phase | Deliverable | Testable outcome |
|---|---|---|
| **0 — Scaffold** | Package layout, build, CLI stub, host README (limits) | `--help` |
| **1 — Chrome + CDP** | supervisor + cdp-bridge + send/listTabs/createTab | CDP navigation works |
| **2 — Spaces** | space-manager, ownership, tab filter, error codes | isolation + handoff |
| **3 — Snapshot** | AX pipeline + refs | `page.snapshot()` usable |
| **4 — Shim + install** | PATH shim, `install-linux.sh`, skill install docs | end-to-end skill smoke |
| **5 — Hardening** | doctor details, respawn, optional seed, opt-in e2e | daily WSL stability |

Order is intentional: CDP → Spaces → Snapshot → install polish.

---

## 11. Explicit non-goals / backlog

- Native Spaces UI / agent overlay chrome like macOS app  
- Kernel-level snapshot parity  
- Full Chrome extension/keychain migration  
- Multi-agent selected-space isolation by client id  
- Windows host  
- Driving Windows Chrome from WSL  
- npm publish / marketplace packaging  
- Upstream PR to Citro before local stability  

---

## 12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| WSL without display | Document WSLg; explicit headless opt-in messaging |
| Weaker snapshots than macOS | Rely on harness locators; iterate serializer with fixtures |
| Profile singleton lock | Single daemon owns profile; doctor explains lock errors |
| Space state loss on crash | Best-effort `spaces.json`; orphans → `user` |
| Contract drift vs closed app | Contract tests derived from OSS FakeEgo + helpers |
| Scope creep into “full browser product” | Non-goals section; phase gates |

---

## 13. Success definition (product language)

On Linux/WSL, a developer can:

1. Install the Linux host with one script.
2. Keep a real Chromium window for themselves (user space).
3. Have any agent CLI run `ego-browser` heredocs in **agent Spaces** without stealing user tabs.
4. Benefit from **shared logins** on the persistent profile.
5. Compose multi-step browser work in **one code heredoc** using the existing skill — the core ego lite promise, without the macOS app.

---

## 14. Open items deferred to implementation plan

These are intentionally not blocked for design approval:

- Exact RPC schema (JSON-RPC vs custom line protocol) on `host.sock`
- Exact module file tree under `package/ego-linux-host/src/`
- Whether the shim shells into `node artifacts/...` or `node package/ego-browser/dist/out/index.js`
- Concrete AX serialization format details (string layout of `content`)

They belong in `docs/superpowers/plans/` with bite-sized tasks.
