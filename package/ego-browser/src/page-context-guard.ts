const PAGE_ONLY_GLOBALS = [
  "document",
  "innerHeight",
  "innerWidth",
  "localStorage",
  "location",
  "scrollX",
  "scrollY",
  "sessionStorage",
  "window",
] as const;
const PAGE_ONLY_GLOBAL_NAMES = new Set<string>(PAGE_ONLY_GLOBALS);

function pageContextHint(globalName: string): string {
  return (
    `The heredoc runs in Node.js, not in the Page. ${globalName} is a Page global. ` +
    "Put browser-side code inside page.evaluate(), for example page.evaluate(() => ...); " +
    "keep Node.js work outside it."
  );
}

/** Add one actionable hint to the common Node-versus-Page context mistake. */
export function addPageContextHint(error: unknown): unknown {
  if (!(error instanceof ReferenceError)) return error;
  const match = /^([A-Za-z_$][\w$]*) is not defined\.?$/i.exec(
    error.message.trim(),
  );
  if (!match || !PAGE_ONLY_GLOBAL_NAMES.has(match[1])) return error;
  if (error.message.includes("page.evaluate()")) return error;

  const originalMessage = error.message;
  error.message = `${originalMessage}. ${pageContextHint(match[1])}`;
  if (typeof error.stack === "string") {
    const lines = error.stack.split("\n");
    lines[0] = `${error.name}: ${error.message}`;
    error.stack = lines.join("\n");
  }
  return error;
}

/**
 * Install an SDK-only guard so the embedding host can print the same hint even
 * though it, rather than ego-browser's CLI wrapper, executes the heredoc.
 */
export function installPageContextGuard(target: Record<string, unknown>): void {
  for (const globalName of PAGE_ONLY_GLOBALS) {
    // Defining `window` would change normal Node.js checks such as
    // `typeof window`, so only the CLI wrapper enriches that error.
    if (globalName === "window") continue;
    if (Object.getOwnPropertyDescriptor(target, globalName)) continue;
    Object.defineProperty(target, globalName, {
      configurable: true,
      enumerable: false,
      get() {
        throw new ReferenceError(
          `${globalName} is not defined. ${pageContextHint(globalName)}`,
        );
      },
    });
  }
}
