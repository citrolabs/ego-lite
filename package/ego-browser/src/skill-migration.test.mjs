import test from "node:test";
import assert from "node:assert/strict";

import {
  STALE_SKILL_PREFIX,
  createStaleEgoBrowserGuard,
  installStaleEgoBrowserGuard,
} from "../dist/src/skill-migration.js";

test("the 1.3 egoBrowser namespace stops with current API guidance", () => {
  const egoBrowser = createStaleEgoBrowserGuard();

  for (const method of ["newTaskSpace", "switchTaskSpace", "helper", "site"]) {
    assert.throws(
      () => egoBrowser[method],
      (error) => {
        assert.equal(error.name, "EgoBrowserSkillStaleError");
        assert.ok(error.message.startsWith(STALE_SKILL_PREFIX));
        assert.match(error.message, new RegExp(`egoBrowser\\.${method}`));
        assert.match(error.message, /Run `ego-browser skill`/);
        assert.match(error.message, /taskSpace\(nameOrId\)/);
        return true;
      },
    );
  }
});

test("the stale-skill guard does not invent unrelated namespace members", () => {
  const egoBrowser = createStaleEgoBrowserGuard();

  assert.equal(egoBrowser.unknownFutureMethod, undefined);
  assert.equal(egoBrowser.then, undefined);
  assert.equal(egoBrowser[Symbol.toStringTag], undefined);
  assert.deepEqual(Object.keys(egoBrowser), []);
});

test("the SDK guard is non-enumerable and leaves 1.2.3 globals alone", () => {
  const legacyClick = () => {};
  const target = { click: legacyClick };

  installStaleEgoBrowserGuard(target);

  assert.equal(target.click, legacyClick);
  assert.equal(
    Object.prototype.propertyIsEnumerable.call(target, "egoBrowser"),
    false,
  );
  assert.throws(() => target.egoBrowser.newTaskSpace, /skill-stale/);
});
