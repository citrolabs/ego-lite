export function pageSnapshotSubtreeCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/?workflow=page-snapshot-subtree");

    // Ego Lite 0.5.0.19 identifies subtree roots by backendNodeId alone. Those
    // ids are only frame-local, so keep this positive-path fixture single-frame.
    await page.evaluate(
      "document.querySelectorAll('iframe').forEach((frame) => frame.remove())"
    );

    const fullSnapshot = await page.snapshot({ scope: "full_page" });
    const rootLine = fullSnapshot
      .split("\\n")
      .find((line) => line.includes("Increment counter"));
    const rootMatch = rootLine && rootLine.match(/\\[ref=([0-9]+)/);
    assert(rootMatch, "full snapshot exposes the subtree root ref");
    const root = "@" + rootMatch[1];

    const subtree = await page.snapshot({ scope: "subtree", root });
    assertIncludes(subtree, "Increment counter", "subtree includes its root");
    assertIncludes(subtree, "Click counter", "subtree includes descendants");
    assert(
      !subtree.includes("Helper e2e fixture"),
      "subtree excludes the page heading sibling"
    );
    assert(
      !subtree.includes("Duplicate action"),
      "subtree excludes button siblings"
    );

    await page.click(root);
    assertEqual(
      await page.evaluate("window.__fixtureState.clicks"),
      1,
      "a ref returned by the subtree remains actionable"
    );

    await assertRejects(
      () => page.snapshot({ scope: "subtree" }),
      "subtree scope requires root",
      "subtree rejects a missing root"
    );
    await assertRejects(
      () => page.snapshot({ scope: "full_page", root }),
      "root is only supported when scope is subtree",
      "non-subtree scopes reject root"
    );
    await assertRejects(
      () => page.snapshot({ scope: "subtree", root: "css:#click-button" }),
      "root must be a snapshot ref",
      "subtree rejects selectors as roots"
    );
    await page.goto(baseUrl + "/nav-target");
    await assertRejects(
      () => page.snapshot({ scope: "subtree", root }),
      "ref",
      "navigation invalidates a stale subtree root ref"
    );

    await page.close();

    async function assertIframeSubtree(mode, frameLabel) {
      const framePage = await newPageAt(
        task,
        baseUrl + "/snapshot-subtree-frame-host?mode=" + mode
      );
      try {
        const actionName = "Run " + frameLabel + " subtree action";
        const frameMarker = frameLabel + " subtree content";

        await framePage.waitForSelector(
          'loc=role:button[name="' + actionName + '"]',
          { state: "visible" }
        );

        const initial = await framePage.snapshot();
        assertIncludes(
          initial,
          "Snapshot iframe host",
          frameLabel + " host is visible in the default snapshot"
        );
        assertIncludes(
          initial,
          frameMarker,
          frameLabel + " visible contents appear in the default snapshot"
        );
        const iframeLine = initial
          .split("\\n")
          .find((line) => line.trimStart().startsWith("iframe "));
        const iframeMatch = iframeLine && iframeLine.match(/\\[ref=([0-9]+)/);
        assert(iframeMatch, frameLabel + " iframe exposes a subtree root ref");
        const iframeRoot = "@" + iframeMatch[1];

        const frameSubtree = await framePage.snapshot({
          scope: "subtree",
          root: iframeRoot,
        });
        assert(
          frameSubtree
            .split("\\n")
            .some((line) => line.trimStart().startsWith("iframe ")),
          frameLabel + " subtree retains the iframe root: " + frameSubtree
        );
        assertIncludes(
          frameSubtree,
          frameMarker,
          frameLabel + " subtree includes the frame contents"
        );
        assert(
          !frameSubtree.includes("Host sibling marker"),
          frameLabel + " subtree excludes host siblings"
        );
        const actionLine = frameSubtree
          .split("\\n")
          .find((line) => line.includes(actionName));
        const actionMatch = actionLine && actionLine.match(/\\[ref=([0-9]+)/);
        assert(actionLine, frameLabel + " subtree includes its action");
        assert(
          actionMatch,
          frameLabel + " subtree returns an actionable ref: " + frameSubtree
        );

        await framePage.click("@" + actionMatch[1]);
        assertIncludes(
          await framePage.snapshot({ scope: "full_page" }),
          frameLabel + " clicked",
          frameLabel + " expanded subtree remains actionable"
        );
      } finally {
        await framePage.close();
      }
    }

    await assertIframeSubtree("same-origin", "Same-origin iframe");
    await assertIframeSubtree("cross-origin", "Cross-origin OOPIF");
  `;
}

export function pageSnapshotLazyIframeCase() {
  return `
    const task = await taskSpace(taskName);
    const lazyRun = "lazy-" + Date.now();
    const lazyPage = await newPageAt(
      task,
      baseUrl +
        "/snapshot-subtree-frame-host?mode=same-origin&lazy=true&run=" +
        lazyRun
    );
    try {
      const hasIframe = (snapshot) => snapshot
        .split("\\n")
        .some((line) => /^\\s*iframe(?:\\s|$)/.test(line));
      const lazyInitial = await lazyPage.snapshot();
      assert(
        !hasIframe(lazyInitial),
        "an offscreen native lazy iframe is absent from the initial viewport snapshot: " + lazyInitial
      );
      assertEqual(
        (await (await fetch(
          baseUrl + "/snapshot-subtree-frame-state?run=" + lazyRun
        )).json()).requests,
        0,
        "the offscreen loading=lazy iframe has not been requested"
      );
      await lazyPage.evaluate(
        "document.querySelector('#snapshot-subtree-frame').scrollIntoView()"
      );
      await lazyPage.waitForSelector(
        'loc=role:button[name="Run Same-origin iframe subtree action"]',
        { state: "visible" }
      );
      assertEqual(
        (await (await fetch(
          baseUrl + "/snapshot-subtree-frame-state?run=" + lazyRun
        )).json()).requests,
        1,
        "scrolling the lazy iframe into view loads it once"
      );
      const lazyVisible = await lazyPage.snapshot();
      assertIncludes(
        lazyVisible,
        "Same-origin iframe subtree content",
        "the loaded lazy iframe appears in a viewport snapshot"
      );
      const lazyIframeLine = lazyVisible
        .split("\\n")
        .find((line) => line.trimStart().startsWith("iframe "));
      const lazyIframeMatch =
        lazyIframeLine && lazyIframeLine.match(/\\[ref=([0-9]+)/);
      assert(lazyIframeMatch, "the visible lazy iframe exposes a subtree root ref");
      assertIncludes(
        await lazyPage.snapshot({
          scope: "subtree",
          root: "@" + lazyIframeMatch[1],
        }),
        "Same-origin iframe subtree content",
        "the lazy iframe subtree expands after loading"
      );

      await lazyPage.evaluate("window.scrollTo(0, 0)");
      const loadedOffscreen = await lazyPage.snapshot();
      assert(
        !hasIframe(loadedOffscreen) &&
          !loadedOffscreen.includes("Same-origin iframe subtree content"),
        "a loaded iframe and its contents disappear after scrolling out of the viewport: " + loadedOffscreen
      );
      assertIncludes(
        await lazyPage.snapshot({ scope: "full_page" }),
        "Same-origin iframe subtree content",
        "the offscreen frame remains loaded and observable in a full-page snapshot"
      );
      assertEqual(
        (await (await fetch(
          baseUrl + "/snapshot-subtree-frame-state?run=" + lazyRun
        )).json()).requests,
        1,
        "observing the offscreen frame does not reload it"
      );
      await lazyPage.evaluate(
        "document.querySelector('#snapshot-subtree-frame').scrollIntoView()"
      );
      assertIncludes(
        await lazyPage.snapshot(),
        "Same-origin iframe subtree content",
        "the loaded iframe reappears when scrolled back into the viewport"
      );
    } finally {
      await lazyPage.close();
    }
  `;
}

export function pageSnapshotSiblingIframeCase() {
  return `
    const task = await taskSpace(taskName);
    const siblingPage = await newPageAt(
      task,
      baseUrl +
        "/snapshot-subtree-frame-host?mode=same-origin&layout=siblings"
    );
    try {
      await siblingPage.waitForSelector(
        'loc=role:button[name="Run First sibling iframe subtree action"]',
        { state: "visible" }
      );
      await siblingPage.waitForSelector(
        'loc=role:button[name="Run Second sibling iframe subtree action"]',
        { state: "visible" }
      );
      const siblingInitial = await siblingPage.snapshot();
      const siblingRoots = siblingInitial
        .split("\\n")
        .filter((line) => line.trimStart().startsWith("iframe "))
        .map((line) => line.match(/\\[ref=([0-9]+)/))
        .filter(Boolean)
        .map((match) => "@" + match[1]);
      assertEqual(siblingRoots.length, 2, "both sibling iframe roots are visible");
      assert(
        siblingInitial.includes("First sibling iframe subtree content") &&
          siblingInitial.includes("Second sibling iframe subtree content"),
        "the default snapshot includes both visible sibling iframe subtrees"
      );
      const firstSibling = await siblingPage.snapshot({
        scope: "subtree",
        root: siblingRoots[0],
      });
      assertIncludes(
        firstSibling,
        "First sibling iframe subtree content",
        "the first sibling root expands only its own frame"
      );
      assert(
        !firstSibling.includes("Second sibling iframe subtree content"),
        "the first sibling subtree excludes the second sibling"
      );
      // No full snapshot in between: a subtree snapshot must keep the other
      // iframe root from the earlier viewport snapshot usable.
      const secondSibling = await siblingPage.snapshot({
        scope: "subtree",
        root: siblingRoots[1],
      });
      assertIncludes(
        secondSibling,
        "Second sibling iframe subtree content",
        "the second sibling root expands only its own frame"
      );
      assert(
        !secondSibling.includes("First sibling iframe subtree content"),
        "the second sibling subtree excludes the first sibling"
      );
      const firstActionLine = firstSibling
        .split("\\n")
        .find((line) =>
          line.includes("Run First sibling iframe subtree action")
        );
      const firstActionMatch =
        firstActionLine && firstActionLine.match(/\\[ref=([0-9]+)/);
      assert(firstActionMatch, "the first sibling action has a ref");
      await siblingPage.click("@" + firstActionMatch[1]);
      const siblingAfterClick = await siblingPage.snapshot();
      const siblingRootsAfterClick = siblingAfterClick
        .split("\\n")
        .filter((line) => line.trimStart().startsWith("iframe "))
        .map((line) => line.match(/\\[ref=([0-9]+)/))
        .filter(Boolean)
        .map((match) => "@" + match[1]);
      assertEqual(
        siblingRootsAfterClick.length,
        2,
        "both sibling iframe roots stay visible after the click"
      );
      assertIncludes(
        await siblingPage.snapshot({
          scope: "subtree",
          root: siblingRootsAfterClick[0],
        }),
        "First sibling iframe clicked",
        "the first sibling ref acts in the correct frame"
      );
      assertIncludes(
        await siblingPage.snapshot({
          scope: "subtree",
          root: siblingRootsAfterClick[1],
        }),
        "Second sibling iframe idle",
        "the second sibling frame remains unchanged"
      );
    } finally {
      await siblingPage.close();
    }
  `;
}

export function pageSnapshotNestedIframeCase() {
  return `
    const task = await taskSpace(taskName);
    const nestedPage = await newPageAt(
      task,
      baseUrl + "/snapshot-subtree-frame-host?mode=same-origin&layout=nested"
    );
    try {
      await nestedPage.waitForSelector(
        'loc=role:button[name="Run Nested inner iframe subtree action"]',
        { state: "visible" }
      );
      const nestedInitial = await nestedPage.snapshot();
      assertIncludes(
        nestedInitial,
        "Nested outer iframe subtree content",
        "the default snapshot includes the visible outer iframe content"
      );
      assertIncludes(
        nestedInitial,
        "Nested inner iframe subtree content",
        "the default snapshot includes the visible inner iframe content"
      );
      const innerActionLine = nestedInitial
        .split("\\n")
        .find((line) => line.includes("Run Nested inner iframe subtree action"));
      const innerActionMatch =
        innerActionLine && innerActionLine.match(/\\[ref=([0-9]+)/);
      assert(
        innerActionMatch,
        "the default snapshot exposes an inner iframe action ref"
      );
      await nestedPage.click("@" + innerActionMatch[1]);
      const afterInnerAction = await nestedPage.snapshot();
      assertIncludes(
        afterInnerAction,
        "Nested inner iframe clicked",
        "the inner viewport ref acts in its own frame"
      );
      assertIncludes(
        afterInnerAction,
        "Nested outer iframe idle",
        "the inner viewport ref leaves the outer frame unchanged"
      );
      const outerLine = afterInnerAction
        .split("\\n")
        .find((line) => line.trimStart().startsWith("iframe "));
      const outerMatch = outerLine && outerLine.match(/\\[ref=([0-9]+)/);
      assert(outerMatch, "the outer iframe exposes a subtree root ref");
      const outerSubtree = await nestedPage.snapshot({
        scope: "subtree",
        root: "@" + outerMatch[1],
      });
      assertIncludes(
        outerSubtree,
        "Nested outer iframe subtree content",
        "the outer subtree includes its own content"
      );
      assertIncludes(
        outerSubtree,
        "Nested inner iframe subtree content",
        "the outer subtree includes its nested iframe content"
      );
      const nestedIframeLines = outerSubtree
        .split("\\n")
        .filter((line) => line.trimStart().startsWith("iframe "));
      const innerMatch =
        nestedIframeLines[1] && nestedIframeLines[1].match(/\\[ref=([0-9]+)/);
      assert(innerMatch, "the expanded outer subtree exposes the inner iframe ref");
      const innerSubtree = await nestedPage.snapshot({
        scope: "subtree",
        root: "@" + innerMatch[1],
      });
      assertIncludes(
        innerSubtree,
        "Nested inner iframe subtree content",
        "the nested iframe root expands its own content"
      );
      assert(
        !innerSubtree.includes("Nested outer iframe subtree content"),
        "the nested iframe subtree excludes its outer frame ancestor"
      );
    } finally {
      await nestedPage.close();
    }
  `;
}

export function pageSnapshotReplacedIframeCase() {
  return `
    const task = await taskSpace(taskName);
    const replacedPage = await newPageAt(
      task,
      baseUrl + "/snapshot-subtree-frame-host?mode=same-origin"
    );
    try {
      await replacedPage.waitForSelector(
        'loc=role:button[name="Run Same-origin iframe subtree action"]',
        { state: "visible" }
      );
      const beforeReplacement = await replacedPage.snapshot();
      const oldFrameLine = beforeReplacement
        .split("\\n")
        .find((line) => line.trimStart().startsWith("iframe "));
      const oldFrameMatch =
        oldFrameLine && oldFrameLine.match(/\\[ref=([0-9]+)/);
      assert(oldFrameMatch, "the original iframe exposes a root ref");
      const originalSubtree = await replacedPage.snapshot({
        scope: "subtree",
        root: "@" + oldFrameMatch[1],
      });
      const oldActionLine = originalSubtree
        .split("\\n")
        .find((line) => line.includes("Run Same-origin iframe subtree action"));
      const oldActionMatch =
        oldActionLine && oldActionLine.match(/\\[ref=([0-9]+)/);
      assert(oldActionMatch, "the original iframe action exposes a ref");
      await replacedPage.evaluate(() => {
        const previous = document.querySelector("#snapshot-subtree-frame");
        const replacement = document.createElement("iframe");
        replacement.id = "snapshot-subtree-frame";
        replacement.title = "Replacement subtree frame";
        replacement.width = previous.width;
        replacement.height = previous.height;
        replacement.src =
          "/snapshot-subtree-frame-content?mode=same-origin&frame=replacement";
        previous.replaceWith(replacement);
      });
      await replacedPage.waitForSelector(
        'loc=role:button[name="Run Replacement iframe subtree action"]',
        { state: "visible" }
      );
      await assertRejects(
        () => replacedPage.click("@" + oldActionMatch[1]),
        "Stale ref",
        "an iframe replacement invalidates its former descendant refs"
      );
      const afterReplacement = await replacedPage.snapshot();
      assertIncludes(
        afterReplacement,
        "Replacement iframe subtree content",
        "the default snapshot includes the replacement iframe contents"
      );
      assert(
        !afterReplacement.includes("Same-origin iframe subtree content"),
        "the default snapshot excludes the detached iframe contents"
      );
      const replacementLine = afterReplacement
        .split("\\n")
        .find((line) => line.trimStart().startsWith("iframe "));
      const replacementMatch =
        replacementLine && replacementLine.match(/\\[ref=([0-9]+)/);
      assert(replacementMatch, "the replacement iframe exposes a fresh root ref");
      assertIncludes(
        await replacedPage.snapshot({
          scope: "subtree",
          root: "@" + replacementMatch[1],
        }),
        "Replacement iframe subtree content",
        "a fresh snapshot expands the replacement iframe"
      );
    } finally {
      await replacedPage.close();
    }
  `;
}

export function pageSnapshotIframeViewportCase() {
  return `
    const task = await taskSpace(taskName);
    for (const [mode, frameLabel] of [
      ["same-origin", "Same-origin iframe"],
      ["cross-origin", "Cross-origin OOPIF"],
    ]) {
      const page = await newPageAt(
        task,
        baseUrl + "/snapshot-subtree-frame-host?mode=" + mode
      );
      try {
        const actionName = "Run " + frameLabel + " subtree action";
        const actionLocator = 'loc=role:button[name="' + actionName + '"]';
        await page.waitForSelector(actionLocator, { state: "visible" });

        if (mode === "cross-origin") {
          const targets = (await task.cdp("Target.getTargets")).targetInfos;
          assert(
            targets.some((target) =>
              target.type === "iframe" &&
              target.parentId === page.targetId &&
              target.url.includes("/snapshot-subtree-frame-content")
            ),
            "the cross-origin fixture runs in an OOPIF target"
          );
        }
        const initial = await page.snapshot();
        assertIncludes(
          initial,
          frameLabel + " subtree content",
          frameLabel + " visible contents appear in the default snapshot"
        );
        const actionLine = initial
          .split("\\n")
          .find((line) => line.includes(actionName));
        const actionMatch = actionLine && actionLine.match(/\\[ref=([0-9]+)/);
        assert(actionLine, frameLabel + " viewport includes its action: " + initial);
        assert(
          actionMatch,
          frameLabel + " viewport returns an actionable ref: " + initial
        );

        await page.click("@" + actionMatch[1]);
        assertIncludes(
          await page.snapshot(),
          frameLabel + " clicked",
          frameLabel + " viewport action works without a full-page snapshot"
        );
        cliLog({ frame: frameLabel, verifiedAction: "snapshot ref" });
      } finally {
        await page.close();
      }
    }
  `;
}
