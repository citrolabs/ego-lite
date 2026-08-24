import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PageLedgerStore, runtimeInstanceId } from "../dist/src/page-ledger.js";

test("runtimeInstanceId is a pure browser-host identifier", () => {
  const first = runtimeInstanceId(42);
  const second = runtimeInstanceId(42);

  assert.equal(second, first);
  assert.equal(first, "browser-host:42");
});

async function withTempLedger(fn) {
  const rootDir = await mkdtemp(join(tmpdir(), "ego-page-ledger-test-"));
  try {
    return await fn(rootDir);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

test("page labels survive a new process and are never reused", async () => {
  await withTempLedger(async (rootDir) => {
    const firstRound = new PageLedgerStore({ rootDir });
    const first = await firstRound.addPage(7, "target-a");

    assert.equal(first.label, "p1");
    assert.equal(first.targetId, "target-a");

    const secondRound = new PageLedgerStore({ rootDir });
    assert.deepEqual(await secondRound.getPage(7, "p1"), first);

    await secondRound.closePage(7, "p1");
    await assert.rejects(
      () => secondRound.getPage(7, "p1"),
      /page p1 was closed/,
    );

    const next = await secondRound.addPage(7, "target-b");
    assert.equal(next.label, "p2");
  });
});

test("a newly created space atomically replaces stale state with agent page p1", async () => {
  await withTempLedger(async (rootDir) => {
    const store = new PageLedgerStore({
      rootDir,
      browserInstanceId: "browser-current",
    });
    await store.addPage(7, "target-stale");
    await store.closePage(7, "p1");

    const initial = await store.initializeCreatedSpace(7, "target-initial");

    assert.deepEqual(initial, {
      label: "p1",
      targetId: "target-initial",
      openedBy: "agent",
    });
    assert.deepEqual(await store.read(7), {
      browserInstanceId: "browser-current",
      spaceId: 7,
      nextLabel: 2,
      usedLabels: ["p1"],
      releasedLabels: [],
      initialized: true,
      userControlPending: false,
      unmanagedTargets: {},
      pages: {
        p1: { targetId: "target-initial", openedBy: "agent" },
      },
    });

    const next = await store.addPage(7, "target-next");
    assert.equal(next.label, "p2");
  });
});

test("a reused space id starts conservatively in a new browser instance", async () => {
  await withTempLedger(async (rootDir) => {
    const firstBrowser = new PageLedgerStore({
      rootDir,
      browserInstanceId: "browser-a",
    });
    await firstBrowser.addPage(7, "target-from-browser-a");

    const secondBrowser = new PageLedgerStore({
      rootDir,
      browserInstanceId: "browser-b",
    });
    const fresh = await secondBrowser.read(7);
    assert.equal(fresh.initialized, false);
    assert.deepEqual(fresh.pages, {});

    const baseline = await secondBrowser.reconcile(7, ["target-existing"], {
      autoAdoptNew: true,
    });
    assert.deepEqual(baseline.pages, {});
    assert.equal(baseline.unmanagedTargets["target-existing"], "unknown");

    const persisted = JSON.parse(
      await readFile(join(rootDir, "space-7.json"), "utf8"),
    );
    assert.equal(persisted.browserInstanceId, "browser-b");
  });
});

test("a ledger from before instance ids is preserved and backfilled", async () => {
  await withTempLedger(async (rootDir) => {
    const path = join(rootDir, "space-7.json");
    await writeFile(
      path,
      JSON.stringify({
        spaceId: 7,
        nextLabel: 2,
        usedLabels: ["p1"],
        releasedLabels: [],
        initialized: true,
        userControlPending: false,
        unmanagedTargets: {},
        pages: {
          p1: { targetId: "target-live", openedBy: "agent" },
        },
      }),
    );

    const store = new PageLedgerStore({
      rootDir,
      browserInstanceId: "browser-current",
    });
    assert.deepEqual(await store.getPage(7, "p1"), {
      label: "p1",
      targetId: "target-live",
      openedBy: "agent",
    });
    assert.equal(
      JSON.parse(await readFile(path, "utf8")).browserInstanceId,
      "browser-current",
    );
  });
});

test("expired ledgers from other browser instances are removed", async () => {
  await withTempLedger(async (rootDir) => {
    const stalePath = join(rootDir, "space-99.json");
    await writeFile(
      stalePath,
      JSON.stringify({
        browserInstanceId: "browser-a",
        spaceId: 99,
        nextLabel: 1,
        usedLabels: [],
        releasedLabels: [],
        initialized: true,
        userControlPending: false,
        unmanagedTargets: {},
        pages: {},
      }),
    );
    await utimes(stalePath, new Date(0), new Date(0));

    const secondBrowser = new PageLedgerStore({
      rootDir,
      browserInstanceId: "browser-b",
      staleAfterMs: 1_000,
      now: () => 10_000,
    });
    await secondBrowser.read(7);

    await assert.rejects(() => readFile(stalePath, "utf8"), {
      code: "ENOENT",
    });
  });
});

test("custom labels share the permanent used-label namespace", async () => {
  await withTempLedger(async (rootDir) => {
    const store = new PageLedgerStore({ rootDir });
    const page = await store.addPage(2, "target-login", { as: "login" });

    assert.equal(page.label, "login");
    await store.closePage(2, "login");
    await assert.rejects(
      () => store.addPage(2, "target-new", { as: "login" }),
      /page label already used: login/,
    );
  });
});

test("writes use a complete atomic ledger document", async () => {
  await withTempLedger(async (rootDir) => {
    const store = new PageLedgerStore({ rootDir });
    await store.addPage(5, "target-a");

    const parsed = JSON.parse(
      await readFile(join(rootDir, "space-5.json"), "utf8"),
    );
    assert.deepEqual(parsed, {
      spaceId: 5,
      nextLabel: 2,
      usedLabels: ["p1"],
      releasedLabels: [],
      initialized: true,
      userControlPending: false,
      unmanagedTargets: {},
      pages: {
        p1: {
          targetId: "target-a",
          openedBy: "agent",
        },
      },
    });
  });
});

test("old ledger metadata is accepted and removed on the next write", async () => {
  await withTempLedger(async (rootDir) => {
    const path = join(rootDir, "space-12.json");
    await writeFile(
      path,
      JSON.stringify({
        spaceId: 12,
        version: 4,
        writerRound: "old-round",
        nextLabel: 2,
        usedLabels: ["p1"],
        releasedLabels: [],
        initialized: true,
        unmanagedTargets: {},
        pages: {
          p1: {
            targetId: "target-old",
            openedBy: "agent",
            openedAt: 100,
            lastUsedAt: 200,
          },
        },
        touchedAt: 200,
      }),
    );
    const store = new PageLedgerStore({ rootDir });

    assert.deepEqual(await store.getPage(12, "p1"), {
      label: "p1",
      targetId: "target-old",
      openedBy: "agent",
    });
    await store.addPage(12, "target-new");

    const persisted = JSON.parse(await readFile(path, "utf8"));
    assert.equal(Object.hasOwn(persisted, "version"), false);
    assert.equal(Object.hasOwn(persisted, "writerRound"), false);
    assert.equal(Object.hasOwn(persisted, "touchedAt"), false);
    assert.equal(Object.hasOwn(persisted.pages.p1, "openedAt"), false);
    assert.equal(Object.hasOwn(persisted.pages.p1, "lastUsedAt"), false);
  });
});

test("old handoff baselines migrate to a pending user-control boundary", async () => {
  await withTempLedger(async (rootDir) => {
    const path = join(rootDir, "space-13.json");
    await writeFile(
      path,
      JSON.stringify({
        spaceId: 13,
        nextLabel: 2,
        usedLabels: ["p1"],
        releasedLabels: [],
        initialized: true,
        handoffBaseline: ["target-agent"],
        unmanagedTargets: {},
        pages: {
          p1: { targetId: "target-agent", openedBy: "agent" },
        },
      }),
    );
    const store = new PageLedgerStore({ rootDir });

    const restored = await store.read(13);
    assert.equal(restored.userControlPending, true);

    await store.reconcile(13, ["target-agent", "target-user"], {
      autoAdoptNew: true,
    });
    const persisted = JSON.parse(await readFile(path, "utf8"));
    assert.equal(persisted.userControlPending, false);
    assert.equal(Object.hasOwn(persisted, "handoffBaseline"), false);
    assert.equal(persisted.unmanagedTargets["target-user"], "unknown");
  });
});

test("legacy user origins are read conservatively as unknown", async () => {
  await withTempLedger(async (rootDir) => {
    const path = join(rootDir, "space-14.json");
    await writeFile(
      path,
      JSON.stringify({
        spaceId: 14,
        nextLabel: 2,
        usedLabels: ["p1"],
        releasedLabels: [],
        initialized: true,
        unmanagedTargets: { "target-unmanaged": "user" },
        pages: {
          p1: { targetId: "target-managed", openedBy: "user" },
        },
      }),
    );

    const restored = await new PageLedgerStore({ rootDir }).read(14);

    assert.equal(restored.pages.p1.openedBy, "unknown");
    assert.equal(restored.unmanagedTargets["target-unmanaged"], "unknown");
  });
});

test("release removes a managed page without making its label reusable", async () => {
  await withTempLedger(async (rootDir) => {
    const store = new PageLedgerStore({ rootDir });
    const released = await store.addPage(3, "target-user", {
      openedBy: "unknown",
    });

    assert.deepEqual(await store.releasePage(3, released.label), released);
    await assert.rejects(
      () => store.getPage(3, released.label),
      /page p1 was released/,
    );

    const next = await store.addPage(3, "target-next");
    assert.equal(next.label, "p2");

    const reconciled = await store.reconcile(
      3,
      ["target-user", "target-next"],
      { autoAdoptNew: true },
    );
    assert.equal(
      Object.values(reconciled.pages).some(
        (page) => page.targetId === "target-user",
      ),
      false,
      "a released user page must not be silently adopted again",
    );
    assert.equal(reconciled.unmanagedTargets["target-user"], "unknown");
  });
});

test("different spaces update independently", async () => {
  await withTempLedger(async (rootDir) => {
    const first = new PageLedgerStore({ rootDir });
    const second = new PageLedgerStore({ rootDir });

    const [pageA, pageB] = await Promise.all([
      first.addPage(1, "target-a"),
      second.addPage(2, "target-b"),
    ]);

    assert.equal(pageA.label, "p1");
    assert.equal(pageB.label, "p1");
  });
});

test("discard removes one completed space without affecting another", async () => {
  await withTempLedger(async (rootDir) => {
    const store = new PageLedgerStore({ rootDir });
    await store.addPage(7, "target-7");
    await store.addPage(8, "target-8");

    await store.discard(7);

    assert.deepEqual((await store.read(7)).pages, {});
    assert.deepEqual((await store.read(8)).pages, {
      p1: { targetId: "target-8", openedBy: "agent" },
    });
  });
});

test("reconciliation removes missing targets but permanently retires their labels", async () => {
  await withTempLedger(async (rootDir) => {
    const store = new PageLedgerStore({ rootDir });
    await store.addPage(4, "target-live");
    await store.addPage(4, "target-closed");

    const reconciled = await store.reconcile(4, ["target-live"]);

    assert.deepEqual(Object.keys(reconciled.pages), ["p1"]);
    assert.deepEqual(reconciled.usedLabels, ["p1", "p2"]);
    await assert.rejects(() => store.getPage(4, "p2"), /page p2 was closed/);
    const next = await store.addPage(4, "target-next");
    assert.equal(next.label, "p3");
  });
});

test("reconciliation leaves the ledger unchanged when every target is live", async () => {
  await withTempLedger(async (rootDir) => {
    const store = new PageLedgerStore({ rootDir });
    await store.addPage(6, "target-live");
    const before = await store.read(6);

    const after = await store.reconcile(6, ["target-live", "target-unknown"]);

    assert.deepEqual(after.pages, before.pages);
  });
});

test("reconciliation protects the first control baseline and adopts later agent tabs", async () => {
  await withTempLedger(async (rootDir) => {
    const store = new PageLedgerStore({ rootDir });

    const baseline = await store.reconcile(8, ["target-user"], {
      autoAdoptNew: true,
    });
    assert.deepEqual(baseline.pages, {});
    assert.equal(baseline.unmanagedTargets["target-user"], "unknown");

    const reconciled = await store.reconcile(
      8,
      ["target-user", "target-popup"],
      { autoAdoptNew: true },
    );
    assert.equal(reconciled.pages.p1.targetId, "target-popup");
    assert.equal(reconciled.pages.p1.openedBy, "agent");
    assert.equal(reconciled.unmanagedTargets["target-user"], "unknown");
  });
});

test("tabs opened during handoff remain unknown after takeover", async () => {
  await withTempLedger(async (rootDir) => {
    const firstRound = new PageLedgerStore({ rootDir });
    await firstRound.addPage(8, "target-agent");
    await firstRound.beginUserControl(8);

    const secondRound = new PageLedgerStore({ rootDir });
    const afterTakeover = await secondRound.reconcile(
      8,
      ["target-agent", "target-user"],
      { autoAdoptNew: true },
    );

    assert.equal(afterTakeover.userControlPending, false);
    assert.equal(afterTakeover.unmanagedTargets["target-user"], "unknown");
    assert.deepEqual(afterTakeover.pages, {
      p1: { targetId: "target-agent", openedBy: "agent" },
    });

    const laterAgentPopup = await secondRound.reconcile(
      8,
      ["target-agent", "target-user", "target-popup"],
      { autoAdoptNew: true },
    );
    assert.equal(laterAgentPopup.pages.p2.targetId, "target-popup");
    assert.equal(laterAgentPopup.pages.p2.openedBy, "agent");
  });
});

test("an explicitly unmanaged anchor is not adopted during reconciliation", async () => {
  await withTempLedger(async (rootDir) => {
    const store = new PageLedgerStore({ rootDir });
    await store.reconcile(10, [], { autoAdoptNew: true });
    await store.keepUnmanaged(10, "target-anchor", "unknown");

    const reconciled = await store.reconcile(10, ["target-anchor"], {
      autoAdoptNew: true,
    });

    assert.deepEqual(reconciled.pages, {});
    assert.equal(reconciled.unmanagedTargets["target-anchor"], "unknown");
  });
});
