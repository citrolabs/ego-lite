# ego Linux Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an ego-shaped Linux host (`package/ego-linux-host`) so agents can run `ego-browser` heredocs against a long-lived shared Chromium on Linux/WSL, with Task Spaces (tab sets + ownership), shared logins, and the existing OSS harness/skill.

**Architecture:** A long-lived `ego-linux-hostd` supervises Chromium (CDP on loopback), owns space state, and exposes RPC over a Unix socket. A short-lived `ego-browser` CLI shim ensures the daemon is up, installs a `globalThis.ego` client that speaks that RPC, and runs the existing `package/ego-browser` harness on stdin JS. No Playwright/Puppeteer.

**Tech Stack:** Node.js ≥ 22, TypeScript (ESM), `node:test` + `node:assert/strict`, native `ws` via undici/WebSocket or `chrome-remote-interface`-free raw WebSocket (`ws` package only if needed — prefer Node 22 built-in WebSocket), Unix domain sockets, stock Chromium/Chrome CDP.

**Spec:** `docs/superpowers/specs/2026-07-23-ego-linux-host-design.md`

## Global Constraints

- CDP only — no Playwright, no Puppeteer.
- One shared Chromium `user-data-dir` for all spaces (shared cookies/logins).
- Spaces isolate **tab sets + ownership**, not storage partitions.
- Do not break `package/ego-browser` tests; prefer zero harness changes.
- Headed by default; headless only via `EGO_HEADLESS=1` / config.
- Daemon and CDP bind loopback / local socket only.
- Node ≥ 22, ESM only, match ego-browser conventions (camelCase helpers, co-located `*.test.mjs`).

---

## File structure (create)

```text
package/ego-linux-host/
  package.json
  tsconfig.json
  README.md
  bin/
    ego-browser.mjs          # CLI entry (shim)
    ego-linux-hostd.mjs      # daemon entry
  scripts/
    build.mjs
  src/
    paths.ts                 # data dir, socket, defaults
    config.ts                # load config + env overrides
    errors.ts                # EgoError helpers / codes
    chrome-supervisor.ts     # find/launch/supervise Chrome
    cdp-bridge.ts            # WebSocket CDP client
    space-manager.ts         # spaces, ownership, tab membership
    snapshot-engine.ts       # AX → { content, refs }
    ego-runtime.ts           # daemon-side ego method implementations
    host-daemon.ts           # socket server + ensure chrome
    rpc.ts                   # JSON-RPC encode/decode
    ego-client.ts            # CLI-side globalThis.ego
    cli.ts                   # ego-browser shim logic
    index.ts                 # re-exports if needed
    *.test.mjs               # co-located tests (built to dist)
  dist/                      # build output (gitignored)

skills/ego-browser/
  scripts/install-linux.sh
  references/install.md      # append Linux section
```

---

### Task 0: Scaffold package

**Files:**
- Create: `package/ego-linux-host/package.json`
- Create: `package/ego-linux-host/tsconfig.json`
- Create: `package/ego-linux-host/scripts/build.mjs`
- Create: `package/ego-linux-host/README.md`
- Create: `package/ego-linux-host/src/paths.ts`
- Create: `package/ego-linux-host/src/paths.test.mjs`
- Create: `package/ego-linux-host/.gitignore`

**Interfaces:**
- Consumes: none
- Produces: build that emits `dist/`; `paths` module with `defaultDataDir()`, `defaultSocketPath()`, `defaultProfileDir()`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "ego-linux-host",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "bin": {
    "ego-browser": "./bin/ego-browser.mjs",
    "ego-linux-hostd": "./bin/ego-linux-hostd.mjs"
  },
  "scripts": {
    "clean": "rm -rf dist",
    "build": "node scripts/build.mjs",
    "typecheck": "tsc --noEmit",
    "test": "npm run build && npm run typecheck && node --test \"dist/**/*.test.js\""
  },
  "license": "MIT",
  "devDependencies": {
    "@types/node": "^22.15.29",
    "esbuild": "^0.28.1",
    "typescript": "^5.8.3"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": false,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"],
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create build.mjs (esbuild transpile src → dist)**

