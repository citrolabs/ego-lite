import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Its own state dir: this suite rewrites the task-space file to imitate a second
// session, and must never do that to the spaces a real session is driving.
const SANDBOX = await mkdtemp(join(tmpdir(), "ego-pin-test-"));
process.env.XDG_STATE_HOME = join(SANDBOX, "state");
// The idle sweep is a separate concern; keep it out of these assertions.
process.env.EGO_LINUX_SPACE_IDLE_MIN = "0";

const { STATE_DIR, TASK_SPACE_FILE } = await import("../src/paths.mjs");
const { createTaskSpacesApi } = await import("../src/task-spaces.mjs");

const fakeCdp = {
  async call(method) {
    if (method === "Target.getTargets") {
      return {
        targetInfos: [
          { type: "page", targetId: "t-a", url: "https://a.example", browserContextId: "ctx-a" },
          { type: "page", targetId: "t-b", url: "https://b.example", browserContextId: "ctx-b" },
        ],
      };
    }
    return {};
  },
};

function space(id, targetId, browserContextId) {
  const at = Date.now();
  return {
    id,
    taskId: id,
    name: `space ${id}`,
    createdAt: at,
    touchedAt: at,
    lastContentAt: at,
    ownership: "agent",
    browserContextId,
    targetIds: [targetId],
  };
}

async function seed(selectedId) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(
    TASK_SPACE_FILE,
    JSON.stringify({
      spaces: [space(1, "t-a", "ctx-a"), space(2, "t-b", "ctx-b")],
      selectedId,
      nextId: 3,
    }),
  );
}

/** What a concurrently running second session does on its way in. */
async function otherSessionSelects(id) {
  const state = JSON.parse(await readFile(TASK_SPACE_FILE, "utf8"));
  state.selectedId = id;
  await writeFile(TASK_SPACE_FILE, JSON.stringify(state));
}

describe("a process stays in the space it chose", () => {
  it("ignores a second session reassigning the shared selection", async () => {
    await seed(null);
    const api = createTaskSpacesApi(fakeCdp);
    await api.useTaskSpace(1);

    // The exact race: another agent starts up and claims the shared selection
    // while this one is still working.
    await otherSessionSelects(2);

    const scope = await api.selectedScope();
    assert.equal(
      scope.browserContextId,
      "ctx-a",
      "scope still points at the space this process chose",
    );
    assert.ok(scope.targetIds.has("t-a"), "and at its tab");
    assert.ok(
      !scope.targetIds.has("t-b"),
      "not the other session's tab — this is what navigated a stranger's page",
    );

    // requireSpace with no id is what every unqualified call resolves through.
    const current = await api.completeTaskSpace();
    assert.deepEqual(current, { done: true });
    const after = JSON.parse(await readFile(TASK_SPACE_FILE, "utf8"));
    assert.equal(
      after.spaces.find((s) => s.id === 1).ownership,
      "user",
      "an unqualified call acted on the pinned space, not the reassigned one",
    );
    assert.equal(
      after.spaces.find((s) => s.id === 2).ownership,
      "agent",
      "and left the other session's space untouched",
    );
  });

  it("still follows the file when this process has not chosen yet", async () => {
    // A fresh heredoc that never names a space is exactly who the shared value
    // is for — pinning must not break it.
    await seed(2);
    const scope = await createTaskSpacesApi(fakeCdp).selectedScope();
    assert.equal(scope.browserContextId, "ctx-b");
  });
});
