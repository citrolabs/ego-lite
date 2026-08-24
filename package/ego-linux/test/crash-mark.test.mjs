import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearStaleCrashMark } from "../src/chrome.mjs";

/**
 * Build a profile directory whose Preferences carry the given profile block.
 *
 * No browser is launched here on purpose. The end-to-end effect needs a real
 * Chrome and is therefore sensitive to machine load — what has to be exact is
 * the rule itself: a profile that starts out marked never clears the mark on
 * its own, so the launcher must clear it before Chrome reads it.
 */
async function profileWith(profileBlock) {
  const dir = await mkdtemp(join(tmpdir(), "ego-crash-mark-"));
  await mkdir(join(dir, "Default"), { recursive: true });
  if (profileBlock !== undefined) {
    await writeFile(
      join(dir, "Default", "Preferences"),
      JSON.stringify({ profile: profileBlock, bookmark_bar: { show_on_all_tabs: true } }),
    );
  }
  return dir;
}

async function exitTypeOf(dir) {
  return JSON.parse(await readFile(join(dir, "Default", "Preferences"), "utf8")).profile?.exit_type;
}

describe("clearStaleCrashMark", () => {
  it("clears a mark left by an ungraceful kill", async () => {
    const dir = await profileWith({ exit_type: "Crashed", name: "ego lite — agent" });
    try {
      assert.equal(await clearStaleCrashMark(dir), true, "reports that it changed something");
      assert.equal(await exitTypeOf(dir), "Normal");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps every other preference intact", async () => {
    const dir = await profileWith({ exit_type: "Crashed", name: "ego lite — agent", avatar_index: 26 });
    try {
      await clearStaleCrashMark(dir);
      const prefs = JSON.parse(await readFile(join(dir, "Default", "Preferences"), "utf8"));
      assert.equal(prefs.profile.name, "ego lite — agent", "sibling keys survive");
      assert.equal(prefs.profile.avatar_index, 26);
      assert.deepEqual(prefs.bookmark_bar, { show_on_all_tabs: true }, "other top-level blocks survive");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves an unmarked profile untouched", async () => {
    const dir = await profileWith({ exit_type: "Normal" });
    try {
      const before = await readFile(join(dir, "Default", "Preferences"), "utf8");
      assert.equal(await clearStaleCrashMark(dir), false, "reports that it changed nothing");
      assert.equal(await readFile(join(dir, "Default", "Preferences"), "utf8"), before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op on a profile that has no Preferences yet", async () => {
    const dir = await profileWith(undefined);
    try {
      assert.equal(await clearStaleCrashMark(dir), false, "a fresh profile is not an error");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
