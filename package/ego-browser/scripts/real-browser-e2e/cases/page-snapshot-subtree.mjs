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

// CITRO-5220: a backend node id is only unique within one renderer process, and
// native snapshot prefers the main document when a root id exists in both. A
// subtree rooted at a ref inside a cross-origin iframe must therefore name the
// ref's frame, or it expands an unrelated host node.
export function pageSnapshotFrameRootCollisionCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(
      task,
      baseUrl + "/snapshot-subtree-frame-host?mode=cross-origin"
    );
    try {
      await page.waitForSelector(
        'loc=role:button[name="Run Cross-origin OOPIF subtree action"]',
        { state: "visible" }
      );

      const frameTarget = (await task.cdp("Target.getTargets")).targetInfos.find(
        (target) =>
          target.type === "iframe" &&
          target.parentId === page.targetId &&
          target.url.includes("/snapshot-subtree-frame-content")
      )?.targetId;
      assert(frameTarget, "the cross-origin fixture runs in an OOPIF target");
      const frameSession = (
        await cdp("Target.attachToTarget", {
          targetId: frameTarget,
          flatten: true,
        })
      ).sessionId;
      const frameEvaluate = async (expression) => {
        const evaluated = await cdp(
          "Runtime.evaluate",
          { expression, returnByValue: false },
          frameSession
        );
        if (evaluated.exceptionDetails) {
          throw new Error("frame evaluation failed: " + expression);
        }
        return evaluated.result;
      };
      // DOM.getDocument numbers every node of the session's own document; an
      // out-of-process frame's document is not part of the host's tree. Only a
      // rendered host node can shadow a snapshot root, because the snapshot
      // leaves out what the page does not render.
      const hostNodeIds = async () => {
        const { root } = await page.cdp("DOM.getDocument", { depth: -1 });
        const rendered = new Set();
        let max = 0;
        const pending = [{ node: root, shown: true }];
        while (pending.length > 0) {
          const { node, shown } = pending.pop();
          max = Math.max(max, node.backendNodeId);
          const attributeNames = (node.attributes || []).filter(
            (_, index) => index % 2 === 0
          );
          const nodeShown =
            shown &&
            !["HEAD", "SCRIPT", "STYLE"].includes(node.nodeName) &&
            !attributeNames.includes("hidden");
          if (nodeShown && (node.nodeType === 1 || node.nodeType === 3)) {
            rendered.add(node.backendNodeId);
          }
          for (const child of node.children || []) {
            pending.push({ node: child, shown: nodeShown });
          }
        }
        return { max, rendered };
      };

      // Each renderer process hands out backend node ids from its own counter,
      // and either process may have been reused, so the two counters start
      // anywhere. Add filler nodes to whichever document is behind until a new
      // in-frame button receives an id a rendered host node already carries.
      const maxFiller = 50000;
      let rootName = null;
      let backendNodeId = null;
      for (let round = 1; round <= 6 && rootName === null; round++) {
        const candidateName = "Frame collision root " + round;
        const candidate = await frameEvaluate(
          "(() => {" +
            "const button = document.createElement('button');" +
            "button.type = 'button';" +
            "button.textContent = 'Collide';" +
            "button.setAttribute('aria-label', " + JSON.stringify(candidateName) + ");" +
            "button.addEventListener('click', () => { button.dataset.clicked = 'true'; });" +
            "document.querySelector('main').append(button);" +
            "return button;" +
          "})()"
        );
        const candidateId = (
          await cdp(
            "DOM.describeNode",
            { objectId: candidate.objectId },
            frameSession
          )
        ).node.backendNodeId;

        let hostIds = await hostNodeIds();
        const idsAbove = () =>
          [...hostIds.rendered].filter((id) => id > candidateId);
        if (!hostIds.rendered.has(candidateId) && idsAbove().length === 0) {
          // The host is behind: hidden nodes take its counter to just below
          // the candidate, then a few rendered paragraphs cover the id itself.
          const hiddenFillers = Math.max(0, candidateId - hostIds.max - 4);
          assert(
            hiddenFillers <= maxFiller,
            "the host needs " + hiddenFillers + " filler nodes"
          );
          await page.evaluate((count) => {
            const hidden = document.createElement("div");
            hidden.hidden = true;
            for (let index = 0; index < count; index++) {
              hidden.append(document.createElement("span"));
            }
            const shown = document.createElement("div");
            for (let index = 0; index < 8; index++) {
              const filler = document.createElement("p");
              filler.textContent = "Host collision filler";
              shown.append(filler);
            }
            document.body.append(hidden, shown);
          }, hiddenFillers);
          hostIds = await hostNodeIds();
        }
        if (hostIds.rendered.has(candidateId)) {
          rootName = candidateName;
          backendNodeId = candidateId;
          break;
        }
        // The frame is behind: burn its ids up to the next one a rendered host
        // node uses, so that the next candidate button lands on it.
        const nextHostId = Math.min(...idsAbove());
        const fillers = nextHostId - candidateId - 1;
        assert(
          Number.isFinite(fillers) && fillers <= maxFiller,
          "the frame needs " + fillers + " filler nodes"
        );
        await frameEvaluate(
          "(() => {" +
            "const box = document.createElement('div');" +
            "box.hidden = true;" +
            "for (let index = 0; index < " + fillers + "; index++) {" +
            "  box.append(document.createElement('span'));" +
            "}" +
            "document.body.append(box);" +
          "})()"
        );
        await cdp("DOM.getDocument", { depth: -1 }, frameSession);
      }
      assert(
        rootName !== null,
        "an in-frame button shares its backendNodeId with a rendered host node"
      );
      cliLog({ collidingBackendNodeId: backendNodeId, root: rootName });

      const fullSnapshot = await page.snapshot({ scope: "full_page" });
      const rootLine = fullSnapshot
        .split("\\n")
        .find((line) => line.includes(rootName));
      const rootMatch = rootLine && rootLine.match(/\\[ref=([0-9]+)/);
      assert(
        rootMatch,
        "the full-page snapshot exposes the in-frame button ref: " + fullSnapshot
      );

      const subtree = await page.snapshot({
        scope: "subtree",
        root: "@" + rootMatch[1],
      });
      assertIncludes(
        subtree,
        rootName,
        "the subtree expands the in-frame root, not the host node with the same id"
      );
      assert(
        !subtree.includes("Host collision filler") &&
          !subtree.includes("Host sibling marker"),
        "the in-frame subtree contains no host document content: " + subtree
      );

      const actionLine = subtree
        .split("\\n")
        .find((line) => line.includes(rootName));
      const actionMatch = actionLine && actionLine.match(/\\[ref=([0-9]+)/);
      assert(
        actionMatch,
        "the in-frame subtree returns an actionable ref: " + subtree
      );
      await page.click("@" + actionMatch[1]);
      assertEqual(
        await js(
          "return [...document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === " +
            JSON.stringify(rootName) +
            ")?.dataset.clicked",
          frameTarget
        ),
        "true",
        "a ref from the in-frame subtree acts inside the iframe"
      );
    } finally {
      await page.close();
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
