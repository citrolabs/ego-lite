import test from "node:test";
import assert from "node:assert/strict";

import { formatCliLogValue } from "../dist/src/format.js";

test("formatCliLogValue renders documented function properties in object output", () => {
  const formatted = formatCliLogValue({
    helpers: {
      page: {
        waitForRequest() {},
        waitForResponse() {},
      },
      browser: {
        openOrReuseTab() {},
      },
      site: {
        runTool: async function runSiteTool() {},
      },
    },
  });

  const parsed = JSON.parse(formatted);
  assert.equal(parsed.helpers.browser.openOrReuseTab.kind, "function");
  assert.equal(
    parsed.helpers.browser.openOrReuseTab.signature,
    "browser.openOrReuseTab(url, options?) => Promise<object>",
  );
  assert.equal(
    parsed.helpers.page.waitForRequest.signature,
    "page.waitForRequest(urlOrPredicate, options?) => Promise<Request>",
  );
  assert.equal(
    parsed.helpers.page.waitForResponse.signature,
    "page.waitForResponse(urlOrPredicate, options?) => Promise<Response>",
  );
  assert.equal(parsed.helpers.site.runTool.name, "runTool");
  assert.equal(
    parsed.helpers.site.runTool.signature,
    "site.runTool(siteId, toolName, args?) => Promise<tool result>",
  );
  assert.equal(parsed.helpers.site.runTool.params[0].name, "siteId");
});

test("formatCliLogValue documents page.url as asynchronous", () => {
  const formatted = formatCliLogValue({
    helpers: { page: { url() {} } },
  });

  const parsed = JSON.parse(formatted);
  assert.equal(
    parsed.helpers.page.url.signature,
    "page.url() => Promise<string>",
  );
  assert.match(parsed.helpers.page.url.example, /await page\.url\(\)/);
});

test("formatCliLogValue documents deterministic CSS viewport sizing", () => {
  const formatted = formatCliLogValue({
    helpers: { page: { setViewportSize() {} } },
  });

  const parsed = JSON.parse(formatted);
  assert.equal(
    parsed.helpers.page.setViewportSize.signature,
    "page.setViewportSize(viewport) => Promise<void>",
  );
  assert.match(parsed.helpers.page.setViewportSize.description, /CSS pixels/);
  assert.match(parsed.helpers.page.setViewportSize.example, /390.*844/);
});

test("formatCliLogValue documents ego.learnings as the site facade alias", () => {
  const formatted = formatCliLogValue({
    learnings: {
      runTool: async function runSiteTool() {},
    },
  });

  const parsed = JSON.parse(formatted);
  assert.equal(parsed.learnings.runTool.kind, "function");
  assert.equal(
    parsed.learnings.runTool.signature,
    "learnings.runTool(siteId, toolName, args?) => Promise<tool result>",
  );
  assert.match(parsed.learnings.runTool.example, /learnings\.learnContext/);
  assert.match(parsed.learnings.runTool.example, /learnings\.runTool/);
});

test("formatCliLogValue documents the waitForURL matcher and default", () => {
  const formatted = formatCliLogValue({
    helpers: { page: { waitForURL() {} } },
  });

  const parsed = JSON.parse(formatted);
  assert.equal(
    parsed.helpers.page.waitForURL.signature,
    "page.waitForURL(url, options?) => Promise<boolean>",
  );
  assert.match(
    parsed.helpers.page.waitForURL.description,
    /predicate receiving a URL object.*load by default/,
  );
});

test("formatCliLogValue handles nested bigint and circular references", () => {
  const value = { id: 1n, child: {} };
  value.child.self = value;

  const formatted = formatCliLogValue(value);

  const parsed = JSON.parse(formatted);
  assert.equal(parsed.id, "1n");
  assert.equal(parsed.child.self, "[Circular]");
});

test("formatCliLogValue documents unsupported permission CDP methods", () => {
  const formatted = formatCliLogValue({ cdp() {} });

  const parsed = JSON.parse(formatted);
  assert.match(parsed.cdp.description, /Browser\.grantPermissions/);
  assert.match(parsed.cdp.description, /Browser\.setPermission/);
  assert.match(parsed.cdp.description, /not exposed/);
});
