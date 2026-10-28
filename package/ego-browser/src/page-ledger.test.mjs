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

import {
  PageLedgerStore,
  renameWithRetry,
  runtimeInstanceId,
} from "../dist/src/page-ledger.js";

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

    const persisted = JSON.parse(
      await readFile(join(rootDir, "space-7@browser-b.json"), "utf8"),
    );
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
      "space-1@browser-host-101.json",
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
      JSON.parse(
        await readFile(join(rootDir, "space-7@browser-host-101.json"), "utf8"),
      ).pages.p1.targetId,
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
      JSON.parse(
        await readFile(join(rootDir, "space-7@browser-current.json"), "utf8"),
      ).browserInstanceId,
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

function sharingViolation(code = "EPERM") {
  const error = new Error(`${code}: operation not permitted, rename`);
  error.code = code;
  return error;
}

test("renameWithRetry retries transient Windows sharing violations with backoff", async () => {
  const calls = [];
  const delays = [];
  let failures = 3;
  await renameWithRetry("from", "to", {
    rename: async (from, to) => {
      calls.push([from, to]);
      if (failures-- > 0)
        throw sharingViolation(["EPERM", "EACCES", "EBUSY"][failures]);
    },
    sleep: async (ms) => {
      delays.push(ms);
    },
  });

  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0], ["from", "to"]);
  assert.deepEqual(delays, [20, 40, 80]);
});

test("renameWithRetry does not retry non-transient errors", async () => {
  let calls = 0;
  await assert.rejects(
    renameWithRetry("from", "to", {
      rename: async () => {
        calls += 1;
        throw sharingViolation("ENOENT");
      },
      sleep: async () => {
        assert.fail("must not sleep");
      },
    }),
    { code: "ENOENT" },
  );
  assert.equal(calls, 1);
});

test("renameWithRetry gives up after the attempt budget", async () => {
  let calls = 0;
  const delays = [];
  await assert.rejects(
    renameWithRetry("from", "to", {
      rename: async () => {
        calls += 1;
        throw sharingViolation();
      },
      sleep: async (ms) => {
        delays.push(ms);
      },
      attempts: 4,
    }),
    { code: "EPERM" },
  );
  assert.equal(calls, 5);
  assert.deepEqual(delays, [20, 40, 80, 160]);
});

test("renameWithRetry caps the delay between attempts", async () => {
  let failures = 6;
  const delays = [];
  await renameWithRetry("from", "to", {
    rename: async () => {
      if (failures-- > 0) throw sharingViolation();
    },
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  assert.deepEqual(delays, [20, 40, 80, 160, 250, 250]);
});

test("a ledger write survives a transient EPERM on the final rename", async () => {
  await withTempLedger(async (rootDir) => {
    const { rename } = await import("node:fs/promises");
    let failures = 2;
    let renames = 0;
    const store = new PageLedgerStore({
      rootDir,
      rename: {
        rename: async (from, to) => {
          renames += 1;
          if (failures-- > 0) throw sharingViolation();
          await rename(from, to);
        },
        sleep: async () => {},
      },
    });
    await store.addPage(5, "target-a");
    const page = await store.addPage(5, "target-b");

    assert.equal(page.label, "p2");
    // Two writes: the first needed three attempts, the second one.
    assert.equal(renames, 4);
    const parsed = JSON.parse(
      await readFile(join(rootDir, "space-5.json"), "utf8"),
    );
    assert.deepEqual(Object.keys(parsed.pages), ["p1", "p2"]);
    assert.deepEqual(
      (await readdir(rootDir)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  });
});

test("a persistent EPERM on the final rename still surfaces and leaves no temporary file", async () => {
  await withTempLedger(async (rootDir) => {
    const store = new PageLedgerStore({
      rootDir,
      rename: {
        rename: async () => {
          throw sharingViolation();
        },
        sleep: async () => {},
        attempts: 2,
      },
    });
    await assert.rejects(store.addPage(5, "target-a"), { code: "EPERM" });
    assert.deepEqual(await readdir(rootDir), []);
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
    await store.keepUnmanaged(10, "target-anchor", "agent");

    const reconciled = await store.reconcile(10, ["target-anchor"], {
      autoAdoptNew: true,
    });

    assert.deepEqual(reconciled.pages, {});
    assert.equal(reconciled.unmanagedTargets["target-anchor"], "agent");
  });
});
