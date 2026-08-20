import { cdp, evaluate } from "../cdp-eval.js";
import { state } from "../state.js";

export type WaitForLoadOptions = {
  timeout?: number;
  until?: "load" | "domcontentloaded";
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
    let readyState = "";
    try {
      readyState = await evaluate("document.readyState");
    } catch {
      // Runtime.evaluate can reject while the page is committing a navigation
      // ("Execution context was destroyed"). Like the getFrameTree call above,
      // treat this as not-ready-yet and keep polling instead of rejecting the
      // whole wait.
    }
    if (committed && ready.includes(readyState)) {
      return true;
    }
    await state.sleep(300);
  }
  return false;
}
