export function pageActionMotionCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/?workflow=page-action-motion");

    await page.evaluate(() => {
      window.__motionActions = {
        visibleClicks: 0,
        offscreenClicks: 0,
        visibleClickTrusted: false,
        offscreenClickTrusted: false,
        visibleInputTrusted: false,
        offscreenInputTrusted: false,
        wheelEvents: 0,
      };
      const state = window.__motionActions;
      const animate = (element) => element.animate(
        [
          { transform: "translateX(-4px)" },
          { transform: "translateX(4px)" },
        ],
        { duration: 600, iterations: Infinity, direction: "alternate" },
      );

      const visibleButton = document.createElement("button");
      visibleButton.id = "continuously-moving-button";
      visibleButton.textContent = "Continuously moving action";
      visibleButton.style.cssText =
        "position:fixed;left:80px;top:80px;width:240px;height:64px;z-index:20";
      visibleButton.addEventListener("click", (event) => {
        state.visibleClicks += 1;
        state.visibleClickTrusted ||= event.isTrusted;
      });

      const visibleInput = document.createElement("input");
      visibleInput.id = "continuously-moving-field";
      visibleInput.style.cssText =
        "position:fixed;left:80px;top:180px;width:240px;height:40px;z-index:20";
      visibleInput.addEventListener("input", (event) => {
        state.visibleInputTrusted ||= event.isTrusted;
      });

      const spacer = document.createElement("div");
      spacer.style.height = "2200px";
      const offscreenButton = document.createElement("button");
      offscreenButton.id = "wheel-animated-button";
      offscreenButton.textContent = "Wheel animated action";
      offscreenButton.style.cssText = "width:240px;height:64px";
      offscreenButton.addEventListener("click", (event) => {
        state.offscreenClicks += 1;
        state.offscreenClickTrusted ||= event.isTrusted;
      });
      const offscreenInput = document.createElement("input");
      offscreenInput.id = "wheel-animated-field";
      offscreenInput.style.cssText = "display:block;width:240px;height:40px;margin-top:24px";
      offscreenInput.addEventListener("input", (event) => {
        state.offscreenInputTrusted ||= event.isTrusted;
      });

      let wheelAnimationStarted = false;
      document.addEventListener("wheel", () => {
        state.wheelEvents += 1;
        if (wheelAnimationStarted) return;
        wheelAnimationStarted = true;
        animate(offscreenButton);
        animate(offscreenInput);
      }, true);

      document.body.append(
        visibleButton,
        visibleInput,
        spacer,
        offscreenButton,
        offscreenInput,
      );
      animate(visibleButton);
      animate(visibleInput);
    });

    await page.click("#continuously-moving-button");
    await page.fill("#continuously-moving-field", "visible motion");
    await page.click("#wheel-animated-button");
    await page.fill("#wheel-animated-field", "wheel motion");

    const result = await page.evaluate(() => ({
      ...window.__motionActions,
      visibleValue: document.querySelector("#continuously-moving-field").value,
      offscreenValue: document.querySelector("#wheel-animated-field").value,
    }));
    assertEqual(result.visibleClicks, 1, "click accepts a moving element while its current point is safe");
    assertEqual(result.offscreenClicks, 1, "click revalidates a wheel-animated element");
    assertEqual(result.visibleValue, "visible motion", "fill does not require a static rectangle");
    assertEqual(result.offscreenValue, "wheel motion", "fill survives wheel-triggered motion");
    assert(
      result.visibleClickTrusted && result.offscreenClickTrusted &&
        result.visibleInputTrusted && result.offscreenInputTrusted,
      "motion-tolerant actions still reach the page as trusted input"
    );
    assert(result.wheelEvents > 1, "the offscreen action uses trusted wheel motion");
    await page.close();
  `;
}
