# Native snapshot requirements

## Compact snapshot text

Please simplify the snapshot tree before serializing `content`:

- Omit text nodes that are empty, whitespace-only (including NBSP), or contain
  only zero-width formatting characters.
- Omit an unnamed `container` with no remaining children.
- Replace an unnamed `container` with its only remaining child.
- Keep unnamed containers with multiple children because they preserve
  grouping.
- Keep named or ref-bearing containers and semantic nodes such as `image`,
  `svg_root`, `canvas`, `iframe`, `root`, list items, and table cells.

The transformation must preserve the order of remaining nodes, refs, stable
locators, URLs, and iframe boundaries. It applies to both viewport and full-page
snapshots. Never remove or rewrite non-empty page text because it is
non-interactive, because its parent container is simplified, or while cleaning
locator metadata.

Acceptance: a fixture containing nested containers, blank text, two sibling
groups, an iframe, an image, an SVG, a canvas, and an empty table cell is
captured twice. The compact output is identical on the second pass, the sibling
groups remain distinct, and every ref still resolves to its original node.

## Snapshot refs for iframe content

`ego.snapshot()` already includes text from ordinary iframes and OOPIFs, but
actionable nodes inside those frames are currently omitted from `refs`. The
result is visible content that has no `@N` target.

Please return a ref for every actionable frame node printed by the snapshot:

```js
{
  refId: 901,
  backendNodeId: 21,
  frameId: "FRAME_OR_OOPIF_TARGET_ID",
  role: "button",
  name: "Run iframe action",
}
```

- The content must print `[ref=901]` for this node.
- `refId` must be unique within one snapshot, including across renderer
  processes. It is the value shown to the Agent.
- `backendNodeId` remains the node id local to its renderer.
- `frameId` identifies the frame that owns the node. It may be omitted for the
  top-level document.
- Capturing the snapshot must not activate, focus, or reload a frame.

Acceptance: one page contains a same-origin iframe and a cross-origin OOPIF,
with repeated backend node ids in different renderers. Every printed button and
textbox has a distinct ref, and each ref resolves to the node in its own frame.

ego-browser now backfills a missing `frameId` from the frame AX tree when one
backend node id has only one possible owner. Native metadata is still required
when renderer-local backend ids repeat, and for actionable frame nodes omitted
from `refs` entirely.

## Stable locator correctness

A stable locator must resolve uniquely to the same node that produced the
snapshot ref. It is invalid when it matches no node, matches more than one node,
or uniquely matches a different `backendNodeId`.

Please cover at least these cases in native tests:

- repeated controls in one document, such as buttons with the same name;
- a hidden copy and a visible editor sharing the same accessible name;
- the same role and name in the top-level document and an iframe;
- a locator whose element type does not match the source node.

Omit the locator when uniqueness and node identity cannot both be established.
Do not serialize `loc=unstable` or `loc=ambiguous` in `content`, and do not use
those status strings in `refs`. The JS runtime validates advertised locators
and omits invalid ones as a compatibility safeguard.
