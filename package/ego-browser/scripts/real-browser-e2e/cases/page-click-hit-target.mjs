export function pageClickHitTargetCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/?workflow=page-click-hit-target");

    await page.evaluate(() => {
      const target = document.createElement("button");
      target.id = "covered-target";
      target.textContent = "Covered target";
      target.style.cssText =
        "position:fixed;left:100px;top:100px;width:240px;height:80px;z-index:10";
      const overlay = document.createElement("button");
      overlay.id = "click-overlay";
      overlay.textContent = "Overlay";
      overlay.style.cssText =
        "position:fixed;left:80px;top:80px;width:280px;height:120px;z-index:20";
      window.__hitTargetClicks = { target: 0, overlay: 0 };
      target.addEventListener("click", () => window.__hitTargetClicks.target++);
      overlay.addEventListener("click", () => window.__hitTargetClicks.overlay++);
      document.body.append(target, overlay);
    });

    await assertRejects(
      () => page.click("#covered-target", { timeout: 500 }),
      "intercepts pointer events",
      "high-level click rejects when another element covers its action point"
    );
    assertEqual(
      JSON.stringify(await page.evaluate("window.__hitTargetClicks")),
      JSON.stringify({ target: 0, overlay: 0 }),
      "an intercepted high-level click reaches neither element"
    );

    const coveredPoint = await page.evaluate(() => {
      const rect = document.querySelector("#covered-target").getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    await page.mouse.click(coveredPoint.x, coveredPoint.y);
    assertEqual(
      (await page.evaluate("window.__hitTargetClicks")).overlay,
      1,
      "low-level coordinate click still targets the topmost element"
    );

    await page.evaluate(() => {
      setTimeout(() => document.querySelector("#click-overlay")?.remove(), 650);
    });
    await page.click("#covered-target");
    assertEqual(
      JSON.stringify(await page.evaluate("window.__hitTargetClicks")),
      JSON.stringify({ target: 1, overlay: 1 }),
      "the high-level click waits until a temporary overlay is removed"
    );

    await page.evaluate(() => {
      document.querySelector("#covered-target").remove();
      const target = document.createElement("button");
      target.id = "hover-covered-target";
      target.textContent = "Covered after hover";
      target.style.cssText =
        "position:fixed;left:100px;top:240px;width:240px;height:80px;z-index:10";
      window.__hoverCoveredClicks = { target: 0, overlay: 0 };
      target.addEventListener("mouseenter", () => {
        if (document.querySelector("#hover-overlay")) return;
        const overlay = document.createElement("button");
        overlay.id = "hover-overlay";
        overlay.textContent = "Appeared on hover";
        overlay.style.cssText =
          "position:fixed;left:80px;top:220px;width:280px;height:120px;z-index:20";
        overlay.addEventListener("click", () => window.__hoverCoveredClicks.overlay++);
        document.body.append(overlay);
      });
      target.addEventListener("click", () => window.__hoverCoveredClicks.target++);
      document.body.append(target);
    });
    await assertRejects(
      () => page.click("#hover-covered-target", { timeout: 500 }),
      "intercepts pointer events",
      "click rechecks the hit target after mouse movement"
    );
    assertEqual(
      JSON.stringify(await page.evaluate("window.__hoverCoveredClicks")),
      JSON.stringify({ target: 0, overlay: 0 }),
      "an overlay created by hover receives no click"
    );

    await page.evaluate(() => {
      document.querySelector("#hover-overlay").remove();
      document.querySelector("#hover-covered-target").remove();
      const button = document.createElement("button");
      button.id = "descendant-target";
      button.style.cssText =
        "position:fixed;left:100px;top:380px;width:240px;height:80px;z-index:10";
      button.innerHTML = '<span id="target-child">Child content</span>';
      window.__descendantClicks = 0;
      button.addEventListener("click", () => window.__descendantClicks++);
      document.body.append(button);
    });
    await page.click("#descendant-target");
    assertEqual(
      await page.evaluate("window.__descendantClicks"),
      1,
      "a descendant at the action point is a valid hit target"
    );

    await page.evaluate(() => {
      const menuItem = document.createElement("li");
      menuItem.id = "ancestor-hit-target";
      menuItem.setAttribute("role", "menuitem");
      menuItem.style.cssText =
        "position:fixed;left:100px;top:500px;width:240px;height:80px;z-index:10;list-style:none";
      const label = document.createElement("span");
      label.textContent = "Ancestor receives click";
      label.style.pointerEvents = "none";
      menuItem.append(label);
      window.__ancestorHitClicks = 0;
      menuItem.addEventListener("click", () => window.__ancestorHitClicks++);
      document.body.append(menuItem);
    });
    await page.click('text="Ancestor receives click"');
    assertEqual(
      await page.evaluate("window.__ancestorHitClicks"),
      1,
      "an interactive ancestor at the action point receives the click"
    );

    await page.evaluate(() => {
      for (const text of ["First duplicate", "Second duplicate"]) {
        const button = document.createElement("button");
        button.className = "strict-duplicate";
        button.textContent = text;
        document.body.append(button);
      }
    });
    await assertRejects(
      () => page.click("button.strict-duplicate"),
      "matched 2 elements",
      "raw CSS Page actions reject ambiguous selectors"
    );

    await page.evaluate(() => {
      const hiddenButton = document.createElement("button");
      hiddenButton.className = "usable-duplicate";
      hiddenButton.hidden = true;
      const visibleButton = document.createElement("button");
      visibleButton.className = "usable-duplicate";
      visibleButton.textContent = "Only usable action";
      visibleButton.addEventListener("click", () => window.__usableDuplicateClicks++);
      window.__usableDuplicateClicks = 0;
      document.body.append(hiddenButton, visibleButton);

      const hiddenInput = document.createElement("input");
      hiddenInput.className = "fillable-duplicate";
      hiddenInput.hidden = true;
      const visibleInput = document.createElement("input");
      visibleInput.className = "fillable-duplicate";
      visibleInput.id = "visible-fillable-duplicate";
      document.body.append(hiddenInput, visibleInput);
    });
    await page.click(".usable-duplicate");
    assertEqual(
      await page.evaluate("window.__usableDuplicateClicks"),
      1,
      "click uses the sole visible, enabled duplicate"
    );
    await page.fill(".fillable-duplicate", "filled");
    assertEqual(
      await page.evaluate("document.querySelector('#visible-fillable-duplicate').value"),
      "filled",
      "fill uses the sole visible, enabled duplicate"
    );

    await page.close();
  `;
}
