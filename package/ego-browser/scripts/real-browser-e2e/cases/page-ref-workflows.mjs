export function pageRefDialogWorkflowCase() {
  return String.raw`
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + '/nav-target');
    try {
      await page.evaluate(() => {
        document.body.innerHTML = '<section role="dialog" tabindex="0" aria-label="Edit saved link"><button id="category" aria-label="Choose category">Choose category</button><output id="category-result"></output><input id="name" aria-label="Link name"><input id="url" aria-label="Link URL"><button id="save" aria-label="Save link">Save link</button></section><output id="result"></output>';
        document.querySelector('#category').onclick = () => {
          document.querySelector('#category').setAttribute('aria-pressed', 'true');
          document.querySelector('#category-result').textContent = 'Category selected';
        };
        document.querySelector('#save').onclick = () => {
          document.querySelector('#result').textContent = JSON.stringify({
            name: document.querySelector('#name').value,
            url: document.querySelector('#url').value,
          });
          document.querySelector('[role="dialog"]').remove();
        };
      });
      const snapshot = await page.snapshot({ scope: 'full_page' });
      const refFor = (name) => {
        const line = snapshot.split('\n').find((line) => line.includes('"' + name + '"') && line.includes('[ref='));
        const match = line && line.match(/\[ref=(\d+)/);
        assert(match, 'snapshot publishes ' + name + ': ' + snapshot);
        return '@' + match[1];
      };
      const dialogRef = refFor('Edit saved link');
      const categoryRef = refFor('Choose category');
      const nameRef = refFor('Link name');
      const urlRef = refFor('Link URL');
      const saveRef = refFor('Save link');

      // Redfin's filter and Expedia's calendar keep their root while selection changes.
      await page.click(categoryRef);
      assertIncludes(
        await page.snapshot({ scope: 'subtree', root: dialogRef }),
        'Category selected',
        'an input action does not invalidate the unchanged dialog root'
      );

      // Bookmark forms fill multiple fields and save using refs from one snapshot.
      await page.fill(nameRef, 'agent-favorites');
      await page.fill(urlRef, baseUrl + '/nav-target');
      await page.click(saveRef);
      const result = await page.evaluate(() => ({
        saved: JSON.parse(document.querySelector('#result').textContent),
        dialogOpen: Boolean(document.querySelector('[role="dialog"]')),
      }));
      assertEqual(result.saved.name, 'agent-favorites', 'the saved link uses the first ref field');
      assertEqual(result.saved.url, baseUrl + '/nav-target', 'the saved link uses the second ref field');
      assertEqual(result.dialogOpen, false, 'the original save ref submits and closes the dialog');
    } finally {
      await page.close();
    }
  `;
}

export function pageRefFailedActionPrepareCase() {
  return String.raw`
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + '/nav-target');
    await page.evaluate(() => {
      document.body.innerHTML = '<button>Duplicate action</button><button>Duplicate action</button><input aria-label="Bookmark search"><button id="menu" aria-label="Result menu">Result menu</button><output id="query"></output><output id="hover"></output>';
      window.__duplicateClicks = 0;
      for (const button of document.querySelectorAll('button:not(#menu)')) {
        button.onclick = () => window.__duplicateClicks++;
      }
      document.querySelector('input').oninput = (event) => {
        document.querySelector('#query').textContent = event.target.value;
      };
      document.querySelector('#menu').onmouseenter = () => {
        document.querySelector('#hover').textContent = 'Menu ready';
      };
    });
    const snapshot = await page.snapshot();
    const refFor = (name) => {
      const line = snapshot.split('\n').find((line) => line.includes('"' + name + '"') && line.includes('[ref='));
      const match = line && line.match(/\[ref=(\d+)/);
      assert(match, 'snapshot publishes ' + name + ': ' + snapshot);
      return '@' + match[1];
    };
    const saved = { label: page.label, searchRef: refFor('Bookmark search'), menuRef: refFor('Result menu') };

    // RockAuto ambiguity and bookmark locator misses must not poison published refs.
    await assertRejects(
      () => page.click('loc=role:button[name="Duplicate action"]'),
      'matched 2 elements',
      'an ambiguous action still reports its locator error'
    );
    await assertRejects(
      () => page.fill('loc=css:#missing-search', 'unused', { timeout: 300 }),
      'matched 0 elements',
      'a missing input still reports its locator timeout'
    );
    // No snapshot/evaluate after the failed actions: the next CLI invocation consumes these refs.
    await writeFile(join(tempDir, 'page-ref-failed-action.json'), JSON.stringify(saved));
  `;
}

