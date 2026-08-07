/**
 * Keep the browser window the size of the viewport the agent is emulating.
 *
 * Emulation.setDeviceMetricsOverride changes the page's viewport and nothing
 * else, so an agent working at a phone width renders a 390px layout inside a
 * 1280px window — a narrow strip of site with a wide band of empty chrome
 * beside it. Watching someone work like that is the problem: it looks broken,
 * and screenshots of it are mostly blank.
 *
 * Resizing is best-effort and deliberately quiet. It is cosmetic, it races the
 * agent's own actions, and no automation result may depend on it. CDP input
 * carries emulated-viewport coordinates, not screen coordinates, so a resize
 * landing mid-action cannot move a click.
 */

/** Chrome's own frame around the page: tab strip, toolbar, bookmarks. */
const CHROME_HEIGHT = 132;

/**
 * Windows narrower than this are not worth following: Chrome clamps very small
 * widths anyway, and a sliver of a window is harder to watch than a wide one.
 */
const MIN_WIDTH = 360;

/** At or above this the emulation is desktop-shaped; the window goes back. */
const DESKTOP_WIDTH = 1000;

export function createWindowFit(cdp) {
  let applied = null;
  // The size the window had before the first shrink, so leaving a phone
  // viewport can put it back. Without this the window stays phone-shaped for
  // the rest of the session — the emulation ends, the narrow window does not.
  let original = null;

  async function windowFor(targetId) {
    const { windowId } = await cdp.call("Browser.getWindowForTarget", { targetId });
    return windowId;
  }

  async function restore(targetId) {
    if (!original) return;
    try {
      const windowId = await windowFor(targetId);
      await cdp.call("Browser.setWindowBounds", {
        windowId,
        bounds: { ...original, windowState: "normal" },
      });
      original = null;
      applied = null;
    } catch {
      // Same rule as shrinking: cosmetic, never fatal.
    }
  }

  return {
    /**
     * @param {{width?: number, height?: number, mobile?: boolean}} metrics
     * @param {string|null} targetId The tab the emulation applies to.
     */
    async follow(metrics, targetId) {
      if (!targetId) return;
      const width = Number(metrics?.width);
      const height = Number(metrics?.height);

      // Clearing the override (0x0) or emulating a desktop both mean "stop
      // being phone-shaped".
      const emulatingPhone =
        Number.isFinite(width) &&
        Number.isFinite(height) &&
        width >= MIN_WIDTH &&
        width < DESKTOP_WIDTH;

      if (!emulatingPhone) {
        await restore(targetId);
        return;
      }

      const key = `${targetId}:${width}x${height}`;
      if (key === applied) return;

      try {
        const windowId = await windowFor(targetId);
        if (!original) {
          const { bounds } = await cdp.call("Browser.getWindowBounds", { windowId });
          if (bounds) {
            original = { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
          }
        }
        await cdp.call("Browser.setWindowBounds", {
          windowId,
          bounds: {
            width: Math.round(width),
            height: Math.round(height + CHROME_HEIGHT),
            windowState: "normal",
          },
        });
        // Only now: a resize that failed has to be retryable, and marking it
        // done beforehand would wedge the window at whatever size it was.
        applied = key;
      } catch {
        // A tab that closed, a window the compositor refuses to resize, a
        // headless browser with no window at all — none of it is a failure of
        // the action the agent was performing.
      }
    },
  };
}