```js
import { mkdir, rm, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

async function collectTs(dir) {
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await collectTs(p)));
    else if (ent.name.endsWith(".ts") && !ent.name.endsWith(".d.ts")) out.push(p);
    else if (ent.name.endsWith(".test.mjs")) out.push(p);
  }
  return out;
}

const entries = await collectTs(join(root, "src"));
await build({
  entryPoints: entries,
  outdir: dist,
  outbase: join(root, "src"),
  platform: "node",
  format: "esm",
  target: "node22",
  bundle: false,
  sourcemap: true,
});
console.log(`built ${entries.length} files → dist/`);
```

Also copy `*.test.mjs` that import from `./foo.js` paths — keep tests as `.test.mjs` next to compiled `.js` by including them in entryPoints with `loader: { '.mjs': 'copy' }` or write tests under `src/` that import `../dist/...`. **Preferred:** put tests as `src/paths.test.mjs` importing `./paths.js` and after build copy mjs into dist:

After esbuild, copy test files:

```js
import { cp } from "node:fs/promises";
// for each src/**/*.test.mjs → dist/
```

Simpler approach for MVP: tests live as `src/*.test.mjs` and run with:

```json
"test": "npm run build && node --test \"src/**/*.test.mjs\""
```

…importing from `../dist/paths.js` — messy. **Use:** tests import relative `./paths.js` and run against `dist` after build by placing compiled tests only. Easiest path that works:

1. Write TypeScript tests as `src/paths.test.ts` compiled by esbuild to `dist/paths.test.js`
2. `"test": "npm run build && node --test \"dist/**/*.test.js\""`

- [ ] **Step 4: Implement paths.ts**

```ts
import { homedir } from "node:os";
import { join } from "node:path";

export const APP_NAME = "ego-lite";

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.EGO_DATA_DIR) return env.EGO_DATA_DIR;
  const xdg = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(xdg, APP_NAME);
}

export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.EGO_CONFIG_DIR) return env.EGO_CONFIG_DIR;
  const xdg = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, APP_NAME);
}

export function defaultProfileDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.EGO_USER_DATA_DIR) return env.EGO_USER_DATA_DIR;
  return join(defaultDataDir(env), "profile");
}

export function defaultSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.EGO_HOST_SOCK) return env.EGO_HOST_SOCK;
  return join(defaultDataDir(env), "host.sock");
}

export function defaultCdpPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.EGO_CDP_PORT;
  if (raw) return Number(raw);
  return 9222;
}
```

- [ ] **Step 5: Write paths.test.ts**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { defaultDataDir, defaultSocketPath, defaultCdpPort } from "./paths.js";

test("defaultDataDir uses EGO_DATA_DIR", () => {
  assert.equal(defaultDataDir({ EGO_DATA_DIR: "/tmp/ego-x" }), "/tmp/ego-x");
});

test("defaultSocketPath nests under data dir", () => {
  const sock = defaultSocketPath({ EGO_DATA_DIR: "/tmp/ego-x" });
  assert.equal(sock, "/tmp/ego-x/host.sock");
});

test("defaultCdpPort parses env", () => {
  assert.equal(defaultCdpPort({ EGO_CDP_PORT: "9333" }), 9333);
  assert.equal(defaultCdpPort({}), 9222);
});
```

- [ ] **Step 6: npm install, build, test**

```bash
cd package/ego-linux-host
npm install
npm test
```

Expected: PASS for paths tests.

- [ ] **Step 7: README.md** — state this is ego-shaped Linux host, not Citro app; link design spec.

- [ ] **Step 8: Commit**

```bash
git add package/ego-linux-host
git commit -m "feat(ego-linux-host): scaffold package, build, and paths"
```

---

### Task 1: Config + error helpers

**Files:**
- Create: `package/ego-linux-host/src/config.ts`
- Create: `package/ego-linux-host/src/config.test.ts`
- Create: `package/ego-linux-host/src/errors.ts`
- Create: `package/ego-linux-host/src/errors.test.ts`

**Interfaces:**
- Consumes: `paths.ts`
- Produces: `loadConfig(): HostConfig`, `egoError(code, message)`, `isUserControlCode(code)`

```ts
// config.ts shape
export type HostConfig = {
  chromePath: string | null;
  userDataDir: string;
  cdpPort: number;
  headless: boolean;
  hostSocket: string;
  dataDir: string;
  seedFromChrome: boolean;
};
export async function loadConfig(env?: NodeJS.ProcessEnv): Promise<HostConfig>;
```

- [ ] **Step 1: Write failing tests for loadConfig env overrides**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

test("loadConfig honors EGO_HEADLESS and EGO_CDP_PORT", async () => {
  const cfg = await loadConfig({
    EGO_DATA_DIR: "/tmp/ego-cfg-test",
    EGO_HEADLESS: "1",
    EGO_CDP_PORT: "9444",
  });
  assert.equal(cfg.headless, true);
  assert.equal(cfg.cdpPort, 9444);
  assert.equal(cfg.userDataDir, "/tmp/ego-cfg-test/profile");
});
```

