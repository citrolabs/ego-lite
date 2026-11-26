/**
 * Late-bound links between the Page model and the plugin runtime.
 *
 * The plugin runtime needs the full helper context, which is assembled in
 * helpers.ts, and helpers.ts imports the Page model. Registering the runtime
 * here at load time keeps page-model.ts free of an import cycle.
 */

export type PluginRunner = (
  page: unknown,
  task: unknown,
  ref: unknown,
  args: unknown,
  options: unknown,
) => Promise<unknown>;

export type PageTouchedListener = (page: unknown, task: unknown) => void;

let runner: PluginRunner | undefined;
let pageTouched: PageTouchedListener | undefined;

export function setPluginRunner(next: PluginRunner | undefined): void {
  runner = next;
}

export function pluginRunner(): PluginRunner {
  if (!runner) {
    throw new Error("site plugins are not available in this ego-browser build");
  }
  return runner;
}

export function setPageTouchedListener(
  next: PageTouchedListener | undefined,
): void {
  pageTouched = next;
}

/** Called whenever a Page resolves its tab during a round. */
export function notifyPageTouched(page: unknown, task: unknown): void {
  if (!pageTouched) return;
  try {
    pageTouched(page, task);
  } catch {
    // Discovery hints are advisory and must never fail a Page operation.
  }
}
