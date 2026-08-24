const fixture = process.env.FIXTURE_URL;
const HOST = "document.getElementById('ego-agent-cursor-overlay')";
const SHADOW = `${HOST}.__egoShadow`;
const probe = (expression) => page.evaluate(expression);

await page.goto(fixture);
await page.waitForLoadState();

const center = await page.elementCenter("loc=css:#click-button");
await page.mouse.click(center.x, center.y, { label: "counting" });

// The overlay is drawn fire-and-forget so it can never delay an action, which
// means the injection may still be in flight when the click returns.
for (let attempt = 0; attempt < 40; attempt += 1) {
  if (await probe(`!!${HOST}`)) break;
  await page.waitForTimeout(50);
}

console.log("1. overlay present:      " + (await probe(`!!${HOST}`)));

const transform = await probe(`${SHADOW}.getElementById('pointer').style.transform`);
// Drop the function name before reading the numbers — translate3d carries a 3.
const args = String(transform).replace(/^[^(]*\(/, "");
const [x, y] = (args.match(/-?[\d.]+/g) || []).map(Number);
console.log(
  "2. cursor tracks click:  " +
    (Math.abs(x - center.x) < 1 && Math.abs(y - center.y) < 1) +
    ` (${transform} vs ${center.x},${center.y})`,
);

console.log("3. badge text:           " + (await probe(`${SHADOW}.getElementById('text').textContent`)));

// The load-bearing property: pointer-events:none, so the harness's own
// elementFromPoint hit-tests (wheel and drag fallbacks) still see the page.
console.log("4. hit test at cursor:   " + (await probe(`document.elementFromPoint(${center.x}, ${center.y}).id`)));
console.log("5. click still landed:   " + (await probe("document.getElementById('count').textContent")));

const snap = await page.snapshotRaw({ scope: "full_page" });
console.log("6. overlay in snapshot:  " + snap.content.includes("ego-agent-cursor"));

// A wheel carries coordinates that default to (0, 0) but moves no pointer:
// following them would snap the cursor into the corner on every scroll.
// The move first is not decoration: the snapshot above started a read sweep,
// which walks the cursor along the page for its own reasons, and this would
// otherwise measure that instead of the wheel.
await page.mouse.move(center.x, center.y);
await page.waitForTimeout(300);
const beforeWheel = await probe(`${SHADOW}.getElementById('pointer').style.transform`);
await page.mouse.wheel(0, 200);
await page.waitForTimeout(200);
const afterScroll = await probe(`${SHADOW}.getElementById('pointer').style.transform`);
console.log("7. cursor held on wheel: " + (afterScroll === beforeWheel));

// Press and release are asserted apart, because a click's own press lasts 25ms
// — the held floor is what makes it visible, not something a test can catch.
const pressState = () => probe(`${SHADOW}.getElementById('pointer').className`);
await page.mouse.move(center.x, center.y);
await page.mouse.down();
await page.waitForTimeout(80);
console.log("8. pressed on down:      " + ((await pressState()) === "press"));

await page.mouse.up();
await page.waitForTimeout(400);
console.log("9. released on up:       " + ((await pressState()) === ""));

// The cursor marks the element it is working on, so it has to travel with that
// element when the page scrolls — not stay pinned to the screen.
const onScreen = () =>
  probe(`(() => {
    const r = ${SHADOW}.getElementById('arrow').getBoundingClientRect();
    return Math.round(r.top);
  })()`);
// The fixture is shorter than the viewport, so give it somewhere to scroll to.
await page.evaluate("document.body.style.minHeight = '2400px'");
const beforeScroll = await onScreen();
await page.evaluate("window.scrollTo(0, 220)");
await page.waitForTimeout(250);
const afterScrollTop = await onScreen();
console.log(
  "10. travels with page:   " +
    (Math.abs(beforeScroll - afterScrollTop - 220) <= 2) +
    ` (${beforeScroll} -> ${afterScrollTop})`,
);
await page.evaluate("window.scrollTo(0, 0)");
await page.waitForTimeout(250);

// The shape and the label both come from whatever is under the cursor.
const shownShape = () =>
  probe(`[...${SHADOW}.querySelectorAll('svg.shape.on')].map(s => s.id).join()`);
const badgeText = () => probe(`${SHADOW}.getElementById('text').textContent`);

// A plain <button> is `cursor: default` in every browser — the link is what
// actually asks for a hand, and the overlay follows the page rather than
// inventing its own idea of what looks clickable.
const link = await page.elementCenter("loc=css:a");
await page.mouse.move(link.x, link.y);
await page.waitForTimeout(200);
console.log("11. hand over a link:    " + (await shownShape()));
console.log("12. names what it is on: " + (await badgeText()));

const field = await page.elementCenter("loc=css:#name-input");
await page.mouse.move(field.x, field.y);
await page.waitForTimeout(200);
console.log("13. beam over a field:   " + (await shownShape()));

// fill() dispatches no pointer event, so this is the one action that would
// otherwise happen entirely unannounced.
await page.locator("#name-input").fill("Ada");
await page.waitForTimeout(200);
console.log("14. says it is typing:   " + (await badgeText()));
console.log("15. marks the field:     " + (await probe(`${SHADOW}.getElementById('ring').className`)));
await page.waitForTimeout(1000);
console.log("16. lets go when done:   " + (await probe(`${SHADOW}.getElementById('ring').className`) === ""));

// The highlighter: a marker an agent draws to explain something, rather than a
// real selection, which would fight its own work on the page.
const bandCount = () => probe(`${SHADOW}.getElementById('bands').children.length`);
const byText = await ego.highlight("must survive the snapshot", { note: "explaining this" });
await page.waitForTimeout(500);
console.log("17. highlight lines:     " + byText.lines);
console.log("18. bands drawn:         " + (await bandCount()));
console.log("19. note in badge:       " + (await badgeText()));

await ego.highlight("h1", { note: "the heading" });
await page.waitForTimeout(600);
console.log(
  "20. band matches text:   " +
    (await probe(`(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('h1'));
      const want = range.getBoundingClientRect();
      const band = ${SHADOW}.getElementById('bands').children[0].getBoundingClientRect();
      return Math.round(Math.abs(band.width - want.width)) + ',' + Math.round(Math.abs(band.left - want.left));
    })()`)),
);

const miss = await ego.highlight("no such words appear anywhere on this page");
console.log("21. miss draws nothing:  " + (miss.done === false && miss.lines === 0));

await ego.clearHighlight();
await page.waitForTimeout(200);
console.log("22. cleared:             " + ((await bandCount()) === 0));

// Reading is most of what an agent does and it dispatches no input at all, so
// a sweep is the only thing that tells a watcher what was taken in. It runs
// itself inside the page, which is why this waits rather than awaits.
await page.snapshotRaw({ scope: "full_page" });
await page.waitForTimeout(300);
console.log("23. says what it reads:  " + (await badgeText()));
console.log("24. marks the lines:     " + ((await bandCount()) > 0));

// Real input outranks the narration of a read that has already happened —
// including a move back to where the harness last left the cursor.
await page.mouse.move(center.x, center.y);
await page.waitForTimeout(150);
const sweepDone = await probe(`document.getElementById('ego-agent-cursor-overlay').__egoSweep.done`);
console.log("25. input ends the read: " + sweepDone);

// The trail the Spaces panel reads: transitions, not events, so a burst of
// keystrokes is one entry rather than sixty.
const trail = await probe(`(() => {
  const log = document.getElementById('ego-agent-cursor-overlay').__egoLog || [];
  return log.map(e => e.text).join(' | ');
})()`);
console.log("26. trail:               " + trail);

// The cursor marks the element it is working on, so a long scroll carries it
// off the screen entirely — and the window went blank while the agent worked.
// The badge is what stays behind, docked to the edge and pointing back at it.
await page.evaluate("document.body.style.minHeight = '3000px'");
await page.mouse.move(center.x, center.y);
await page.waitForTimeout(250);
await page.evaluate("window.scrollTo(0, 1400)");
await page.waitForTimeout(250);
const docked = JSON.parse(
  await probe(`(() => {
    const badge = ${SHADOW}.getElementById('badge').getBoundingClientRect();
    const arrow = ${SHADOW}.getElementById('arrow').getBoundingClientRect();
    return JSON.stringify({
      gone: arrow.bottom < 0,
      onScreen:
        badge.top >= 0 && badge.left >= 0 &&
        badge.bottom <= innerHeight && badge.right <= innerWidth,
      hint: ${SHADOW}.getElementById('hint').textContent,
      // Being in the right place is not the same as being drawn there. The
      // pointer is a composited layer sitting at a page coordinate, and one
      // scrolled out of view is not rasterised at all — a badge parented to it
      // measures perfectly and paints nothing.
      independent: !${SHADOW}.getElementById('pointer')
        .contains(${SHADOW}.getElementById('badge')),
    });
  })()`),
);
console.log("27. cursor leaves view:  " + docked.gone);
console.log("28. badge stays in it:   " + docked.onScreen);
console.log("29. and points back:     " + docked.hint);
console.log("30. drawn independently: " + docked.independent);

// A nudge between two fields and a jump across the page should not take the
// same time; one duration for both made the first crawl and the second snap.
await page.evaluate("window.scrollTo(0, 0)");
await page.waitForTimeout(250);
const moveFor = async (x, y) => {
  await page.mouse.move(x, y);
  await page.waitForTimeout(80);
  return parseInt(await probe(`${SHADOW}.getElementById('pointer').style.transitionDuration`), 10);
};
await moveFor(center.x, center.y);
const near = await moveFor(center.x + 6, center.y);
const far = await moveFor(30, 30);
console.log("31. motion scales:       " + (near < far) + ` (${near}ms vs ${far}ms)`);
