export function pageOopifActionCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/?page-api=oopif");
    const initialFrameState = await page.evaluate(() => {
      const frame = document.querySelector("#fixture-frame");
      frame.style.cssText =
        "display:block;margin-top:1600px;width:500px;height:300px";
      window.__rootWheelEvents = [];
      window.addEventListener(
        "wheel",
        (event) => window.__rootWheelEvents.push({
          deltaY: event.deltaY,
          trusted: event.isTrusted,
        }),
        { passive: true }
      );
      return {
        frameTop: frame.getBoundingClientRect().top,
        viewportHeight: innerHeight,
      };
    });
    assert(
      initialFrameState.frameTop > initialFrameState.viewportHeight,
      "the cross-site iframe starts below the viewport"
    );
    const snapshot = await page.snapshot({ scope: "full_page" });
    assertIncludes(snapshot, "Run iframe action", "snapshot includes cross-site iframe content");
    assertIncludes(snapshot, "Iframe field", "snapshot includes the iframe input");
    await page.click('loc=role:button[name="Run iframe action"]');
    await page.fill('loc=css:#iframe-field', "filled through Page");

    const outerScrollState = await page.evaluate(() => ({
      scrollY,
      wheelEvents: window.__rootWheelEvents,
    }));
    assert(outerScrollState.scrollY > 0, "Page actions scroll the iframe owner into view");
    assert(
      outerScrollState.wheelEvents.length > 0 &&
        outerScrollState.wheelEvents.every((event) => event.trusted),
      "the outer document receives trusted wheel input"
    );

    const frame = (await task.cdp("Target.getTargets")).targetInfos.find(
      (target) =>
        target.type === "iframe" &&
        target.parentId === page.targetId &&
        target.url.includes("/frame.html")
    )?.targetId;
    assert(frame, "the cross-site iframe remains addressable after Page actions");
    assertEqual(
      await js("return document.querySelector('#iframe-result')?.textContent", frame),
      "clicked:true",
      "Page.click dispatches a trusted click in the iframe session"
    );
    assertEqual(
      await js("return document.querySelector('#iframe-field')?.value", frame),
      "filled through Page",
      "Page.fill writes through the iframe session"
    );

    const sameOrigin = await newPageAt(task, baseUrl + "/same-origin-frame");
    assertIncludes(
      await sameOrigin.snapshot({ scope: "full_page" }),
      "Run iframe action",
      "snapshot includes same-process iframe content"
    );
    await sameOrigin.evaluate(() => {
      const frame = document.querySelector("#fixture-frame");
      frame.style.cssText =
        "position:fixed;left:20px;top:80px;width:500px;height:300px;z-index:20";
      const covered = document.createElement("button");
      covered.id = "covered-frame-duplicate";
      covered.textContent = "Run iframe action";
      covered.style.cssText =
        "position:fixed;left:100px;top:120px;width:220px;height:60px;z-index:10";
      covered.addEventListener("click", () => covered.dataset.clicked = "true");
      document.body.append(covered);
    });
    await sameOrigin.click('text="Run iframe action"');
    await sameOrigin.fill('loc=css:#iframe-field', "same process");
    const sameOriginState = await sameOrigin.evaluate(() => {
      const frame = document.querySelector("#fixture-frame");
      return {
        coveredClicked: document.querySelector("#covered-frame-duplicate")?.dataset.clicked,
        result: frame?.contentDocument?.querySelector("#iframe-result")?.textContent,
        value: frame?.contentDocument?.querySelector("#iframe-field")?.value,
      };
    });
    assertEqual(
      sameOriginState.coveredClicked,
      undefined,
      "the covered top-document duplicate is not clicked"
    );
    assertEqual(sameOriginState.result, "clicked:true", "Page.click works in a same-process iframe");
    assertEqual(sameOriginState.value, "same process", "Page.fill works in a same-process iframe");
    await sameOrigin.close();
    await writeFile(
      join(tempDir, "oopif-page.json"),
      JSON.stringify({ label: page.label })
    );
  `;
}

export function pageOopifRestoreCase() {
  return `
    const task = await taskSpace(taskName);
    const saved = JSON.parse(
      await readFile(join(tempDir, "oopif-page.json"), "utf8")
    );
    const page = task.page(saved.label);
    const snapshot = await page.snapshot({ scope: "full_page" });
    assertIncludes(snapshot, "Run iframe action", "a later round observes the iframe");
    await page.click('text="Run iframe action"');

    const frame = (await task.cdp("Target.getTargets")).targetInfos.find(
      (target) =>
        target.type === "iframe" &&
        target.parentId === page.targetId &&
        target.url.includes("/frame.html")
    )?.targetId;
    assert(frame, "the restored Page keeps its cross-site iframe target");
    assertEqual(
      await js("return document.querySelector('#iframe-result')?.textContent", frame),
      "clicked:true",
      "the restored Page routes the iframe action to the child session"
    );
    await page.close();
    await assertRejects(
      () => page.snapshot(),
      "page " + page.label + " was closed",
      "closing the Page retires its OOPIF-capable handle"
    );
  `;
}
