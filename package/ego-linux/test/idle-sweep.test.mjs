import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Its own state dir, for the reason the other suites have one: `npm test` must
// not read — or sweep — the task spaces a real session is driving.
const SANDBOX = await mkdtemp(join(tmpdir(), "ego-idle-test-"));
process.env.XDG_STATE_HOME = join(SANDBOX, "state");

// Imported after that assignment: paths.mjs resolves its directories at module
// load, so a static import would bind the real ones first.
const { STATE_DIR, TASK_SPACE_FILE } = await import("../src/paths.mjs");
const { createTaskSpacesApi } = await import("../src/task-spaces.mjs");

const MINUTE = 60000;

/** Both spaces' tabs are alive, so nothing but the idle rule can remove them. */
function fakeCdp(closed) {
  return {
    async call(method, params) {
      if (method === "Target.getTargets") {
        return {
          targetInfos: [
            { type: "page", targetId: "t-live", url: "https://example.com/a" },
            { type: "page", targetId: "t-idle", url: "https://example.com/b" },
          ],
        };
      }
      if (method === "Target.closeTarget") closed.push(params.targetId);
      return {};
    },
  };
}

function space(id, targetId, touchedAt) {
  const at = Date.now() - 90 * MINUTE;
  return {
    id,
    taskId: id,
    name: `space ${id}`,
    createdAt: at,
    // Set, so pruneAbandoned leaves these alone and only the idle rule applies.
    lastContentAt: at,
    ...(touchedAt === undefined ? {} : { touchedAt }),
    ownership: "agent",
    targetIds: [targetId],
  };
}

async function seed(spaces, selectedId = null) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(
    TASK_SPACE_FILE,
    JSON.stringify({ spaces, selectedId, nextId: 99 }),
  );
}

describe("idle task space sweep", () => {
  it("closes a space nobody came back to, and leaves a live one alone", async () => {
    process.env.EGO_LINUX_SPACE_IDLE_MIN = "30";
    const now = Date.now();
    await seed([
      space(1, "t-live", now - 5 * MINUTE),
      space(2, "t-idle", now - 31 * MINUTE),
    ]);

    const closed = [];
    const { taskSpaces } = await createTaskSpacesApi(
      fakeCdp(closed),
    ).listTaskSpaces();

    assert.deepEqual(
      taskSpaces.map((s) => s.id),
      [1],
      "the space touched five minutes ago survives",
    );
    assert.deepEqual(closed, ["t-idle"], "and the idle one's tab is closed");
  });

  it("never sweeps the selected space, however long it has sat", async () => {
    process.env.EGO_LINUX_SPACE_IDLE_MIN = "30";
    const now = Date.now();
    await seed([space(2, "t-idle", now - 300 * MINUTE)], 2);

    const closed = [];
    const { taskSpaces } = await createTaskSpacesApi(
      fakeCdp(closed),
    ).listTaskSpaces();

    assert.deepEqual(taskSpaces.map((s) => s.id), [2]);
    assert.deepEqual(closed, [], "the space someone is on is not swept");
  });

  it("gives a space with no idle history a full window instead of sweeping it", async () => {
    // The migration case: every space that predates touchedAt would otherwise be
    // judged by createdAt and swept the first time this ran — including one a
    // colleague session is halfway through.
    process.env.EGO_LINUX_SPACE_IDLE_MIN = "30";
    await seed([space(1, "t-live", undefined), space(2, "t-idle", undefined)]);

    const closed = [];
    const { taskSpaces } = await createTaskSpacesApi(
      fakeCdp(closed),
    ).listTaskSpaces();

    assert.deepEqual(
      taskSpaces.map((s) => s.id),
      [1, 2],
      "an unstamped space is stamped, not closed",
    );
    assert.deepEqual(closed, []);

    // The stamp has to persist, or every run would re-stamp and nothing would
    // ever reach the threshold.
    const again = await createTaskSpacesApi(fakeCdp([])).listTaskSpaces();
    for (const s of again.taskSpaces) {
      assert.ok(s.touchedAt, `space ${s.id} kept its stamp`);
    }
  });

  it("leaves a space the user was given, however long it has sat", async () => {
    // The keep: true path sets ownership "user" precisely to say "leave this
    // page open", and a handoff sets "agentDelegatedToUser" while a person is
    // logging in. Neither produces an API call, so both would look idle.
    process.env.EGO_LINUX_SPACE_IDLE_MIN = "30";
    const long = Date.now() - 300 * MINUTE;
    await seed([
      { ...space(1, "t-live", long), ownership: "user" },
      { ...space(2, "t-idle", long), ownership: "agentDelegatedToUser" },
    ]);

    const closed = [];
    const { taskSpaces } = await createTaskSpacesApi(
      fakeCdp(closed),
    ).listTaskSpaces();

    assert.deepEqual(
      taskSpaces.map((s) => s.id),
      [1, 2],
      "a space in a person's hands is never swept",
    );
    assert.deepEqual(closed, []);
  });

  it("can be turned off entirely", async () => {
    process.env.EGO_LINUX_SPACE_IDLE_MIN = "0";
    const now = Date.now();
    await seed([space(2, "t-idle", now - 5000 * MINUTE)]);

    const closed = [];
    const { taskSpaces } = await createTaskSpacesApi(
      fakeCdp(closed),
    ).listTaskSpaces();

    assert.deepEqual(taskSpaces.map((s) => s.id), [2]);
    assert.deepEqual(closed, [], "nothing is swept when the sweep is disabled");
  });
});
