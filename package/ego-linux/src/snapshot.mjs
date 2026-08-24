import { createSessionResolver } from "./session.mjs";

/**
 * snapshot() — the semantic page view the agent reads.
 *
 * Contract (package/ego-browser/src/driver/observe.ts + browser-runtime.ts:309):
 *   snapshot(options) -> { content: string, refs: [{ backendNodeId, role, name }] }
 *
 * `refs` is the load-bearing half: browserSnapshotRefsToRefMap() keys the ref map
 * by String(backendNodeId), which is exactly what `@N` / `ref=N` resolve against.
 * CDP hands out backendNodeIds directly, so refs are reproduced faithfully.
 *
 * `content` is rebuilt rather than reproduced — the native snapshot is closed
 * source. One DOMSnapshot.captureSnapshot call returns every document (iframes
 * included, nested to any depth), each node's backendNodeId and attributes, and
 * the layout tree. That covers hierarchy, visibility and iframe piercing in a
 * single round trip; roles and accessible names are computed here.
 */

const SKIP_TAGS = new Set([
  "script", "style", "noscript", "head", "meta", "link", "title", "template", "br",
]);

const ROLE_BY_TAG = new Map(Object.entries({
  a: "link", button: "button", select: "combobox", textarea: "textbox",
  h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading",
  img: "img", nav: "navigation", main: "main", header: "banner", footer: "contentinfo",
  form: "form", ul: "list", ol: "list", li: "listitem", table: "table", tr: "row",
  td: "cell", th: "columnheader", dialog: "dialog", option: "option", summary: "button",
  details: "group", label: "label", fieldset: "group", legend: "legend", article: "article",
  section: "region", aside: "complementary", iframe: "iframe", video: "video", audio: "audio",
}));

const INPUT_TYPE_ROLE = new Map(Object.entries({
  button: "button", submit: "button", reset: "button", image: "button",
  checkbox: "checkbox", radio: "radio", range: "slider", file: "file-input",
  hidden: "hidden",
}));

/** Roles worth handing the agent a ref for. */
const INTERACTIVE_ROLES = new Set([
  "link", "button", "textbox", "checkbox", "radio", "combobox", "option", "slider",
  "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "switch", "searchbox",
  "file-input", "spinbutton",
]);

/**
 * Roles whose accessible name comes from their own text content (ARIA's
 * "name from content"). Everything else — main, nav, form, region, list — is a
 * container: naming it would swallow the whole page into one string, and taking
 * that name as final would stop the walk before any child ever gets a ref.
 */
const NAME_FROM_CONTENT = new Set([
  "button", "link", "heading", "option", "tab", "menuitem", "menuitemcheckbox",
  "menuitemradio", "label", "legend", "switch",
]);

/** Roles that carry structure worth printing even without a ref. */
const STRUCTURAL_ROLES = new Set([
  "heading", "list", "listitem", "table", "row", "cell", "columnheader", "navigation",
  "main", "banner", "contentinfo", "form", "dialog", "article", "region", "complementary",
  "img", "label", "legend", "group", "iframe", "video", "audio",
]);

const MAX_NAME = 120;
const MAX_TEXT = 200;

function squash(value, limit = MAX_TEXT) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** RareBooleanData -> Set of node indices that are true. */
function rareBooleanSet(rare) {
  return new Set(rare?.index || []);
}

/** RareIntegerData / RareStringData -> Map of node index -> value. */
function rareMap(rare) {
  const map = new Map();
  const index = rare?.index || [];
  const value = rare?.value || [];
  for (let i = 0; i < index.length; i += 1) map.set(index[i], value[i]);
  return map;
}

function cssEscapeIdent(value) {
  return String(value).replace(/([^\w-])/g, "\\$1");
}

