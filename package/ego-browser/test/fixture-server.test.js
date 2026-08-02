import assert from "node:assert/strict";
import test from "node:test";

import {
  closeFixtureServer,
  startFixtureServer,
} from "../scripts/real-browser-e2e/fixture.mjs";

test("fixture server contains route handler failures", async (t) => {
  const fixture = await startFixtureServer("route-failure-test");
  t.after(() => closeFixtureServer(fixture.server));

  const response = await fetch(`${fixture.baseUrl}/e2e/damai-rush/api/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
    signal: AbortSignal.timeout(500),
  });

  assert.equal(response.status, 500);
  assert.equal(await response.text(), "Internal Server Error");

  const health = await fetch(`${fixture.baseUrl}/healthz`);
  assert.equal(health.status, 200);
});
