/**
 * Linux Snapshot — AX-tree snapshot via Accessibility.getFullAXTree
 * with DOM fallback.
 *
 * Produces { content, refs } matching driver/observe.ts shape.
 * Lazy-imports cdp-eval to break circular import (state->linux->cdp-eval->state).
 */

export interface SnapshotOptions {
  scope?: "only_within_viewport" | "full_page";
  includeActionMarks?: boolean;
  includeStableLocator?: boolean;
  maxResultLength?: number;
}

export interface SnapshotResult {
  content: string;
  refs: Array<{ backendNodeId: number; role?: string; name?: string }>;
}

export class LinuxSnapshot {
  constructor() {}

  async snapshot(opts: SnapshotOptions = {}): Promise<SnapshotResult> {
    const { cdp } = await import("../cdp-eval.js");

    try {
      try {
        await cdp("Accessibility.enable", {});
      } catch {}
      const ax = (await cdp("Accessibility.getFullAXTree", {})) as {
        nodes?: Array<{
          backendDOMNodeId?: number;
          role?: { value?: string };
          name?: { value?: string };
          ignored?: boolean;
        }>;
      };
      if (ax?.nodes?.length) {
        const refs: SnapshotResult["refs"] = [];
        const lines: string[] = [];
        for (const n of ax.nodes) {
          if (n.ignored) continue;
          const role = n.role?.value ?? "";
          const name = n.name?.value ?? "";
          const id = n.backendDOMNodeId;
          if (id != null) {
            refs.push({ backendNodeId: id, role, name });
            lines.push(
              `[${refs.length - 1}] ${role}${name ? ` "${name}"` : ""}  @${id}`,
            );
          } else {
            lines.push(`${role}${name ? ` "${name}"` : ""}`);
          }
        }
        let content = lines.join("\n");
        if (opts.maxResultLength != null && content.length > opts.maxResultLength) {
          content = content.slice(0, opts.maxResultLength);
        }
        return { content, refs };
      }
    } catch {}

    try {
      await cdp("DOM.getDocument", { depth: -1, pierce: true });
      // Use maxResultLength as the single truncation budget (default to 250k to
      // avoid unbounded pages when caller does not pass a limit).
      const limit = opts.maxResultLength ?? 250_000;
      const html: string = (await cdp("Runtime.evaluate", {
        expression: `document.documentElement ? document.documentElement.outerHTML.slice(0, ${limit}) : ''`,
        returnByValue: true,
        awaitPromise: false,
      }).then(
        (r: { result?: { value?: string } }) => r?.result?.value ?? "",
      )) as string;
      let content = html || "(empty page)";
      if (content.length > limit) content = content.slice(0, limit);
      return { content, refs: [] };
    } catch {
      return { content: "(snapshot unavailable)", refs: [] };
    }
  }
}
