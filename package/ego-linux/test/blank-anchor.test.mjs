import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SANDBOX = await mkdtemp(join(tmpdir(), "ego-anchor-test-"));
process.env.XDG_STATE_HOME = join(SANDBOX, "state");
process.env.EGO_LINUX_SPACE_IDLE_MIN = "0";

const { STATE_DIR, TASK_SPACE_FILE } = await import("../src/paths.mjs");
const { createTaskSpacesApi } = await import("../src/task-spaces.mjs");

/** A browser holding one tab for the space, at whatever url the test sets. */
function fakeCdp(anchorUrl) {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push({ method, params });
      if (method === "Target.getTargets") {
        return {
          targetInfos: [
            { type: "page", targetId: "anchor", url: anchorUrl, browserContextId: "ctx" },
          ],
        };
      }
      if (method === "Target.attachToTarget") return { sessionId: "s1" };
      if (method === "Target.createTarget") return { targetId: "fresh-tab" };
      return {};
    },
  };
}

const tabsApi = (cdp) => ({
  async createTab(url, browserContextId) {
    return cdp.call("Target.createTarget", { url, browserContextId });
  },
});

async function seed(space) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(
    TASK_SPACE_FILE,
    JSON.stringify({ spaces: [space], selectedId: 1, nextId: 2 }),
  );
}

const baseSpace = {
  id: 1,
  taskId: 1,
  name: "work",
  createdAt: Date.now(),
  touchedAt: Date.now(),
  ownership: "agent",
  browserContextId: "ctx",
  targetIds: ["anchor"],
};

describe("the space's blank anchor tab is used, not stranded", () => {
  it("navigates the anchor instead of opening a second tab", async () => {
    await seed({ ...baseSpace });
    const cdp = fakeCdp("about:blank");
    const api = createTaskSpacesApi(cdp);

    const result = await api.createTabInSelectedSpace(
      tabsApi(cdp),
      "https://example.com",
    );

    assert.equal(result.targetId, "anchor", "the anchor is what comes back");
    assert.ok(
      cdp.calls.some(
        (c) => c.method === "Page.navigate" && c.params.url === "https://example.com",
      ),
      "the anchor is navigated",
    );
    assert.ok(
      !cdp.calls.some((c) => c.method === "Target.createTarget"),
      "and no second tab is opened — this is the blank tab people were seeing",
    );
  });

  it("opens a new tab once the space has started work", async () => {
    // A tab is about:blank for a moment during every navigation, so reusing on
    // url alone would hijack a tab already carrying work. lastContentAt is what
    // separates "not started" from "between pages".
    await seed({ ...baseSpace, lastContentAt: Date.now() });
    const cdp = fakeCdp("about:blank");
    const api = createTaskSpacesApi(cdp);

    const result = await api.createTabInSelectedSpace(
      tabsApi(cdp),
      "https://example.com",
    );

    assert.equal(result.targetId, "fresh-tab");
    assert.ok(!cdp.calls.some((c) => c.method === "Page.navigate"));
  });

  it("opens a new tab when the anchor already holds a page", async () => {
    await seed({ ...baseSpace });
    const cdp = fakeCdp("https://already.example");
    const api = createTaskSpacesApi(cdp);

    const result = await api.createTabInSelectedSpace(
      tabsApi(cdp),
      "https://example.com",
    );

    assert.equal(result.targetId, "fresh-tab", "an occupied tab is never taken");
  });
});
