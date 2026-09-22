# Use a Local Runtime with Ego Lite

Ego Lite installs the `ego-browser` CLI and provides the native browser bridge.
This repository builds the JavaScript runtime that the CLI can load for a
single command:

```text
Installed Ego Lite CLI
  -> --sdk-path
  -> local dist/out/index.js
  -> Ego Lite and Chromium
```

The override is temporary. It does not modify the installed application.

## Build

Ego Lite must be installed and onboarding must be complete. The examples below
assume that `ego-browser` on `PATH` belongs to Ego Lite.

From the repository root:

```bash
cd package/ego-browser
npm ci
npm run build
```

The runtime is written to `package/ego-browser/dist/out/index.js`. Run
`npm run build` again after changing runtime source code.

## Run with the local runtime

Use the CLI installed by Ego Lite and pass the absolute bundle path:

```bash
cd package/ego-browser

ego-browser nodejs --sdk-path "$PWD/dist/out/index.js" <<'EOF'
if (!globalThis.ego) throw new Error('Ego Lite native bindings are unavailable')
process.stdout.write('Local runtime loaded successfully\n')
EOF
```

For browser automation, keep the same command and write the heredoc using the
API documented by the current checkout in `package/ego-browser/skill/GUIDE.md`.

Every manual invocation needs `--sdk-path`; it is not a persistent setting.
Do not use `npm link` or replace files inside the Ego Lite application bundle.
The installed CLI is still required to provide the native browser environment.

## Verify against the real browser

Run the real-browser E2E suite:

```bash
cd package/ego-browser
npm run e2e
```

The suite builds the current worktree and automatically runs it through the
Ego Lite CLI with `--sdk-path`. On macOS it prefers the app's stable
`Versions/Current` helper path, so another installed Ego product cannot silently
take over the test. Set `EGO_BROWSER_REAL_E2E_CLI` to use another installation.
This is the preferred end-to-end compatibility check. `npm test` remains useful
for repository tests but does not replace the real-browser check.

The command is self-contained: it starts its own local fixture server, creates a
uniquely named temporary task space, and cleans both up. No manual SDK linking,
task-space selection, takeover, or browser interaction is part of a successful
run. A fresh agent can use this command without any context from an earlier
debugging session.

## Keep the guide aligned

The usage guide describes the APIs implemented by the runtime. Agents read it
with `ego-browser skill`, which prints the guide bundled next to the SDK the
command selected. A guide from another release may generate helper calls that
the local runtime does not support.

`ego-browser skill` picks the guide in this order:

1. `--skill-dir <dir>` on that command.
2. `EGO_BROWSER_SKILL_DIR`.
3. The `ego-browser/` directory next to the selected SDK. When the debug SDK
   entry or `--sdk-path` points at `dist/out/index.js`, this is
   `dist/out/ego-browser/`, so the guide follows the local build.
4. The guide bundled with Ego Lite.

To edit the guide without rebuilding, point the override at the source:

```bash
export EGO_BROWSER_SKILL_DIR="$PWD/skill"
ego-browser skill | head -1
```

The first output line names the directory the guide came from. Unset the
variable or remove the debug SDK entry to return to the bundled guide. Without
an Ego Lite build that provides `ego-browser skill`, run the renderer directly:
`node dist/out/skill.js [topic]`.

## Troubleshooting

- **`ego-browser` not found:** finish Ego Lite onboarding and add its CLI
  directory, commonly `~/.local/bin`, to `PATH`.
- **Multiple Ego products are installed:** set `EGO_BROWSER_REAL_E2E_CLI` to
  the intended Ego Lite helper. The E2E output prints the selected CLI path.
- **`--sdk-path` unsupported:** update Ego Lite to a build that supports loading
  an external runtime.
- **Changes are not visible:** rebuild and confirm that the absolute SDK path
  points to the intended checkout.
- **Browser APIs are missing:** align the Skill with the checkout, then run
  `npm run e2e` to check app/runtime compatibility.
