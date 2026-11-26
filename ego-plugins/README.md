# Official ego-browser site plugins

Site plugins are maintained scripts that read a site with a fixed UI, such as
x.com or Wikipedia, and return structured data. Agents call them with
`page.runPlugin("x/timeline", { user: "nasa" })` instead of writing extraction
code against a snapshot every time.

This directory is the source of the official plugins. It is laid out the way
the `citrolabs/ego-plugins` repository serves them, and every SDK build also
ships the current versions as the offline baseline index
(`dist/out/official-plugins/`). The runtime and the trust model are described
in [docs/site-plugins.md](../docs/site-plugins.md).

| Plugin      | Commands                                |
| ----------- | --------------------------------------- |
| `x`         | `timeline`, `search`, `post`, `profile` |
| `wikipedia` | `article`, `search`, `summary`          |

## Layout

```text
ego-plugins/
  plugins/<id>/ego-plugin.json   manifest: id, version, domains, commands
  plugins/<id>/*.mjs             command entries and shared modules
  revoked.json                   withdrawn versions (the kill switch)
  scripts/build-index.mjs        builds dist/index.json and dist/bundles/
```

Build the index with `node scripts/build-index.mjs [outDir]`. Published
bundles are kept, so an old version stays installable after a newer release;
rebuilding a published version with different content fails, which forces a
version bump.

## Writing a plugin

A command entry exports one async function. It receives validated arguments
(with defaults applied) and the same helpers an Agent script has, plus the
caller's Page:

```js
export default async function timeline(args, { page, task, fail }) {
  await page.goto(`https://x.com/${args.user}`);
  // ...
  if (signedOut) fail("NOT_LOGGED_IN", "x.com asks to sign in");
  return { posts };
}
```

- Use only the v2 TaskSpace/Page API. Functions passed to `page.evaluate()`
  run in the page and must be self-contained.
- Declare `args` and `returns` as JSON Schema in the manifest. The runtime
  rejects bad arguments before the plugin runs, and treats a result that no
  longer matches `returns` as `SITE_CHANGED`. Make required fields strict
  enough that a redesigned page fails validation instead of returning empty
  strings.
- Report known situations with `fail(code, message)`: `NOT_LOGGED_IN`,
  `RATE_LIMITED`, `NOT_FOUND`, `SITE_CHANGED`, `INVALID_ARGS`. Any other
  exception becomes `PLUGIN_BROKEN`.
- Bump the patch version for a fix, the minor version for additions, and the
  major version when args or returns change incompatibly. Installed plugins
  update automatically only within the same major version.
- Mark every command `readOnly: true` unless it changes data on the site.

To try a plugin without publishing it, put its directory under
`~/.ego-browser/plugins/local/`. Local plugins take precedence over installed
ones and reload when their files change.

## Review and release

Changes to official plugins need a review by a CODEOWNERS maintainer. A
release builds the index and publishes `dist/` after a human approval. To
withdraw a version, add `{ "id", "versions": [...], "reason" }` to
`revoked.json` and publish; clients refuse to run it on their next index sync,
and installed official plugins move to the newest non-revoked version.