/** A document's nodes, decoded from the string table into a usable shape. */
function decodeDocument(document, strings) {
  const nodes = document.nodes;
  const count = nodes.nodeName?.length || 0;
  const str = (index) => (index === undefined || index < 0 ? "" : strings[index] || "");

  const contentDocumentIndex = rareMap(nodes.contentDocumentIndex);
  const clickable = rareBooleanSet(nodes.isClickable);
  const inputValue = rareMap(nodes.inputValue);
  const inputChecked = rareBooleanSet(nodes.inputChecked);

  const layoutBounds = new Map();
  const layoutText = new Map();
  const layout = document.layout || {};
  for (let i = 0; i < (layout.nodeIndex || []).length; i += 1) {
    const nodeIndex = layout.nodeIndex[i];
    layoutBounds.set(nodeIndex, layout.bounds?.[i]);
    const text = str(layout.text?.[i]);
    if (text) layoutText.set(nodeIndex, text);
  }

  const decoded = [];
  const children = new Map();
  const byId = new Map();

  for (let i = 0; i < count; i += 1) {
    const attributes = {};
    const flat = nodes.attributes?.[i] || [];
    for (let a = 0; a + 1 < flat.length; a += 2) {
      attributes[str(flat[a]).toLowerCase()] = str(flat[a + 1]);
    }
    const node = {
      index: i,
      parent: nodes.parentIndex?.[i] ?? -1,
      nodeType: nodes.nodeType?.[i],
      tag: str(nodes.nodeName?.[i]).toLowerCase(),
      value: str(nodes.nodeValue?.[i]),
      backendNodeId: nodes.backendNodeId?.[i],
      attributes,
      bounds: layoutBounds.get(i),
      text: layoutText.get(i),
      clickable: clickable.has(i),
      inputValue: inputValue.has(i) ? str(inputValue.get(i)) : undefined,
      inputChecked: inputChecked.has(i),
      contentDocumentIndex: contentDocumentIndex.get(i),
    };
    decoded.push(node);
    if (node.parent >= 0) {
      if (!children.has(node.parent)) children.set(node.parent, []);
      children.get(node.parent).push(i);
    }
    if (node.attributes.id) byId.set(node.attributes.id, node);
  }

  return {
    nodes: decoded,
    children,
    byId,
    scrollX: document.scrollOffsetX || 0,
    scrollY: document.scrollOffsetY || 0,
    url: str(document.documentURL),
  };
}

function roleOf(node) {
  const explicit = node.attributes.role;
  if (explicit) return explicit.trim().split(/\s+/)[0];
  if (node.tag === "input") {
    const type = (node.attributes.type || "text").toLowerCase();
    if (INPUT_TYPE_ROLE.has(type)) return INPUT_TYPE_ROLE.get(type);
    if (type === "search") return "searchbox";
    if (type === "number") return "spinbutton";
    return "textbox";
  }
  if (node.tag === "a") return node.attributes.href !== undefined ? "link" : "generic";
  if (node.attributes.contenteditable === "" || node.attributes.contenteditable === "true") {
    return "textbox";
  }
  return ROLE_BY_TAG.get(node.tag) || "generic";
}

/** Visible text of a subtree, used as the fallback accessible name. */
function subtreeText(doc, index, budget = MAX_NAME) {
  const parts = [];
  const walk = (current) => {
    if (parts.join(" ").length > budget) return;
    const node = doc.nodes[current];
    if (!node) return;
    if (node.nodeType === 3) {
      const text = node.text || node.value;
      if (text && text.trim()) parts.push(text.trim());
      return;
    }
    if (SKIP_TAGS.has(node.tag)) return;
    for (const child of doc.children.get(current) || []) walk(child);
  };
  walk(index);
  return squash(parts.join(" "), budget);
}

