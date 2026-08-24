const fixture = process.env.FIXTURE_URL;

await page.goto(fixture);
await page.waitForLoadState();

const info = await page.info();
console.log("URL:      " + info.url);
console.log("TITLE:    " + info.title);

const tabs = await browser.listTabs();
console.log("TABS:     " + tabs.length + " (active: " + tabs.filter((t) => t.active).length + ")");

const snap = await page.snapshotRaw({ scope: "full_page", includeStableLocator: true });
console.log("REFS:     " + snap.refs.length);
console.log("--- SNAPSHOT ---");
console.log(snap.content);
