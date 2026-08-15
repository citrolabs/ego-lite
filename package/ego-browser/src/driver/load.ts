import { cdp, evaluate } from "../cdp-eval.js";
import { state } from "../state.js";
import { createNavigationTimeoutError } from "../ego-errors.js";

export type WaitForLoadOptions = {
  timeout?: number;
  until?: "load" | "domcontentloaded";
  navigationUrl?: string;
};

export async function waitForDocumentLoad(options: WaitForLoadOptions = {}) {
  const timeout = options.timeout ?? 15000;
  const ready =
    options.until === "domcontentloaded"
      ? ["interactive", "complete"]
      : ["complete"];
  const deadline = state.now() + timeout;
  while (state.now() < deadline) {
    let committed = true;
    try {
      const tree = await cdp("Page.getFrameTree");
      const url = tree.frameTree?.frame?.url || "";
      committed = url !== "" && url !== ":" && url !== "about:blank";
    } catch {
      // Page.getFrameTree may not be supported in some sessions; fall back to readyState only.
    }
    if (committed && ready.includes(await evaluate("document.readyState"))) {
      return true;
    }
    await state.sleep(300);
  }
  if (options.navigationUrl !== undefined) {
    throw createNavigationTimeoutError(options.navigationUrl, timeout);
  }
  return false;
}