function accessibleName(doc, node, role) {
  const attrs = node.attributes;
  if (attrs["aria-label"]) return squash(attrs["aria-label"], MAX_NAME);
  if (attrs["aria-labelledby"]) {
    const labels = attrs["aria-labelledby"]
      .split(/\s+/)
      .map((id) => doc.byId.get(id))
      .filter(Boolean)
      .map((target) => subtreeText(doc, target.index));
    if (labels.length) return squash(labels.join(" "), MAX_NAME);
  }
  if (node.tag === "img") return squash(attrs.alt || "", MAX_NAME);
  if (node.tag === "input" || node.tag === "textarea" || node.tag === "select") {
    if (attrs.id) {
      for (const candidate of doc.nodes) {
        if (candidate.tag === "label" && candidate.attributes.for === attrs.id) {
          return subtreeText(doc, candidate.index);
        }
      }
    }
    // A wrapping <label> is the other half of the native label association.
    let parent = node.parent;
    while (parent >= 0) {
      const ancestor = doc.nodes[parent];
      if (!ancestor) break;
      if (ancestor.tag === "label") return subtreeText(doc, ancestor.index);
      parent = ancestor.parent;
    }
    return squash(attrs.placeholder || attrs.title || attrs.name || "", MAX_NAME);
  }
  if (role === "iframe") return squash(attrs.title || attrs.name || "", MAX_NAME);
  if (NAME_FROM_CONTENT.has(role)) return subtreeText(doc, node.index);
  // Containers are named only by an explicit label, never by their contents.
  return squash(attrs.title || "", MAX_NAME);
}

/** Most stable `loc=` the resolver (locator-query.ts) can re-find this node by. */
function stableLocator(node, role, name) {
  const attrs = node.attributes;
  if (attrs["data-testid"]) return `testid:${attrs["data-testid"]}`;
  if (attrs.id && /^[A-Za-z][\w-]*$/.test(attrs.id)) return `css:#${cssEscapeIdent(attrs.id)}`;
  if (role === "link" && attrs.href) return `href:${attrs.href}`;
  if (attrs.placeholder) return `placeholder:${attrs.placeholder}`;
  if (attrs["data-test"]) return `css:[data-test="${attrs["data-test"]}"]`;
  if (name && INTERACTIVE_ROLES.has(role)) return `role:${role}[name='${name.replace(/'/g, "\\'")}']`;
  if (attrs.name) return `css:${node.tag}[name="${attrs.name}"]`;
  return null;
}

function intersectsViewport(bounds, viewport) {
  if (!bounds || !viewport) return true;
  const [x, y, width, height] = bounds;
  return (
    x + width >= viewport.x &&
    y + height >= viewport.y &&
    x <= viewport.x + viewport.width &&
    y <= viewport.y + viewport.height
  );
}