- [ ] **Step 2: Implement config.ts** — read optional `~/.config/ego-lite/config.json` if present; env wins over file; defaults from paths.

- [ ] **Step 3: Implement errors.ts** — re-export the same code strings as `package/ego-browser/src/ego-errors.ts` (copy the const list; do not import across packages yet to avoid coupling). Provide:

```ts
export function makeEgoError(
  code: string,
  message: string,
): Error & { error_code: string } {
  const err = new Error(message) as Error & { error_code: string };
  err.error_code = code;
  return err;
}

export function egoResultError(code: string, message: string) {
  return { error: message, error_code: code };
}
```

- [ ] **Step 4: npm test && commit**

```bash
npm test
git add package/ego-linux-host/src
git commit -m "feat(ego-linux-host): add config loader and ego error helpers"
```

---

### Task 2: Chrome supervisor

**Files:**
- Create: `package/ego-linux-host/src/chrome-supervisor.ts`
- Create: `package/ego-linux-host/src/chrome-supervisor.test.ts`

**Interfaces:**
- Consumes: `HostConfig`
- Produces:

```ts
export function resolveChromePath(env?: NodeJS.ProcessEnv, explicit?: string | null): string | null;
export type ChromeHandle = {
  pid: number;
  cdpPort: number;
  userDataDir: string;
  kill(): Promise<void>;
};
export async function ensureChrome(config: HostConfig): Promise<ChromeHandle>;
export async function isCdpUp(port: number): Promise<boolean>;
```

