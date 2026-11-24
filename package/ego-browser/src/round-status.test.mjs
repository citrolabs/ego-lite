import test from "node:test";
import assert from "node:assert/strict";

import {
  formatRoundStatus,
  recordRoundSpaceStatus,
  refreshRoundStatus,
  resetRoundStatus,
  touchRoundSpace,
} from "../dist/src/round-status.js";

function page(label, title, openedBy = "agent") {
  return { label, title, targetId: `target-${label}`, openedBy };
}

function line(notices = []) {
  return formatRoundStatus(notices).line;
}

test("no operated space prints no status line", () => {
  resetRoundStatus();
  assert.equal(line(), "");
});

test("a ready space lists its Pages with JSON-quoted titles", () => {
  resetRoundStatus();
  touchRoundSpace(7, "采购调研");
  recordRoundSpaceStatus(7, {
    state: "ready",
    pages: [page("p1", "商品详情"), page("p2", "规格对比")],
  });
  assert.equal(line(), '[7 "采购调研" ready(p1:"商品详情",p2:"规格对比")]\n');
});

test("spaces are listed in first-operated order with their final state", () => {
  resetRoundStatus();
  touchRoundSpace(12, "报价整理");
  touchRoundSpace(7, "采购调研");
  touchRoundSpace(12, "报价整理");
  recordRoundSpaceStatus(7, {
    state: "ready",
    pages: [page("p2", "规格对比")],
  });
  recordRoundSpaceStatus(12, { state: "closed", pages: [] });
  assert.equal(
    line(),
    '[12 "报价整理" closed() | 7 "采购调研" ready(p2:"规格对比")]\n',
  );
});

test("each state prints its own Page list form", () => {
  resetRoundStatus();
  const cases = [
    [1, { state: "ready", pages: [] }, "ready()"],
    [2, { state: "ready", pages: [page("p2", "")] }, 'ready(p2:"")'],
    [3, { state: "user_control", pages: null }, "user_control(-)"],
    [
      4,
      {
        state: "finished",
        pages: [page("p1", "商品详情"), page("p2", "登录", "unknown")],
      },
      'finished(p1:"商品详情",p2 user:"登录")',
    ],
    [5, { state: "closed", pages: [] }, "closed()"],
  ];
  for (const [spaceId, status] of cases) {
    touchRoundSpace(spaceId, "");
    recordRoundSpaceStatus(spaceId, status);
  }
  touchRoundSpace(6, "");
  assert.equal(
    line(),
    `[${[...cases.map(([id, , text]) => `${id} "" ${text}`), '6 "" unknown(-)'].join(" | ")}]\n`,
  );
});

test("titles keep separators as text and escape line breaks", () => {
  resetRoundStatus();
  touchRoundSpace(7, 'a "b"');
  recordRoundSpaceStatus(7, {
    state: "ready",
    pages: [page("p1", "x, y | (z)\nnext")],
  });
  assert.equal(line(), '[7 "a \\"b\\"" ready(p1:"x, y | (z)\\nnext")]\n');
});

test("unhandled Pages of listed spaces fold into the status line", () => {
  resetRoundStatus();
  touchRoundSpace(7, "research");
  recordRoundSpaceStatus(7, {
    state: "ready",
    pages: [page("p1", "Source"), page("p2", "Popup")],
  });
  const folded = {
    spaceId: 7,
    targetId: "target-p2",
    label: "p2",
    openerLabel: "p1",
    url: "https://example.test/popup",
  };
  const elsewhere = { spaceId: 9, targetId: "target-x", label: "p4" };

  const status = formatRoundStatus([folded, elsewhere]);

  assert.equal(
    status.line,
    '[7 "research" ready(p1:"Source",p2 new from p1:"Popup")]\n',
  );
  assert.deepEqual(status.remainingNotices, [elsewhere]);
});

test("refresh reads only spaces the agent may still operate", async () => {
  resetRoundStatus();
  const reads = [];
  const refresher = (id) => async () => {
    reads.push(id);
    return { state: "ready", pages: [page("p1", `fresh ${id}`)] };
  };
  touchRoundSpace(1, "", refresher(1));
  touchRoundSpace(2, "", refresher(2));
  touchRoundSpace(3, "", refresher(3));
  recordRoundSpaceStatus(1, { state: "ready", pages: [] });
  recordRoundSpaceStatus(2, { state: "user_control", pages: null });
  recordRoundSpaceStatus(3, { state: "finished", pages: [] });

  await refreshRoundStatus();

  assert.deepEqual(reads, [1]);
  assert.match(
    line(),
    /^\[1 "" ready\(p1:"fresh 1"\) \| 2 "" user_control\(-\)/,
  );
});

test("a refresh that fails or runs out of time reports unknown(-)", async () => {
  resetRoundStatus();
  touchRoundSpace(1, "", async () => {
    throw new Error("listTabs failed");
  });
  touchRoundSpace(2, "", () => new Promise(() => {}));
  recordRoundSpaceStatus(2, { state: "ready", pages: [page("p1", "stale")] });

  await refreshRoundStatus(20);

  assert.equal(line(), '[1 "" unknown(-) | 2 "" unknown(-)]\n');
});

test("a timed-out refresh is aborted and its late cache writes are ignored", async () => {
  resetRoundStatus();
  let seenSignal;
  touchRoundSpace(7, "", (signal) => {
    seenSignal = signal;
    return new Promise(() => {});
  });

  await refreshRoundStatus(20);
  assert.equal(seenSignal.aborted, true, "the refresher is told to stop");

  recordRoundSpaceStatus(7, { state: "ready", pages: [page("p1", "late")] });
  assert.equal(line(), '[7 "" unknown(-)]\n');
});
