# Clearing cookies, cache, and storage

Read this file before clearing any cookie, cache, or storage. These commands look interchangeable but differ in how far they reach. A task space picks a browser profile when it is created, and that profile's cookie jar and HTTP cache are shared with the user's own tabs and with every other task space on the same profile. Measured from inside an agent space on a default profile: the current page saw 1 cookie, the profile held 3478 across 1161 domains.

## What each command reaches

| Command                                           | Reaches               | Getting the state back |
| ------------------------------------------------- | --------------------- | ---------------------- |
| `Network.deleteCookies`                           | one named cookie      | sign in to that site   |
| `Storage.clearDataForOrigin`                      | one origin            | sign in to that site   |
| `Page.reload` with `ignoreCache: true`            | one Page load         | nothing was lost       |
| `Network.clearBrowserCookies`                     | **the whole profile** | **nothing you can do** |
| `Network.clearBrowserCache`                       | **the whole profile** | **nothing you can do** |
| `Storage.clearCookies` without `browserContextId` | **the whole profile** | **nothing you can do** |

The three profile-wide commands take no scope parameter. There is no narrower way to call them, so reach for a different command rather than a different argument.

Once a profile-wide clear has run you cannot undo it: the agent has no way to recover the sessions it destroyed, and every site on that profile is signed out. Do not run one intending to restore the state afterwards.

## The entry point does not limit the scope

`page.cdp()` selects which target session carries the command. It does not limit what the command touches. `Network.clearBrowserCookies` can only be sent through a Page session — the Network domain does not exist on the browser-level connection — yet it empties the profile's entire cookie jar. A command sent "through this Page" is not a command scoped to this Page.

Do not read a rejection from one entry point as permission to use another. If `task.cdp()` refuses a command, sending the same command through `page.cdp()` does not make it safer; it reaches exactly as far.

## Recipes

Sign-in wall or a session you want anonymous — clear that one site, not the profile:

```js
await page.cdp("Storage.clearDataForOrigin", {
  origin: new URL(await page.url()).origin,
  storageTypes: "cookies",
});
```

A stale document or a resource that will not reload — reload past the cache instead of emptying it:

```js
await page.cdp("Page.reload", { ignoreCache: true });
```

To drop one site's Cache API entries and service workers, use `storageTypes: "cache_storage,service_workers"` with the same `Storage.clearDataForOrigin` call.

One specific cookie, such as a stale session or search id:

```js
const { cookies } = await page.cdp("Network.getAllCookies");
for (const c of cookies.filter((c) => c.domain.includes("example.com"))) {
  await page.cdp("Network.deleteCookies", {
    name: c.name,
    domain: c.domain,
    path: c.path,
  });
}
```

`Network.deleteCookies` removes `httpOnly` cookies, which `document.cookie` cannot. Needing to clear an `httpOnly` cookie is not a reason to widen the scope to the whole profile.

## Profile-wide clears need user approval

Treat the three profile-wide commands the way you treat `claimTaskSpace()` and `takeOverTaskSpace()`: only after user approval. Before asking, confirm a scoped command cannot do the job — clearing one site's data is almost always what a single-site problem calls for.

When you do need one, tell the user what it costs before running it: how many cookies and domains the profile holds (`Network.getAllCookies`), and which other task spaces share the profile (`listTaskSpaces()` entries carry `profileId` when the runtime reports it). Signing the user out of every site on that profile is not something the agent can put back, and the user may not connect the loss to this task.
