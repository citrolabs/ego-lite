# Site plugins

Site plugins let an Agent read sites with a fixed UI through maintained
scripts instead of writing extraction code on the spot. Plugins run inside the
heredoc like every other helper, so the whole feature lives in this
repository; the launcher that embeds the SDK needs no change.

```js
const task = await taskSpace("research");
const page = task.page("p1");
const { posts } = await page.runPlugin("x/timeline", {
  user: "nasa",
  limit: 20,
});
```

## Agent workflow

1. The Agent opens a page as usual.
2. If a Page used in that round is on a site with a plugin, the round output
   ends with an `[ego-browser:plugins]` hint showing the exact call and
   result shape. Each task space sees the hint for a plugin once.
3. The Agent calls `page.runPlugin(...)` in its next round. Discovery
   therefore adds no tool call compared with working without plugins.

`plugins(urlOrHost | { query })` lists every visible plugin, its commands,
arguments, and result shapes. Set `EGO_BROWSER_PLUGIN_HINTS=0` to turn hints
off.

## Errors

Every failure is a `PluginError` with a `code` and a `Next:` line:

| Code                    | Meaning                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `INVALID_ARGS`          | Arguments do not match the manifest; the message lists them.                                      |
| `PLUGIN_NOT_FOUND`      | Unknown plugin id or command.                                                                     |
| `NOT_LOGGED_IN`         | The site needs the user to sign in.                                                               |
| `RATE_LIMITED`          | The site is throttling.                                                                           |
| `NOT_FOUND`             | The requested item does not exist.                                                                |
| `TIMEOUT`               | The command exceeded `{ timeout }` (default 120 s).                                               |
| `SITE_CHANGED`          | The site no longer matches the plugin, including results that fail the declared `returns` schema. |
| `PLUGIN_REVOKED`        | The version was withdrawn.                                                                        |
| `PLUGIN_BROKEN`         | The plugin threw unexpectedly or its installed files were modified.                               |
| `PLUGIN_INSTALL_FAILED` | Download, verification, or consent failed.                                                        |

On `SITE_CHANGED` from an official plugin, the runtime refreshes the official
index immediately, installs a newer version within the same major version if
one exists, and retries once. Otherwise the Agent falls back to snapshots and
its own code.

## Sources and precedence

| Source                  | Location                                           | Updates                            |
| ----------------------- | -------------------------------------------------- | ---------------------------------- |
| Local                   | `~/.ego-browser/plugins/local/<dir>/`              | Loaded as-is, reloaded when edited |
| Installed               | `~/.ego-browser/plugins/installed/<id>/<version>/` | See below                          |
| Official, not installed | Official index                                     | Installed silently on first use    |

A plugin id resolves to the local copy first, then the installed version, then
the official index. A third-party plugin cannot use an official id.

### Official plugins

The official index is the bundled baseline shipped with the SDK
(`dist/out/official-plugins/`, built from [`ego-plugins/`](../ego-plugins))
merged with the network copy from `citrolabs/ego-plugins`. The runtime
fetches the network copy at most once every 24 hours, when a plugin is used or
a hint is computed; a failure falls back to the cache and the bundled baseline.

Installed official plugins update automatically to the newest version within
their major version. `pinPlugin(id, version?)` stops that,
`unpinPlugin(id)` resumes it, `updatePlugin(id?)` updates now (crossing
major versions), and `rollbackPlugin(id)` returns to the previous version and
pins it.

### Third-party plugins

`installPlugin(source, { allowThirdParty: true })` installs from an absolute
directory, a bundle URL, a `.git` URL, or `github:owner/repo[/path][#ref]`.
Without `allowThirdParty` the call fails with an explanation; the Skill tells
Agents to pass it only when the user explicitly asked for that plugin. Users
can also clone a plugin into the local directory and update it with
`git pull`. Third-party plugins never update automatically;
`updatePlugin(id)` re-fetches from the recorded origin.

## Trust model

A plugin has exactly the power of the Agent's own script: it receives the
caller's Page, the TaskSpace, and every helper. There is no sandbox and no
permission prompt. Safety comes from the source:

- Official plugins are reviewed in `citrolabs/ego-plugins` and released after
  a human approval.
- Every installed version records an integrity hash in `lock.json`. The
  runtime re-hashes installed files before each run; a modified official
  plugin is reinstalled, a modified third-party plugin refuses to run.
- `revoked.json` in the official index withdraws versions by id, version, or
  integrity hash. It applies to official, third-party, and local plugins.
  Index and bundle signing are planned.

## Files

```text
~/.ego-browser/plugins/            EGO_BROWSER_PLUGIN_HOME overrides
  package.json                     {"type":"module"} for .js entries
  installed/<id>/<version>/        active and previous versions
  local/<dir>/                     local plugins
  lock.json                        active version, source, origin, integrity, pin
  index-cache.json                 last network index and fetch time
  hints-seen.json                  hints already shown per task space
```

`EGO_BROWSER_PLUGIN_INDEX` overrides the network index URL (`off` disables
it); `EGO_BROWSER_PLUGIN_BUNDLED_INDEX` overrides the bundled index path.

## Manifest

```json
{
  "id": "x",
  "version": "1.0.0",
  "engines": { "egoPluginApi": 1 },
  "domains": ["x.com", "twitter.com"],
  "commands": {
    "timeline": {
      "entry": "timeline.mjs",
      "description": "Recent posts from a profile.",
      "readOnly": true,
      "args": {
        "type": "object",
        "properties": { "user": { "type": "string" } }
      },
      "returns": { "type": "object", "required": ["posts"] }
    }
  }
}
```

`domains` drive hints and `plugins(url)`; they do not restrict what the plugin
can open. `args` and `returns` use a JSON Schema subset: `type`, `enum`,
`const`, `default`, `properties`, `required`, `additionalProperties`,
`items`, `minItems`, `maxItems`, `minimum`, `maximum`, `minLength`,
`maxLength`, `pattern`, and `anyOf`. See [`ego-plugins/README.md`](../ego-plugins/README.md)
for authoring guidance.
