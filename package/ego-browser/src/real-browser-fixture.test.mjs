import test from "node:test";
import assert from "node:assert/strict";

import {
  closeFixtureServer,
  startFixtureServer,
} from "../scripts/real-browser-e2e/fixture.mjs";

test("the real-browser fixture uses a non-recursive cross-site iframe", async () => {
  const fixture = await startFixtureServer("fixture contract test");
  try {
    const homeHtml = await fetch(fixture.baseUrl).then((response) =>
      response.text(),
    );
    const iframeSrc = homeHtml.match(
      /<iframe id="fixture-frame" src="([^"]+)"/,
    )?.[1];

    assert.ok(iframeSrc, "the home fixture exposes its iframe URL");
    assert.notEqual(
      new URL(iframeSrc).hostname,
      new URL(fixture.baseUrl).hostname,
      "the iframe must be cross-site so Chromium exposes an OOPIF target",
    );

    const frameHtml = await fetch(iframeSrc).then((response) =>
      response.text(),
    );
    assert.match(frameHtml, /id="iframe-marker"/);
    assert.match(frameHtml, /id="iframe-action"/);
    assert.match(frameHtml, /id="iframe-field"/);
    assert.doesNotMatch(
      frameHtml,
      /id="fixture-frame"/,
      "the frame fixture must not recursively embed itself",
    );
  } finally {
    await closeFixtureServer(fixture.server);
  }
});
