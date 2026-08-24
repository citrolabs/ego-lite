import test from "node:test";
import assert from "node:assert/strict";

import { createSnapshotApi } from "../src/snapshot.mjs";

// Minimal DOMSnapshot.captureSnapshot payload: two buttons, one inside the
// viewport and one 5000 px below it. Enough to exercise the scope split without
// dragging a real browser into a unit test.
const S = {
  EMPTY: 0,
  HTML: 1,
  BODY: 2,
  BUTTON: 3,
  TEXT: 4,
  VISIBLE: 5,
  BELOW: 6,
  URL: 7,
};

function capturedFixture() {
  return {
    strings: [
      "",
      "HTML",
      "BODY",
      "BUTTON",
      "#text",
      "Visible button",
      "Below the fold",
      "https://example.test/",
    ],
    documents: [
      {
        documentURL: S.URL,
        nodes: {
          //            html body btn-a btn-b  text-a text-b
          parentIndex: [-1, 0, 1, 1, 2, 3],
          nodeType: [1, 1, 1, 1, 3, 3],
          nodeName: [S.HTML, S.BODY, S.BUTTON, S.BUTTON, S.TEXT, S.TEXT],
          nodeValue: [S.EMPTY, S.EMPTY, S.EMPTY, S.EMPTY, S.VISIBLE, S.BELOW],
          backendNodeId: [1, 2, 100, 200, 101, 201],
          attributes: [[], [], [], [], [], []],
        },
        // Both buttons are laid out; the second sits 5000 px down, well past a
        // 800 px viewport. Their label text carries the same bounds so the
        // accessible name resolves the way it would in a real capture.
        layout: {
          nodeIndex: [2, 3, 4, 5],
          bounds: [
            [0, 10, 120, 30],
            [0, 5000, 120, 30],
            [0, 10, 120, 30],
            [0, 5000, 120, 30],
          ],
          text: [S.EMPTY, S.EMPTY, S.VISIBLE, S.BELOW],
        },
      },
    ],
  };
}

function makeApi() {
  const calls = [];
  const cdp = {
    async call(method) {
      calls.push(method);
      if (method === "Target.attachToTarget") return { sessionId: "sess-1" };
      if (method === "Page.getLayoutMetrics") {
        return {
          cssVisualViewport: {
            pageX: 0,
            pageY: 0,
            clientWidth: 1280,
            clientHeight: 800,
          },
        };
      }
      if (method === "DOMSnapshot.captureSnapshot") return capturedFixture();
      return {};
    },
  };
  const listTabs = async () => ({
    tabs: [{ targetId: "tab-1", active: true }],
  });
  return { api: createSnapshotApi(cdp, { listTabs }), calls };
}

const refIds = (result) => result.refs.map((ref) => ref.backendNodeId).sort();

test("viewport scope keeps off-screen elements addressable", async () => {
  // The regression this pins: refs used to be collected inside the same branch
  // that emitted a line, so anything outside the viewport was left out of the
  // refMap entirely and `@N` came back as "Unknown ref". Callers then had to
  // pick between a cheap snapshot and usable refs. Rendering is scoped; being
  // addressable is not.
  const { api } = makeApi();
  const result = await api.snapshot({ scope: "only_within_viewport" });

  assert.ok(
    result.content.includes("Visible button"),
    "the in-viewport button is rendered",
  );
  assert.ok(
    !result.content.includes("Below the fold"),
    "the off-screen button is not rendered",
  );
  assert.deepEqual(
    refIds(result),
    [100, 200],
    "both buttons stay in the refMap, on-screen or not",
  );
});

test("full_page renders and addresses everything", async () => {
  const { api } = makeApi();
  const result = await api.snapshot({ scope: "full_page" });

  assert.ok(result.content.includes("Visible button"));
  assert.ok(result.content.includes("Below the fold"));
  assert.deepEqual(refIds(result), [100, 200]);
});

test("viewport scope still costs one layout-metrics round trip", async () => {
  // Scoping is applied while rendering an already-decoded document, so the only
  // extra CDP traffic it buys is the viewport read. Worth pinning: if this ever
  // grows a second capture, the scope option stops being nearly free.
  const { api, calls } = makeApi();
  await api.snapshot({ scope: "only_within_viewport" });

  assert.equal(
    calls.filter((m) => m === "DOMSnapshot.captureSnapshot").length,
    1,
  );
  assert.equal(
    calls.filter((m) => m === "Page.getLayoutMetrics").length,
    1,
  );
});
