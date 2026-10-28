export function pageRefIdentityCase() {
  return String.raw`
    const task = await taskSpace(taskName);
    for (const scope of ['subtree', 'only_within_viewport']) {
      const page = await newPageAt(task, baseUrl + '/nav-target');
      try {
        await page.evaluate((offscreen) => {
          document.body.innerHTML = '<button id="first" aria-label="First ref action">First ref action</button><button id="second" aria-label="Second ref action">Second ref action</button>';
          window.__refClicks = { first: 0, second: 0 };
          for (const id of ['first', 'second']) {
            document.getElementById(id).onclick = () => window.__refClicks[id]++;
          }
          if (offscreen) {
            document.body.style.height = '2000px';
            document.getElementById('first').style.cssText = 'position:absolute;top:1500px';
          }
        }, scope === 'only_within_viewport');
        const full = await page.snapshot({ scope: 'full_page' });
        const refFor = (snapshot, name) => {
          const line = snapshot.split('\n').find((line) => line.includes(name));
          const match = line && line.match(/\[ref=(\d+)/);
          assert(match, 'snapshot exposes ' + name + ': ' + snapshot);
          return '@' + match[1];
        };
        const firstRef = refFor(full, 'First ref action');
        const secondRef = refFor(full, 'Second ref action');
        const partial = await page.snapshot({ scope, ...(scope === 'subtree' ? { root: secondRef } : {}) });
        assertEqual(refFor(partial, 'Second ref action'), secondRef, scope + ' preserves the second button ref');
        assert(!partial.includes('First ref action'), scope + ' omits the first button');
        await page.click(firstRef);
        await page.click(secondRef);
        const clicks = await page.evaluate(() => window.__refClicks);
        assertEqual(clicks.first, 1, scope + ' keeps the omitted first ref bound to the first button');
        assertEqual(clicks.second, 1, scope + ' preserves the second ref after clicking the first button');
      } finally {
        await page.close();
      }
    }
  `;
}

export function pageRefPrepareRoundCase() {
  return String.raw`
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + '/nav-target');
    await page.evaluate(() => {
      document.body.innerHTML = '<button id="first" aria-label="First round action">First round action</button><button id="second" aria-label="Second round action">Second round action</button><input aria-label="Cell address"><output></output><select aria-label="Sort homes"><option value="recommended">Recommended</option><option value="list_price_asc">Price (low to high)</option></select>';
      window.__refClicks = { first: 0, second: 0 };
      for (const id of ['first', 'second']) document.getElementById(id).onclick = () => window.__refClicks[id]++;
      document.querySelector('input').onkeydown = (event) => {
        if (event.key === 'Enter') document.querySelector('output').textContent = event.target.value;
      };
      document.getElementById('first').onclick = () => {
        window.__refClicks.first++;
        const input = document.querySelector('input');
        input.replaceWith(input.cloneNode(true));
      };
    });
    const initial = await page.snapshot();
    const line = initial.split('\n').find((line) => line.includes('Second round action'));
    const match = line && line.match(/\[ref=(\d+)/);
    assert(match, 'initial snapshot publishes the second button ref');
    const subtree = await page.snapshot({ scope: 'subtree', root: '@' + match[1] });
    const published = subtree.split('\n').find((line) => line.includes('Second round action')).match(/\[ref=(\d+)/);
    assert(published, 'the final snapshot publishes a ref for the second button');
    const input = initial.split('\n').find((line) => line.includes('Cell address')).match(/\[ref=(\d+)/);
    assert(input, 'the initial snapshot publishes the cell address input');
    const sort = initial.split('\n').find((line) => line.includes('Sort homes')).match(/\[ref=(\d+)/);
    assert(sort, 'the initial snapshot publishes the sorting select');
    // Redfin reads available options after snapshot and consumes the ref in the next CLI invocation.
    const options = await page.evaluate(() => [...document.querySelector('select').options].map((option) => option.value));
    assert(options.includes('list_price_asc'), 'evaluate reads the available sort options');
    await writeFile(join(tempDir, 'page-ref-round.json'), JSON.stringify({ label: page.label, ref: '@' + published[1], inputRef: '@' + input[1], sortRef: '@' + sort[1] }));
  `;
}

export function pageRefResumeRoundCase() {
  return String.raw`
    const saved = JSON.parse(await readFile(join(tempDir, 'page-ref-round.json'), 'utf8'));
    const task = await taskSpace(taskName);
    const page = task.page(saved.label);
    try {
      await page.waitForTimeout(4_000);
      assertEqual((await page.selectOption(saved.sortRef, 'list_price_asc'))[0], 'list_price_asc', 'the first action after read-only evaluate reuses the original select ref');
      assertEqual(await page.evaluate(() => document.querySelector('select').value), 'list_price_asc', 'the original select receives the requested sort');
      await page.click(saved.ref);
      await page.fill(saved.inputRef, 'M2');
      await page.press(saved.inputRef, 'Enter');
      const clicks = await page.evaluate(() => window.__refClicks);
      assertEqual(clicks.second, 1, 'the published subtree ref still clicks the second button in a new round');
      assertEqual(clicks.first, 0, 'restoring a ref never renumbers it to the first button');
      assertEqual(await page.evaluate(() => document.querySelector('output').textContent), 'M2', 'fill and press reuse the same input ref across rounds');
      await page.click(saved.ref);
      assertEqual(await page.evaluate(() => window.__refClicks.second), 2, 'read-only evaluate preserves the same ref within a round');

      await page.snapshot();
      await page.evaluate(() => document.getElementById('first').click());
      await assertRejectsAny(() => page.fill(saved.inputRef, 'wrong node', { timeout: 300 }), 'a replaced input cannot inherit its predecessor ref');
      assertEqual(await page.evaluate(() => document.querySelector('input').value), 'M2', 'the same-name replacement receives no input');
      await page.click(saved.ref);
      assertEqual(await page.evaluate(() => window.__refClicks.second), 3, 'evaluate replacing another node preserves the unchanged button ref');

      await page.snapshot();
      const destination = baseUrl + '/nav-target?after-evaluate';
      await page.evaluate((url) => { location.href = url; }, destination);
      await page.waitForURL(destination);
      await assertRejects(() => page.click(saved.ref), 'Stale ref', 'evaluate navigation rejects refs from the previous document');
    } finally {
      await page.close();
    }
  `;
}
