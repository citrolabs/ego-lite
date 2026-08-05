# Task-space isolation *and* inherited logins, without forking Chromium

`package/ego-linux/README.md` currently states the constraint this way:

> A native Space is isolated *and* inherits your login state. On stock Chromium
> those two properties pull apart:
>
> - `Target.createBrowserContext` → real isolation, but an empty cookie jar
> - a separate window → your real logins, but no isolation
>
> Login inheritance wins, because that is what agent tasks actually depend on.

The first half is right: a fresh browser context does start with an empty jar.
The conclusion does not follow, because **the jar can be filled**. Measured on
Chrome 148, both properties are available at the same time.

## What was measured

Reproduce with the scripts in `docs/experiments/`. Both connect straight to
Chrome's DevTools browser endpoint, because the harness promotes only `Target`
and `Browser` domain calls to the browser level — a `Storage.setCookies` sent
through `cdp()` lands on a page session, where `browserContextId` is rejected
with *"browserContextId is only allowed for Browser target"*. That routing
detail is what makes this look impossible from inside a heredoc.

`docs/experiments/context-seeding-mechanism.mjs`:

```
1. cookies in fresh context: 0        (scoped read works)
2. after scoped setCookies: 1 cookie, marker present: true
3. page inside the context sees it: true
4. leaked into default context: false (isolation intact)
```

`docs/experiments/context-seeding-scale.mjs`, against the real profile:

```
real jar: 2038 cookies
seeded: 2038 of 2038 in 105ms
distinct name+domain not carried over: 0
default jar unchanged: true
```

So: full-size login state transfers into an isolated context in about a tenth of
a second, a page loaded in that context genuinely sees the cookies, and nothing
leaks back into the default jar.

## What this changes

A task space could own a browser context instead of just a window, and seed it
from the default jar at creation. That yields what the native macOS Space has —
isolation plus the user's logins — on stock Chromium.

## What it does not solve

Be precise about the difference from native, because it is not nothing:

- **The login state is a copy, taken at seed time.** The native Space shares live
  state; here, logging into a site inside one space does not appear in the
  others, and a session refreshed in the default profile does not propagate.
  For agent tasks this is usually the desired behaviour, but it is a difference,
  not parity.
- **Cookies are not all of login state.** `localStorage`, IndexedDB and service
  workers are per-origin storage that this does not carry. Sites holding tokens
  outside cookies will still land logged out. Worth measuring before promising
  users a clean result.
- **Seeding cost scales with the jar**, ~105 ms at 2038 cookies. Per space, at
  creation, this is unlikely to matter — but it is not free.

## Suggested implementation

In `package/ego-linux/src/task-spaces.mjs`, when creating a space:

1. `Target.createBrowserContext` → keep `browserContextId` in the space record.
2. `Storage.getCookies` (browser level, unscoped) → the default jar.
3. `Storage.setCookies` (browser level, with `browserContextId`) → seed it.
4. `Target.createTarget` with `browserContextId` for the space's tabs.
5. `Target.disposeBrowserContext` when the space is closed.

Step 3 needs a browser-level escape hatch in the shim's CDP routing, since
`Storage` is not in the promoted set today.

This also makes `browser.listTabs()` filterable per space for free: targets
created in a context report that context, which is the other documented Linux
divergence.

Migration note: existing spaces have no context id. Treat a missing id as
"window-only space" and keep the current behaviour for them, so upgrading does
not strand live spaces.