- [ ] **Step 1: Write tests for resolveChromePath**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { resolveChromePath } from "./chrome-supervisor.js";
import { writeFile, chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("resolveChromePath prefers EGO_CHROME_PATH when executable", async () => {
  const dir = join(tmpdir(), `ego-chrome-${process.pid}`);
  await mkdir(dir, { recursive: true });
  const bin = join(dir, "fake-chrome");
  await writeFile(bin, "#!/bin/sh\nexit 0\n");
  await chmod(bin, 0o755);
  assert.equal(resolveChromePath({ EGO_CHROME_PATH: bin }), bin);
});
```

- [ ] **Step 2: Implement resolveChromePath** — check explicit, env, then candidates: `google-chrome-stable`, `google-chrome`, `chromium`, `chromium-browser`, `/usr/bin/google-chrome`, `/usr/bin/chromium`. Use `fs.access` + `X_OK` or `which` via `command -v` spawn.

- [ ] **Step 3: Implement isCdpUp** — `fetch(http://127.0.0.1:${port}/json/version)` success.

- [ ] **Step 4: Implement ensureChrome**

Logic:
1. If `isCdpUp(config.cdpPort)` → return handle without pid (attached mode) or discover pid best-effort.
2. Else resolve chrome path; throw `EGO_BROWSER_UNAVAILABLE` if missing.
3. `mkdir` userDataDir.
4. Spawn with args from design; if `!config.headless` and no `DISPLAY`/`WAYLAND_DISPLAY`, either set headless with stderr warning **or** throw with clear message — **implement throw** unless `EGO_HEADLESS=1` so headed-by-default is honest.
5. Poll `isCdpUp` up to 15s.
6. Return handle with `kill` using process group.

- [ ] **Step 5: Unit-test isCdpUp against closed port (false)**

```ts
test("isCdpUp is false for closed port", async () => {
  assert.equal(await isCdpUp(1), false);
});
```

- [ ] **Step 6: npm test && commit**

```bash
npm test
git commit -am "feat(ego-linux-host): chrome path resolution and supervisor"
```

---

### Task 3: CDP bridge

**Files:**
- Create: `package/ego-linux-host/src/cdp-bridge.ts`
- Create: `package/ego-linux-host/src/cdp-bridge.test.ts`

**Interfaces:**

```ts
export type CdpBridge = {
  send(method: string, params?: object, sessionId?: string): Promise<any>;
  sendRaw(payload: object): void;
  onEvent(handler: (msg: any) => void): () => void;
  close(): Promise<void>;
  listPageTargets(): Promise<Array<{ targetId: string; title: string; url: string; type: string }>>;
  createTarget(url: string): Promise<string>;
  attach(targetId: string): Promise<string>; // sessionId
};
export async function connectCdp(port: number): Promise<CdpBridge>;
```

- [ ] **Step 1: Write unit test with a mock WebSocket server** (or mock at a higher seam). Prefer testing message id correlation with a tiny fake:

```ts
// Test pure request/response map without real Chrome:
// export internal createCdpClient({ send, onMessage }) for injection.
```

Expose:

```ts
export function createCdpSession(transport: {
  send(text: string): void;
  onMessage(cb: (text: string) => void): void;
}): {
  send(method: string, params?: object, sessionId?: string): Promise<any>;
  handleIncoming(text: string): void;
};
```

- [ ] **Step 2: Implement createCdpSession** — incrementing id, pending Map, timeout 15s, route events (no id) to listeners.

- [ ] **Step 3: Implement connectCdp(port)** — GET `/json/version` → `webSocketDebuggerUrl` → `new WebSocket(url)` (Node 22 global). Wire transport.

- [ ] **Step 4: Implement listPageTargets via `Target.getTargets`**, filter `type === 'page'`.

- [ ] **Step 5: Implement createTarget via `Target.createTarget`**.

- [ ] **Step 6: Tests for id correlation + timeout**

```ts
test("createCdpSession resolves matching id", async () => {
  let handler;
  const transport = {
    send(text) {
      const msg = JSON.parse(text);
      handler(JSON.stringify({ id: msg.id, result: { ok: true } }));
    },
    onMessage(cb) {
      handler = cb;
    },
  };
  const session = createCdpSession(transport);
  // need to connect onMessage - design createCdpSession to register itself
  const result = await session.send("Foo.bar");
  assert.deepEqual(result, { ok: true });
});
```

- [ ] **Step 7: npm test && commit**

```bash
git commit -am "feat(ego-linux-host): CDP bridge with session attach helpers"
```

---

### Task 4: Space manager

**Files:**
- Create: `package/ego-linux-host/src/space-manager.ts`
- Create: `package/ego-linux-host/src/space-manager.test.ts`

**Interfaces:**

```ts
export type Ownership = "agent" | "agentDelegatedToUser" | "user";
export type Space = {
  taskId: string;
  id: number;
  name: string;
  createdBy: "agent" | "user";
  ownership: Ownership;
  recentTabTitles?: string[];
  targetIds: string[];
};

export class SpaceManager {
  constructor(persistPath?: string);
  async load(): Promise<void>;
  async save(): Promise<void>;
  list(): Space[]; // public records without targetIds? include for internal; strip for ego list API
  listPublic(): Array<Omit<Space, "targetIds"> & { recentTabTitles?: string[] }>;
  createAgentSpace(name: string): Space;
  use(id: number): { ok: true; space: Space } | { ok: false; error_code: string; error: string };
  claim(id: number, name?: string): Space;
  handOff(): void;
  takeOver(): void;
  completeKeep(): void;
  closeSelected(): string[]; // returns targetIds to close in Chrome
  selected(): Space | null;
  assignTarget(targetId: string, spaceId?: number): void;
  targetsForSelected(): string[];
  spaceIdForTarget(targetId: string): number | null;
  adoptOrphanTargets(targetIds: string[]): void; // unknowns → user
}
```

- [ ] **Step 1: Write tests first (full ownership matrix)**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { SpaceManager } from "./space-manager.js";

test("bootstraps user space id 1", () => {
  const sm = new SpaceManager();
  const user = sm.list().find((s) => s.id === 1);
  assert.equal(user?.ownership, "user");
  assert.equal(user?.name, "user");
});

test("createAgentSpace assigns tabs independently", () => {
  const sm = new SpaceManager();
  const a = sm.createAgentSpace("job-a");
  const b = sm.createAgentSpace("job-b");
  sm.use(a.id);
  sm.assignTarget("t1");
  sm.use(b.id);
  sm.assignTarget("t2");
  sm.use(a.id);
  assert.deepEqual(sm.targetsForSelected(), ["t1"]);
  sm.use(b.id);
  assert.deepEqual(sm.targetsForSelected(), ["t2"]);
});

test("use on user space selects but marks user control for page ops", () => {
  const sm = new SpaceManager();
  const result = sm.use(1);
  assert.equal(result.ok, true);
  assert.equal(sm.selected()?.ownership, "user");
  assert.equal(sm.isPageControlBlocked(), true);
});

test("handOff then takeOver", () => {
  const sm = new SpaceManager();
  const a = sm.createAgentSpace("x");
  sm.use(a.id);
  sm.handOff();
  assert.equal(sm.selected()?.ownership, "agentDelegatedToUser");
  assert.equal(sm.isPageControlBlocked(), true);
  sm.takeOver();
  assert.equal(sm.selected()?.ownership, "agent");
  assert.equal(sm.isPageControlBlocked(), false);
});

test("claim moves user space to agent", () => {
  const sm = new SpaceManager();
  sm.claim(1);
  assert.equal(sm.list().find((s) => s.id === 1)?.ownership, "agent");
});
```

- [ ] **Step 2: Implement SpaceManager** until all tests pass. Persist JSON `{ nextId, selectedId, spaces: [...] }` when `persistPath` set.

- [ ] **Step 3: npm test && commit**

```bash
git commit -am "feat(ego-linux-host): space manager with ownership and tab sets"
```

---

### Task 5: Snapshot engine

**Files:**
- Create: `package/ego-linux-host/src/snapshot-engine.ts`
- Create: `package/ego-linux-host/src/snapshot-engine.test.ts`
- Create: `package/ego-linux-host/src/fixtures/ax-tree-minimal.json` (minimal AX nodes)

**Interfaces:**

```ts
export type SnapshotOptions = {
  scope?: "only_within_viewport" | "full_page";
  includeActionMarks?: boolean;
  includeStableLocator?: boolean;
  maxResultLength?: number;
};
export type SnapshotResult = {
  content: string;
  refs: Array<{ id: number; backendNodeId: number; role?: string; name?: string }>;
};
export function axTreeToSnapshot(axNodes: any[], options?: SnapshotOptions): SnapshotResult;
export async function snapshotPage(
  cdp: CdpBridge,
  sessionId: string,
  options?: SnapshotOptions,
): Promise<SnapshotResult>;
```

- [ ] **Step 1: Fixture-based test**

```ts
test("axTreeToSnapshot emits refs with backendNodeId", async () => {
  const ax = JSON.parse(await readFile(new URL("./fixtures/ax-tree-minimal.json", import.meta.url), "utf8"));
  const snap = axTreeToSnapshot(ax.nodes, { includeActionMarks: true });
  assert.ok(snap.content.length > 0);
  assert.ok(snap.refs.length > 0);
  assert.equal(typeof snap.refs[0].backendNodeId, "number");
  assert.match(snap.content, /@1/);
});

test("maxResultLength truncates content", () => {
  const snap = axTreeToSnapshot(manyNodes, { maxResultLength: 1 });
  assert.ok(snap.content.length <= 1);
});
```

- [ ] **Step 2: Implement serializer** — walk AX nodes; for each interesting role (button, link, textbox, heading, StaticText, etc.) allocate sequential ref id; line format like `@1 button "Submit"`. Skip ignored/generic empty nodes.

- [ ] **Step 3: snapshotPage** — `Accessibility.enable`, `Accessibility.getFullAXTree`, map nodes, return. On failure throw `EGO_SNAPSHOT_FAILED`.

- [ ] **Step 4: npm test && commit**

```bash
git commit -am "feat(ego-linux-host): AX snapshot engine with ref map"
```

---

### Task 6: Daemon ego runtime + RPC

**Files:**
- Create: `package/ego-linux-host/src/rpc.ts`
- Create: `package/ego-linux-host/src/rpc.test.ts`
- Create: `package/ego-linux-host/src/ego-runtime.ts`
- Create: `package/ego-linux-host/src/ego-runtime.test.ts`
- Create: `package/ego-linux-host/src/host-daemon.ts`
- Create: `package/ego-linux-host/bin/ego-linux-hostd.mjs`

**Interfaces:**

```ts
// rpc.ts — newline-delimited JSON
export type RpcRequest = { id: number; method: string; params?: any };
export type RpcResponse = { id: number; result?: any; error?: { code: string; message: string } };
export type RpcEvent = { event: string; params?: any };

// ego-runtime.ts — methods matching globalThis.ego, used by daemon
export function createEgoRuntime(deps: {
  spaceManager: SpaceManager;
  getCdp: () => CdpBridge;
  ensureSession: () => Promise<string>;
}): {
  handle(method: string, params: any): Promise<any>;
  // also used to push CDP events to subscribers
};
```

RPC methods (CLI → daemon):

| method | params | result |
|---|---|---|
| `ping` | — | `{ ok: true, version }` |
| `doctor` | — | doctor object |
| `ego.listTaskSpaces` | — | ego return |
| `ego.createTaskSpace` | `{ name }` | space |
| `ego.useTaskSpace` | `{ id }` | id or error object |
| `ego.claimTaskSpace` | `{ id, name? }` | space |
| `ego.completeTaskSpace` | — | ok |
| `ego.closeTaskSpace` | — | ok |
| `ego.handOffTaskSpace` | — | ok |
| `ego.takeOverTaskSpace` | — | ok |
| `ego.listTabs` | — | `{ tabs }` |
| `ego.createTab` | `{ url }` | `{ targetId }` |
| `ego.snapshot` | options | `{ content, refs }` |
| `ego.sendCDPMessage` | `{ payload: string }` | fire-and-forget ack; responses via events |
| `reload` | — | ok |

Events daemon → CLI: `cdp.message` with `{ payload: string }`, `cdp.sendError` with `{ message, error_code? }`.

- [ ] **Step 1: rpc encode/decode tests**

- [ ] **Step 2: ego-runtime unit tests with FakeCdp + SpaceManager** — listTabs filters by space; createTab assigns; snapshot blocked when `isPageControlBlocked()`.

```ts
test("snapshot rejects under user control", async () => {
  const runtime = createEgoRuntime({ spaceManager: sm, getCdp: () => fakeCdp, ensureSession });
  sm.use(1); // user
  await assert.rejects(
    () => runtime.handle("snapshot", {}),
    (err) => err.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL",
  );
});
```

- [ ] **Step 3: Implement listTabs filtering** — get all page targets from CDP; keep those in `spaceManager.targetsForSelected()`; if selected is agent space and empty, return `[]` (not user tabs).

- [ ] **Step 4: Implement createTab** — CDP createTarget; `assignTarget`; return `{ targetId }`.

- [ ] **Step 5: Implement sendCDPMessage path** — parse JSON; if page-domain and blocked, call sendError path; else forward; bridge events → RPC events.

- [ ] **Step 6: host-daemon.ts** — `listen` on Unix socket (unlink stale sock); on connection, NDJSON lines; ensureChrome + connectCdp on start; write pid file.

- [ ] **Step 7: bin/ego-linux-hostd.mjs**

```js
#!/usr/bin/env node
import { startDaemon } from "../dist/host-daemon.js";
await startDaemon();
```

- [ ] **Step 8: Integration test without Chrome** — SpaceManager + runtime only (already unit). Optional: spawn daemon with mock — skip if heavy.

- [ ] **Step 9: npm test && commit**

```bash
git commit -am "feat(ego-linux-host): daemon RPC and ego runtime core"
```

---

### Task 7: CLI ego client + shim

**Files:**
- Create: `package/ego-linux-host/src/ego-client.ts`
- Create: `package/ego-linux-host/src/ego-client.test.ts`
- Create: `package/ego-linux-host/src/cli.ts`
- Create: `package/ego-linux-host/bin/ego-browser.mjs`

**Interfaces:**

```ts
export async function connectHost(socketPath: string): Promise<HostConnection>;
export function installEgoClient(conn: HostConnection): void; // sets globalThis.ego

export async function runCli(argv: string[], opts?: {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  harnessPath?: string;
}): Promise<number>;
```

- [ ] **Step 1: ego-client tests with mock HostConnection**

```ts
test("installEgoClient listTabs proxies to RPC", async () => {
  const calls = [];
  const conn = {
    async request(method, params) {
      calls.push([method, params]);
      if (method === "ego.listTabs") return { tabs: [] };
      return {};
    },
    onEvent() { return () => {}; },
  };
  installEgoClient(conn);
  const result = await globalThis.ego.listTabs();
  assert.deepEqual(result, { tabs: [] });
  assert.deepEqual(calls[0][0], "ego.listTabs");
});
```

- [ ] **Step 2: Implement sendCDPMessage client** — RPC `ego.sendCDPMessage`; wire `onEvent('cdp.message')` → `ego.onCDPMessage?.(payload)`.

- [ ] **Step 3: ensureHost in cli.ts**

```ts
export async function ensureHost(config: HostConfig): Promise<void> {
  if (await pingSocket(config.hostSocket)) return;
  // spawn: node bin/ego-linux-hostd.mjs detached, stdio log file
  // poll ping up to 15s
}
```

- [ ] **Step 4: Resolve harness path**

Order:
1. `EGO_HARNESS_PATH`
2. `../ego-browser/dist/out/index.js` relative to this package
3. `../ego-browser/artifacts/ego-browser/index.js` if present

If missing, run instructions: `cd package/ego-browser && npm ci && npm run build`.

- [ ] **Step 5: runCli**

```ts
// pseudo
if (argv includes --help) print help; return 0;
if (argv includes --doctor) { ensureHost; print doctor; return 0; }
if (argv includes --reload) { ensureHost; rpc reload; return 0; }
// strip leading "nodejs" if present
ensureHost(config);
const conn = await connectHost(config.hostSocket);
installEgoClient(conn);
// Dynamic import harness runMain — better: spawn node harness with ego already set is hard across processes.
// Same process:
const harness = await import(pathToFileURL(harnessPath).href);
// Harness isDirectCli may auto-run — use runMain export:
return await harness.runMain({ argv: remaining, stdin, stdout, stderr });
```

**Important:** The harness `index.js` when imported as module should **not** auto-run if `isDirectCli()` is false. Confirm: `installEgoSdk` on import may expect `globalThis.ego` already present — set ego **before** import, or only import `run.js` / call `runMain` after `installEgoClient`.

Preferred import:

```ts
const { runMain } = await import(pathToFileURL(join(egoBrowserRoot, "dist/src/run.js")).href);
// and helpers path needs ego present for browser-runtime
```

Actually helpers read `globalThis.ego` at call time, not import time. So:

```ts
installEgoClient(conn);
const { runMain } = await import(harnessRunUrl);
return await runMain({ argv: [], stdin, stdout, stderr });
```

Also set `EGO_BROWSER_AGENT_WORKSPACE` default to repo `skills/ego-browser` if unset.

- [ ] **Step 6: bin/ego-browser.mjs**

```js
#!/usr/bin/env node
import { runCli } from "../dist/cli.js";
const code = await runCli(process.argv.slice(2));
process.exit(code ?? 0);
```

- [ ] **Step 7: Unit tests for argv parsing** (`nodejs` strip, help)

- [ ] **Step 8: npm test && commit**

```bash
git commit -am "feat(ego-linux-host): ego-browser CLI shim and host client"
```

---

### Task 8: Wire end-to-end smoke (manual + opt-in automated)

**Files:**
- Create: `package/ego-linux-host/scripts/smoke.sh`
- Create: `package/ego-linux-host/src/e2e-smoke.test.ts` (skip if `EGO_LINUX_E2E` not set)

- [ ] **Step 1: Build both packages**

```bash
cd package/ego-browser && npm ci && npm run build
cd ../ego-linux-host && npm test
```

- [ ] **Step 2: smoke.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$ROOT/bin:$PATH"
# ensure node resolves bin to this package
node "$ROOT/bin/ego-browser.mjs" --doctor
node "$ROOT/bin/ego-browser.mjs" nodejs <<'EOF'
const task = await taskSpaces.useOrCreate('linux-smoke')
await browser.openOrReuseTab('https://example.com', { wait: true, timeout: 20000 })
const title = await page.title()
const snap = await page.snapshot()
if (!title) throw new Error('missing title')
if (!snap || !String(snap).trim()) throw new Error('empty snapshot')
console.log(JSON.stringify({ taskSpaceId: task.id, title, snapHead: String(snap).slice(0, 200) }, null, 2))
EOF
```

- [ ] **Step 3: Run smoke if Chrome + display available; otherwise document skip**

```bash
chmod +x package/ego-linux-host/scripts/smoke.sh
# EGO_LINUX_E2E=1 ./scripts/smoke.sh
```

- [ ] **Step 4: e2e test gates on env**

```ts
import test from "node:test";
const enabled = process.env.EGO_LINUX_E2E === "1";
test("e2e smoke example.com", { skip: !enabled }, async () => {
  // spawn smoke or inline
});
```

- [ ] **Step 5: Commit**

```bash
git commit -am "test(ego-linux-host): add smoke script and optional e2e gate"
```

---

### Task 9: Install script + skill docs

**Files:**
- Create: `skills/ego-browser/scripts/install-linux.sh`
- Modify: `skills/ego-browser/references/install.md`
- Modify: `package/ego-linux-host/README.md` (install section)

- [ ] **Step 1: install-linux.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
# 1. uname Linux
# 2. node -v major >= 22
# 3. npm ci && build ego-browser + ego-linux-host
# 4. mkdir -p ~/.local/bin ~/.local/share/ego-lite
# 5. ln -sfn "$REPO_ROOT/package/ego-linux-host/bin/ego-browser.mjs" ~/.local/bin/ego-browser
# 6. chmod +x bins
# 7. detect chrome; warn if missing
# 8. PATH check for ~/.local/bin
# 9. ego-browser --doctor || true
```

- [ ] **Step 2: Update install.md** — new section **Install steps (Linux / WSL)** pointing to `install-linux.sh`, headed/WSLg notes, headless opt-in, not the Citro DMG.

- [ ] **Step 3: Manual dry-run**

```bash
bash skills/ego-browser/scripts/install-linux.sh
command -v ego-browser
ego-browser --doctor
```

- [ ] **Step 4: Commit**

```bash
git add skills/ego-browser/scripts/install-linux.sh skills/ego-browser/references/install.md package/ego-linux-host/README.md
git commit -m "docs(ego-browser): Linux install script and install reference"
```

---

### Task 10: Hardening + doctor completeness

**Files:**
- Modify: `package/ego-linux-host/src/host-daemon.ts`
- Modify: `package/ego-linux-host/src/cli.ts`
- Modify: `package/ego-linux-host/src/chrome-supervisor.ts`

- [ ] **Step 1: doctor fields** — chromePath, chromeRunning, cdpPort, cdpUp, profileDir, socketPath, daemonPid, spaceCount, selectedSpace, headless, displayEnv, harnessPath.

- [ ] **Step 2: Stale socket recovery** — if sock exists but ping fails, unlink and restart.

- [ ] **Step 3: Chrome death** — next ensureChrome respawns; ego methods throw `EGO_BROWSER_UNAVAILABLE` with clear text.

- [ ] **Step 4: Optional `--seed-chrome`** in install only (copy Default profile dirs when source Chrome not running) — document; feature-flag if risky.

- [ ] **Step 5: Verify OSS harness tests still pass**

```bash
cd package/ego-browser && npm test
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git commit -am "fix(ego-linux-host): doctor, stale socket recovery, chrome respawn"
```

---

### Task 11: Acceptance checklist (manual)

Run against the design acceptance criteria:

- [ ] **Step 1:** `install-linux.sh` → `ego-browser` on PATH  
- [ ] **Step 2:** `ego-browser --doctor` healthy  
- [ ] **Step 3:** linux-smoke heredoc (example.com title + snapshot)  
- [ ] **Step 4:** Manual tab in browser → not visible in agent space `listTabs`  
- [ ] **Step 5:** `handOff` → snapshot errors with user-control → `takeOver` recovers  
- [ ] **Step 6:** Two spaces, disjoint tabs  
- [ ] **Step 7:** Second heredoc reuses space by name  
- [ ] **Step 8:** `package/ego-browser` `npm test` green  

- [ ] **Step 9: Final commit if docs tweaks**

```bash
git commit -am "docs(ego-linux-host): note MVP acceptance status"
```

---

## Self-review (plan vs spec)

| Spec section | Tasks |
|---|---|
| Architecture / package location | 0, 6, 7 |
| Shared profile + tab-set spaces | 2, 4 |
| globalThis.ego contract | 5, 6, 7 |
| Daemon + CLI + install | 6, 7, 9, 10 |
| Snapshot AX best-effort | 5 |
| Acceptance + phases | 8, 11 |
| Non-goals (no Playwright, no Citro UI) | Global constraints |

**Placeholder scan:** none intentional — open items from spec (RPC = NDJSON methods table above; harness path order in Task 7; content line format in Task 5) are fixed in this plan.

**Type consistency:** `Space`, `SnapshotResult`, `HostConfig` names used consistently across tasks.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-23-ego-linux-host.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks (`superpowers:subagent-driven-development`)
2. **Inline Execution** — this session with `superpowers:executing-plans`, batch with checkpoints

Which approach?
