import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SANDBOX = await mkdtemp(join(tmpdir(), "ego-trail-test-"));
process.env.XDG_STATE_HOME = join(SANDBOX, "state");

const { STATE_DIR, TASK_SPACE_FILE } = await import("../src/paths.mjs");
const { createTaskSpacesApi } = await import("../src/task-spaces.mjs");

const MINUTE = 60000;

function fakeCdp() {
  return {
    async call(method) {
      if (method === "Target.getTargets") {
        return {
          targetInfos: [
            { type: "page", targetId: "t-1", url: "https://foxglove.example/a" },
          ],
        };
      }
      if (method === "Target.createTarget") return { targetId: "new-tab" };
      if (method === "Target.createBrowserContext") return { browserContextId: "ctx" };
      return {};
    },
  };
}

async function seedIdleSpace() {
  const at = Date.now() - 90 * MINUTE;
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(
    TASK_SPACE_FILE,
    JSON.stringify({
      spaces: [
        {
          id: 1,
          taskId: 1,
          name: "long running work",
          createdAt: at,
          touchedAt: at,
          lastContentAt: at,
          ownership: "agent",
          targetIds: ["t-1"],
          urls: ["https://foxglove.example/a", "about:blank"],
        },
      ],
      selectedId: null,
      nextId: 2,
      closedSpaces: [],
    }),
  );
}

describe("an idle-closed space leaves something to come back to", () => {
  it("records what it held when the sweep closes it", async () => {
    process.env.EGO_LINUX_SPACE_IDLE_MIN = "30";
    await seedIdleSpace();

    await createTaskSpacesApi(fakeCdp()).listTaskSpaces();

    const state = JSON.parse(await readFile(TASK_SPACE_FILE, "utf8"));
    assert.equal(state.spaces.length, 0, "the space is closed");
    assert.equal(state.closedSpaces.length, 1, "and remembered");

    const [closure] = state.closedSpaces;
    assert.equal(closure.name, "long running work");
    assert.deepEqual(
      closure.urls,
      ["https://foxglove.example/a"],
      "about:blank is not worth handing back",
    );
    assert.ok(closure.idleMinutes >= 89, "with how long it had sat");
  });

  it("hands that back to whoever asks for the name again", async () => {
    process.env.EGO_LINUX_SPACE_IDLE_MIN = "30";
    await seedIdleSpace();
    const api = createTaskSpacesApi(fakeCdp());
    await api.listTaskSpaces();

    // What useOrCreate does once it cannot find the name it was given.
    const space = await api.createTaskSpace("long running work");

    assert.ok(space.previously, "the new space knows it is a replacement");
    assert.deepEqual(space.previously.urls, ["https://foxglove.example/a"]);
    assert.match(space.previously.note, /closed after \d+ minutes idle/);
    assert.match(space.previously.note, /this is a new, empty one/);

    // Reported once: a later space of the same name is simply a new space.
    const again = await api.createTaskSpace("long running work");
    assert.equal(again.previously, undefined);
  });

  it("says nothing for a name that was never closed", async () => {
    process.env.EGO_LINUX_SPACE_IDLE_MIN = "0";
    await seedIdleSpace();
    const api = createTaskSpacesApi(fakeCdp());

    const space = await api.createTaskSpace("something else entirely");
    assert.equal(space.previously, undefined);
  });
});
