import type { CdpCall } from "./bridge.js";
import { egoError, invalid } from "./task-spaces.js";

export interface SnapshotOptions {
  scope?: "only_within_viewport" | "full_page" | "subtree";
  root?: number;
  interactiveOnly?: boolean;
  includeActionMarks?: boolean;
  includeStableLocator?: boolean;
  maxResultLength?: number;
}
const interactiveRoles = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "treeitem",
]);

export class LinuxSnapshot {
  constructor(private cdp: CdpCall) {}
  async snapshot(opts: SnapshotOptions = {}) {
    if (!opts || typeof opts !== "object")
      invalid("Snapshot options must be an object");
    const scope = opts.scope ?? "full_page";
    if (!["full_page", "subtree", "only_within_viewport"].includes(scope))
      invalid("Invalid snapshot scope");
    if (scope === "subtree" && (!Number.isInteger(opts.root) || opts.root <= 0))
      invalid("Subtree snapshot requires a backend node root");
    if (scope !== "subtree" && opts.root !== undefined)
      invalid("root requires subtree scope");
    if (
      opts.maxResultLength !== undefined &&
      (!Number.isInteger(opts.maxResultLength) || opts.maxResultLength < 0)
    )
      invalid("maxResultLength must be a non-negative integer");
    try {
      await this.cdp("Accessibility.enable");
      const { nodes = [] } = await this.cdp("Accessibility.getFullAXTree");
      const tree = new Map<string, any>(
        nodes.map((node: any) => [node.nodeId, node]),
      );
      const root =
        scope === "subtree"
          ? nodes.find((n: any) => n.backendDOMNodeId === opts.root)
          : nodes[0];
      if (!root)
        throw egoError(
          "EGO_SNAPSHOT_FAILED",
          "Snapshot root is not available in this document",
        );
      const refs: Array<any> = [];
      const lines: string[] = [];
      const visited = new Set<string>();
      let length = 0;
      const visit = async (node: any, depth: number, parentVisible = true) => {
        if (!node || visited.has(node.nodeId)) return;
        visited.add(node.nodeId);
        const role = node.role?.value ?? "generic";
        const name = node.name?.value ?? "";
        const id = node.backendDOMNodeId;
        let visible = id ? true : parentVisible;
        let include =
          visible &&
          !node.ignored &&
          (!opts.interactiveOnly || interactiveRoles.has(role));
        let loc: string | undefined;
        if (
          include &&
          id &&
          (scope === "only_within_viewport" || opts.includeStableLocator)
        ) {
          const { object } = await this.cdp("DOM.resolveNode", {
            backendNodeId: id,
            objectGroup: "ego-snapshot",
          });
          if (object?.objectId) {
            const { result } = await this.cdp("Runtime.callFunctionOn", {
              objectId: object.objectId,
              functionDeclaration:
                "function () { const e = this.nodeType === 1 ? this : this.parentElement; if (!e) return { visible: false }; const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return { visible: r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && s.visibility !== 'hidden' && s.display !== 'none', loc: this.id && document.querySelectorAll('#' + CSS.escape(this.id)).length === 1 ? 'css:#' + CSS.escape(this.id) : undefined }; }",
              returnByValue: true,
            });
            if (scope === "only_within_viewport" && !result?.value?.visible) {
              include = false;
              visible = false;
            }
            if (opts.includeStableLocator) loc = result?.value?.loc;
          } else if (scope === "only_within_viewport") include = false;
        }
        let emitted = false;
        if (include) {
          const line = `${"  ".repeat(depth)}${role}${name ? ` ${JSON.stringify(name)}` : ""}${id ? ` [ref=${id}]` : ""}`;
          const nextLength = length + line.length + (lines.length ? 1 : 0);
          if (!opts.maxResultLength || nextLength <= opts.maxResultLength) {
            lines.push(line);
            length = nextLength;
            emitted = true;
            if (id)
              refs.push({
                backendNodeId: id,
                role,
                name,
                // Main-document refs must not carry a frameId: the SDK treats
                // that field as an iframe and tries to resolve its frame owner.
                frameProvenance: "page",
                ...(loc ? { loc } : {}),
              });
          }
        }
        for (const child of node.childIds ?? [])
          await visit(tree.get(child), depth + (emitted ? 1 : 0), visible);
      };
      await visit(root, 0);
      return { content: lines.join("\n"), refs };
    } catch (error) {
      if (error.error_code) throw error;
      throw egoError("EGO_SNAPSHOT_FAILED", error.message ?? String(error));
    } finally {
      await this.cdp("Runtime.releaseObjectGroup", {
        objectGroup: "ego-snapshot",
      }).catch(() => {});
    }
  }
}
