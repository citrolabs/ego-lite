/**
 * Render Accessibility.getFullAXTree nodes into the { content, refs } shape
 * ego.snapshot() must return. Refs are keyed by backendDOMNodeId, which is
 * exactly what the runtime's browserSnapshotRefsToRefMap() expects and what
 * its parseRef() resolves from an "@<id>" mark in the content.
 *
 * This is a deliberately simple text projection of the AX tree — the shipped
 * app's kernel-level snapshot is richer. It is good enough for locators and
 * targeted "@id" actions on ordinary DOM pages.
 */

const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
]);

// Roles that carry no information of their own; their children are promoted.
const SKIPPED_ROLES = new Set([
  "none",
  "generic",
  "InlineTextBox",
  "LineBreak",
]);

type AxNode = {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  backendDOMNodeId?: number;
  childIds?: string[];
};

export type SnapshotRef = {
  backendNodeId: number;
  role: string;
  name: string;
};

type RenderOptions = {
  maxResultLength?: number;
};

function refWorthy(node: AxNode, role: string, name: string) {
  if (node.backendDOMNodeId === undefined || node.backendDOMNodeId === null) {
    return false;
  }
  if (role === "StaticText" || role === "RootWebArea") {
    return false;
  }
  return INTERACTIVE_ROLES.has(role) || Boolean(name);
}

function renderable(role: string, name: string) {
  if (role === "StaticText") {
    return Boolean(name);
  }
  return Boolean(name) || INTERACTIVE_ROLES.has(role) || role === "RootWebArea";
}

export function renderAxTree(nodes: AxNode[], options: RenderOptions = {}) {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const hasParent = new Set<string>();
  for (const node of nodes) {
    for (const childId of node.childIds || []) {
      hasParent.add(childId);
    }
  }

  const lines: string[] = [];
  const refs: SnapshotRef[] = [];

  const visit = (
    node: AxNode | undefined,
    depth: number,
    parentName: string,
  ) => {
    if (!node) {
      return;
    }
    const role = node.role?.value || "";
    const name = (node.name?.value || "").trim();
    // A StaticText repeating its ancestor's accessible name adds nothing.
    if (role === "StaticText" && name && name === parentName) {
      return;
    }
    const skipped = node.ignored || !role || SKIPPED_ROLES.has(role);

    let nextDepth = depth;
    let nextParentName = parentName;
    if (!skipped && renderable(role, name)) {
      const indent = "  ".repeat(depth);
      if (role === "StaticText") {
        lines.push(`${indent}- text: ${JSON.stringify(name)}`);
      } else {
        const label = name ? ` ${JSON.stringify(name)}` : "";
        const mark = refWorthy(node, role, name)
          ? ` [@${node.backendDOMNodeId}]`
          : "";
        lines.push(`${indent}- ${role}${label}${mark}`);
        if (refWorthy(node, role, name)) {
          refs.push({ backendNodeId: node.backendDOMNodeId, role, name });
        }
      }
      nextDepth = depth + 1;
      nextParentName = name || parentName;
    }
    for (const childId of node.childIds || []) {
      visit(byId.get(childId), nextDepth, nextParentName);
    }
  };

  for (const node of nodes) {
    if (!hasParent.has(node.nodeId)) {
      visit(node, 0, "");
    }
  }

  let content = lines.join("\n");
  const maxResultLength = options.maxResultLength;
  if (Number.isFinite(maxResultLength) && maxResultLength >= 0) {
    content = content.slice(0, maxResultLength);
  }
  return { content, refs };
}