export function pageRefFailedActionResumeCase() {
  return String.raw`
    const saved = JSON.parse(await readFile(join(tempDir, 'page-ref-failed-action.json'), 'utf8'));
    const task = await taskSpace(taskName);
    const page = task.page(saved.label);
    try {
      await page.focus(saved.searchRef);
      await page.keyboard.type('agent-video-research-picks');
      await page.hover(saved.menuRef);
      const result = await page.evaluate(() => ({
        query: document.querySelector('#query').textContent,
        hover: document.querySelector('#hover').textContent,
        duplicateClicks: window.__duplicateClicks,
      }));
      assertEqual(result.query, 'agent-video-research-picks', 'the first ref action after failed resolution reaches the original input');
      assertEqual(result.hover, 'Menu ready', 'raw keyboard input preserves the next ref target');
      assertEqual(result.duplicateClicks, 0, 'failed resolution never chooses an ambiguous target');
    } finally {
      await page.close();
    }
  `;
}

export function pageRefUploadPrepareCase() {
  return String.raw`
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + '/nav-target');
    await page.evaluate(() => {
      document.body.innerHTML = '<input aria-label="Cell address"><output id="address"></output><section id="upload-dialog" role="dialog" aria-label="Upload file"><input id="file" type="file" hidden><button id="browse" aria-label="Browse file">Browse file</button></section><output id="uploaded"></output>';
      document.querySelector('[aria-label="Cell address"]').onkeydown = (event) => {
        if (event.key === 'Enter') document.querySelector('#address').textContent = event.target.value;
      };
      document.querySelector('#browse').onclick = () => document.querySelector('#file').click();
      document.querySelector('#file').onchange = (event) => {
        document.querySelector('#uploaded').textContent = event.target.files[0].name;
        document.querySelector('#upload-dialog').remove();
      };
    });
    const snapshot = await page.snapshot({ scope: 'full_page' });
    const refFor = (name) => {
      const line = snapshot.split('\n').find((line) => line.includes('"' + name + '"') && line.includes('[ref='));
      const match = line && line.match(/\[ref=(\d+)/);
      assert(match, 'snapshot publishes ' + name + ': ' + snapshot);
      return '@' + match[1];
    };
    const addressRef = refFor('Cell address');
    const browseRef = refFor('Browse file');
    const chooserPromise = page.waitForFileChooser({ timeout: 5_000 });
    await page.click(browseRef);
    const chooser = await chooserPromise;
    await chooser.setFiles(uploadPath);
    await page.waitForSelector('#upload-dialog', { state: 'hidden', timeout: 5_000 });
    // Sheets retains its background address node after the upload dialog disappears.
    await writeFile(join(tempDir, 'page-ref-upload.json'), JSON.stringify({
      label: page.label,
      addressRef,
      fileName: (await import('node:path')).basename(uploadPath),
    }));
  `;
}

export function pageRefUploadResumeCase() {
  return String.raw`
    const saved = JSON.parse(await readFile(join(tempDir, 'page-ref-upload.json'), 'utf8'));
    const task = await taskSpace(taskName);
    const page = task.page(saved.label);
    try {
      await page.fill(saved.addressRef, 'M2');
      await page.press(saved.addressRef, 'Enter');
      const result = await page.evaluate(() => ({
        address: document.querySelector('#address').textContent,
        uploaded: document.querySelector('#uploaded').textContent,
        dialogOpen: Boolean(document.querySelector('#upload-dialog')),
      }));
      assertEqual(result.address, 'M2', 'the pre-upload ref still fills and commits the cell address in a new CLI invocation');
      assertEqual(result.uploaded, saved.fileName, 'the native file chooser delivered the selected file');
      assertEqual(result.dialogOpen, false, 'the upload removed its dialog without replacing the address input');
    } finally {
      await page.close();
    }
  `;
}
