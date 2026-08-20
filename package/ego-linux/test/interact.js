const fixture = process.env.FIXTURE_URL;
const read = (id) => page.evaluate(`document.getElementById('${id}').textContent`);
const value = (id) => page.evaluate(`document.getElementById('${id}').value`);

await page.goto(fixture);
await page.waitForLoadState();

const snap = await page.snapshotRaw({ scope: "full_page" });
const refOf = (predicate) => snap.refs.find(predicate)?.backendNodeId;
const buttonRef = refOf(
  (ref) => ref.role === "button" && String(ref.name).includes("Increment counter"),
);
console.log("1. button ref:            " + buttonRef);

// The ref-map contract: @N must resolve to real page coordinates.
const center = await page.elementCenter("@" + buttonRef);
console.log("2. @ref center:           " + JSON.stringify(center));

// Pointer path: a real CDP-synthesised click at those coordinates.
await page.mouse.click(center.x, center.y);
console.log("3. after mouse click:     " + (await read("count")));

// Stable locator emitted by the snapshot must resolve back.
const locCenter = await page.elementCenter("loc=css:#click-button");
console.log("4. loc=css center:        " + JSON.stringify(locCenter));

// Playwright-style locator, auto-waiting click.
await page.locator("#click-button").click();
console.log("5. after locator click:   " + (await read("count")));

await page.locator("#name-input").fill("Vikt");
console.log("6. locator fill:          " + (await value("name-input")));

// Refs inside the deeply nested iframe.
const deepRef = refOf((ref) => String(ref.name).includes("Deep button"));
console.log("7. deep iframe ref:       " + JSON.stringify(await page.elementCenter("@" + deepRef)));

// getByRole over the accessible names the snapshot reports.
console.log("8. getByRole count:       " + (await page.getByRole("button", { name: "Increment counter" }).count()));

const shot = await page.screenshot();
console.log("9. screenshot:            " + shot);

console.log("10. tabs:                 " + JSON.stringify(await browser.listTabs()));
