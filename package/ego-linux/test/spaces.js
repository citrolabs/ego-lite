const fixture = process.env.FIXTURE_URL;

const alpha = await taskSpaces.useOrCreate("port smoke alpha");
console.log("1. created:      " + JSON.stringify({ id: alpha.id, name: alpha.name, ownership: alpha.ownership }));

await page.goto(fixture);
await page.waitForLoadState();
console.log("2. alpha page:   " + (await page.title()));

const beta = await taskSpaces.useOrCreate("port smoke beta");
console.log("3. second space: " + JSON.stringify({ id: beta.id, name: beta.name }));
await page.goto("about:blank#beta");
console.log("4. beta page:    " + (await page.url()));

// Switching back must put the agent on alpha's page again. Note this asserts
// where the agent lands, not a per-space tab list — listTabs is browser-wide on
// this port (see README).
await taskSpaces.switch(alpha.id);
console.log("5. back in alpha:" + (await page.title()));

console.log("6. list:         " + JSON.stringify((await taskSpaces.list()).map((s) => ({ id: s.id, name: s.name, ownership: s.ownership }))));

// Handing off flips ownership the way the native overlay does.
await taskSpaces.handOff(alpha.id);
console.log("7. after handOff:" + JSON.stringify((await taskSpaces.list()).map((s) => s.ownership)));

await taskSpaces.complete(alpha.id, { keep: false });
await taskSpaces.complete(beta.id, { keep: false });
console.log("8. after cleanup:" + JSON.stringify(await taskSpaces.list()));