function renderDocument(doc, documents, options, out, refs, depth, seenDocs) {
  const { viewport, includeActionMarks, includeStableLocator } = options;

  const emit = (indent, line) => out.push(`${"  ".repeat(indent)}${line}`);

  const walk = (index, indent) => {
    const node = doc.nodes[index];
    if (!node) return;

    if (node.nodeType === 3) {
      const text = squash(node.text || node.value);
      // Text only counts as rendered when it made it into the layout tree, and
      // it answers to the same viewport scope as an element does. Skipping this
      // check meant `only_within_viewport` still emitted every paragraph below
      // the fold — on a text-heavy page that is most of the content, which is
      // why scoping the view saved so much less than it looked like it should.
      if (
        text &&
        node.text !== undefined &&
        intersectsViewport(node.bounds, viewport)
      ) {
        emit(indent, `text: ${text}`);
      }
      return;
    }
    if (node.nodeType !== 1) {
      for (const child of doc.children.get(index) || []) walk(child, indent);
      return;
    }
    if (SKIP_TAGS.has(node.tag)) return;
    if (node.attributes["aria-hidden"] === "true") return;

    const role = roleOf(node);
    if (role === "hidden") return;

    const rendered = node.bounds && node.bounds[2] > 0 && node.bounds[3] > 0;
    const inScope = rendered && intersectsViewport(node.bounds, viewport);

    // An iframe is a document boundary: recurse into its content document so
    // nested frames appear inline in one tree.
    if (node.contentDocumentIndex !== undefined) {
      const childDoc = documents[node.contentDocumentIndex];
      if (childDoc && !seenDocs.has(node.contentDocumentIndex)) {
        seenDocs.add(node.contentDocumentIndex);
        const name = accessibleName(doc, node, role);
        emit(indent, `iframe${name ? ` "${name}"` : ""} [url=${childDoc.url}]`);
        renderDocument(childDoc, documents, options, out, refs, indent + 1, seenDocs);
        return;
      }
    }

    const interactive =
      INTERACTIVE_ROLES.has(role) ||
      node.clickable ||
      node.attributes.onclick !== undefined ||
      node.attributes.tabindex !== undefined;

    const shouldEmit =
      inScope && (interactive || STRUCTURAL_ROLES.has(role));
    const addressable = interactive && node.backendNodeId !== undefined;

    // Being addressable is a different question from being on screen. An
    // interactive node joins the refMap wherever it sits, so `@N` still
    // resolves for something below the fold; only the rendered line stays
    // viewport-scoped. Tying the two together is what made
    // `scope: only_within_viewport` hand back "Unknown ref" for everything it
    // had scrolled past, forcing a choice between a cheap snapshot and usable
    // refs. The extra work is one bounded accessible-name walk per off-screen
    // interactive node, over a document that is already decoded in memory —
    // no additional CDP round trip, and full_page is unaffected because every
    // node is in scope there anyway.
    const name =
      shouldEmit || addressable ? accessibleName(doc, node, role) : "";
    if (addressable) {
      refs.push({ backendNodeId: node.backendNodeId, role, name });
    }

    if (shouldEmit) {
      const marks = [];

      if (addressable) {
        marks.push(`ref=${node.backendNodeId}`);
      }
      if (includeStableLocator) {
        const locator = stableLocator(node, role, name);
        if (locator) marks.push(`loc=${locator}`);
      }
      if (role === "link" && node.attributes.href) marks.push(`url=${node.attributes.href}`);
      if (includeActionMarks && interactive) {
        marks.push(role === "textbox" || role === "searchbox" ? "action=type" : "action=click");
      }
      if (node.inputValue) marks.push(`value=${squash(node.inputValue, 40)}`);
      if (node.inputChecked) marks.push("checked");
      if (node.attributes.disabled !== undefined) marks.push("disabled");

      const heading = node.tag.match(/^h([1-6])$/);
      const label = heading ? `heading${heading[1]}` : role;
      const suffix = marks.length ? ` [${marks.join(", ")}]` : "";
      emit(indent, `${label}${name ? ` "${name}"` : ""}${suffix}`);

      // A name-from-content node has already printed its whole subtree as its
      // name; recursing would repeat it. Containers must never take this path —
      // their children are where the refs live.
      if (name && NAME_FROM_CONTENT.has(role) && subtreeText(doc, index) === name) {
        return;
      }
    }

    const nextIndent = shouldEmit ? indent + 1 : indent;
    for (const child of doc.children.get(index) || []) walk(child, nextIndent);
  };

  walk(0, depth);
}

export function createSnapshotApi(cdp, { listTabs }) {
  // Snapshot whatever page the harness is actually driving: observation and
  // action drifting apart reads as an empty snapshot. See session.mjs.
  const sessionForActiveTab = createSessionResolver(cdp, {
    listTabs,
    op: "snapshot",
  });

  return {
    async snapshot(options = {}) {
      const sessionId = await sessionForActiveTab();
      const scope = options.scope ?? "full_page";

      let viewport = null;
      if (scope === "only_within_viewport") {
        const metrics = await cdp.call("Page.getLayoutMetrics", {}, sessionId);
        const visual = metrics.cssVisualViewport || metrics.visualViewport;
        if (visual) {
          viewport = {
            x: visual.pageX ?? 0,
            y: visual.pageY ?? 0,
            width: visual.clientWidth ?? 0,
            height: visual.clientHeight ?? 0,
          };
        }
      }

      const captured = await cdp.call(
        "DOMSnapshot.captureSnapshot",
        { computedStyles: [], includeDOMRects: false, includePaintOrder: false },
        sessionId,
      );

      const strings = captured.strings || [];
      const documents = (captured.documents || []).map((document) =>
        decodeDocument(document, strings),
      );
      if (!documents.length) return { content: "", refs: [] };

      const out = [];
      const refs = [];
      renderDocument(
        documents[0],
        documents,
        {
          viewport,
          includeActionMarks: options.includeActionMarks ?? true,
          includeStableLocator: options.includeStableLocator ?? true,
        },
        out,
        refs,
        0,
        new Set([0]),
      );

      return { content: out.join("\n"), refs };
    },
  };
}
