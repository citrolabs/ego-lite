import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
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

/** Parse the highest-numbered version of one ledger, e.g. base "space-5@browser-a". */
async function readLatest(rootDir, base) {
  const versions = (await readdir(rootDir))
    .map((name) => ({
      name,
      seq: Number(new RegExp(`^${base}\\.(\\d+)\\.json$`).exec(name)?.[1]),
    }))
    .filter((file) => Number.isInteger(file.seq))
    .sort((a, b) => b.seq - a.seq);
  assert.ok(versions.length > 0, `no ledger version for ${base}`);
  return JSON.parse(await readFile(join(rootDir, versions[0].name), "utf8"));
}

function sharingViolation(code, syscall) {
  const error = new Error(`${code}: operation not permitted, ${syscall}`);
  error.code = code;
  return error;
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

test("Page ref state survives a process restart but not a browser restart or Page close", async () => {
  await withTempLedger(async (rootDir) => {
    const first = new PageLedgerStore({
      rootDir,
      browserInstanceId: "browser-a",
    });
    await first.addPage(7, "page-a");
    const refs = {
      nextRef: 3,
      refs: [
        {
          refId: "1",
          backendNodeId: 42,
          documentId: "document-a",
          active: false,
        },
        {
          refId: "2",
          backendNodeId: 43,
          documentId: "document-a",
          active: true,
        },
      ],
    };
    await first.setPageRefs(7, "p1", refs);
    const resumed = new PageLedgerStore({
      rootDir,
      browserInstanceId: "browser-a",
    });
    assert.deepEqual((await resumed.getPage(7, "p1")).refs, refs);
    const restarted = new PageLedgerStore({
      rootDir,
      browserInstanceId: "browser-b",
    });
    await assert.rejects(
      () => restarted.getPage(7, "p1"),
      /page label not found/,
    );
    await resumed.closePage(7, "p1");
    assert.deepEqual((await resumed.read(7)).pages, {});
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

    const persisted = await readLatest(rootDir, "space-7@browser-b");
    assert.equal(persisted.browserInstanceId, "browser-b");
  });
});

test("concurrent browser instances keep separate ledgers for the same space id", async () => {
  await withTempLedger(async (rootDir) => {
    const browserA = new PageLedgerStore({
      rootDir,
      browserInstanceId: "browser-host:101",
    });
    const browserB = new PageLedgerStore({
      rootDir,
      browserInstanceId: "browser-host:202",
    });

    const pageA = await browserA.initializeCreatedSpace(1, "target-a");
    const pageB = await browserB.initializeCreatedSpace(1, "target-b");
    await browserB.addPage(1, "target-b2");
    await browserA.addPage(1, "target-a2");

    assert.deepEqual(await browserA.getPage(1, "p1"), pageA);
    assert.deepEqual(await browserB.getPage(1, "p1"), pageB);
    assert.equal((await browserA.getPage(1, "p2")).targetId, "target-a2");
    assert.equal((await browserB.getPage(1, "p2")).targetId, "target-b2");

    await browserB.discard(1);
    assert.deepEqual(await browserA.getPage(1, "p1"), pageA);
    assert.deepEqual((await readdir(rootDir)).sort(), [
      "space-1@browser-host-101.2.json",
    ]);
  });
});

test("a shared-name ledger from this browser instance moves to its own file", async () => {
  await withTempLedger(async (rootDir) => {
    const legacyPath = join(rootDir, "space-7.json");
    await writeFile(
      legacyPath,
      JSON.stringify({
        browserInstanceId: "browser-host:101",
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

    const otherBrowser = new PageLedgerStore({
      rootDir,
      browserInstanceId: "browser-host:202",
    });
    assert.deepEqual((await otherBrowser.read(7)).pages, {});
    await readFile(legacyPath, "utf8");

    const sameBrowser = new PageLedgerStore({
      rootDir,
      browserInstanceId: "browser-host:101",
    });
    assert.equal((await sameBrowser.getPage(7, "p1")).targetId, "target-live");
    await assert.rejects(() => readFile(legacyPath, "utf8"), {
      code: "ENOENT",
    });
    assert.equal(
      (await readLatest(rootDir, "space-7@browser-host-101")).pages.p1.targetId,
      "target-live",
    );
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
      (await readLatest(rootDir, "space-7@browser-current")).browserInstanceId,
      "browser-current",
    );
    await assert.rejects(() => readFile(path, "utf8"), { code: "ENOENT" });
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
    const staleVersionPath = join(rootDir, "space-98@browser-a.3.json");
    await writeFile(
      staleVersionPath,
      JSON.stringify({ browserInstanceId: "browser-a", spaceId: 98 }),
    );
    await utimes(staleVersionPath, new Date(0), new Date(0));

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
    await assert.rejects(() => readFile(staleVersionPath, "utf8"), {
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

test("writes use a complete ledger document", async () => {
  await withTempLedger(async (rootDir) => {
    const store = new PageLedgerStore({ rootDir });
    await store.addPage(5, "target-a");

    const parsed = await readLatest(rootDir, "space-5");
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

test("each write creates a new version and removes the superseded ones", async () => {
  await withTempLedger(async (rootDir) => {
    const store = new PageLedgerStore({ rootDir });
    await store.addPage(5, "target-a");
    assert.deepEqual(await readdir(rootDir), ["space-5.1.json"]);

    await store.addPage(5, "target-b");
    assert.deepEqual(await readdir(rootDir), ["space-5.2.json"]);
    assert.deepEqual(
      Object.keys((await readLatest(rootDir, "space-5")).pages),
      ["p1", "p2"],
    );
  });
});

test("a superseded version held open by another process is left behind and ignored", async () => {
  await withTempLedger(async (rootDir) => {
    // Windows refuses to delete (or rename over) a file that another process
    // holds without delete sharing. Only the removal is affected: the next
    // version is still created, and readers pick it up.
    let held;
    const store = new PageLedgerStore({
      rootDir,
      remove: async (path) => {
        if (path === held) throw sharingViolation("EBUSY", "unlink");
        await rm(path, { force: true });
      },
    });
    await store.addPage(5, "target-a");
    held = join(rootDir, "space-5.1.json");

    const page = await store.addPage(5, "target-b");

    assert.equal(page.label, "p2");
    assert.deepEqual((await readdir(rootDir)).sort(), [
      "space-5.1.json",
      "space-5.2.json",
    ]);
    const nextRound = new PageLedgerStore({ rootDir });
    assert.deepEqual(Object.keys((await nextRound.read(5)).pages), [
      "p1",
      "p2",
    ]);

    held = undefined;
    await store.addPage(5, "target-c");
    assert.deepEqual(await readdir(rootDir), ["space-5.3.json"]);
  });
});

test("a version that is unreadable or still being written falls back to the previous one", async () => {
  await withTempLedger(async (rootDir) => {
    const store = new PageLedgerStore({ rootDir });
    await store.addPage(5, "target-a");
    await writeFile(
      join(rootDir, "space-5.2.json"),
      '{"spaceId": 5, "nextLabel": 3, "usedLabels": ["p1", "p2"], "pages": {',
    );

    assert.deepEqual(Object.keys((await store.read(5)).pages), ["p1"]);

    const page = await store.addPage(5, "target-b");
    assert.equal(page.label, "p2");
    assert.deepEqual(await readdir(rootDir), ["space-5.3.json"]);
  });
});

test("concurrent writers never lose each other's update", async () => {
  await withTempLedger(async (rootDir) => {
    const roundA = new PageLedgerStore({ rootDir });
    const roundB = new PageLedgerStore({ rootDir });
    await roundA.addPage(5, "target-seed");

    const [pageA, pageB] = await Promise.all([
      roundA.addPage(5, "target-a"),
      roundB.addPage(5, "target-b"),
    ]);

    assert.notEqual(pageA.label, pageB.label);
    const ledger = await roundA.read(5);
    assert.deepEqual(
      Object.values(ledger.pages)
        .map((page) => page.targetId)
        .sort(),
      ["target-a", "target-b", "target-seed"],
    );
    assert.deepEqual(ledger.usedLabels, ["p1", "p2", "p3"]);
    assert.deepEqual(await readdir(rootDir), ["space-5.3.json"]);
  });
});

test("discard tolerates a version that cannot be removed yet", async () => {
  await withTempLedger(async (rootDir) => {
    const store = new PageLedgerStore({
      rootDir,
      remove: async () => {
        throw sharingViolation("EPERM", "unlink");
      },
    });
    await store.addPage(5, "target-a");

    await store.discard(5);

    assert.deepEqual(await readdir(rootDir), ["space-5.1.json"]);
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

    await assert.rejects(() => readFile(path, "utf8"), { code: "ENOENT" });
    const persisted = await readLatest(rootDir, "space-12");
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
    const persisted = await readLatest(rootDir, "space-13");
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
    await store.keepUnmanaged(10, "target-anchor", "agent");

    const reconciled = await store.reconcile(10, ["target-anchor"], {
      autoAdoptNew: true,
    });

    assert.deepEqual(reconciled.pages, {});
    assert.equal(reconciled.unmanagedTargets["target-anchor"], "agent");
  });
});
