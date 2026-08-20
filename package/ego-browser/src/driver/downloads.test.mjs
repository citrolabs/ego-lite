import test from "node:test";
import assert from "node:assert/strict";

import {
  clearPreferredTarget,
  drainBrowserEvents,
  invalidateSession,
} from "../../dist/src/browser-runtime.js";
import { state } from "../../dist/src/state.js";
import { waitForEvent } from "../../dist/src/driver/downloads.js";

function installAutoEgo(options = {}) {
  const calls = [];
  globalThis.ego = {
    async listTabs() {
      return { tabs: [{ targetId: "tab-1", active: true }] };
    },
    sendCDPMessage(payload) {
      const parsed = JSON.parse(payload);
      calls.push(parsed);
      setTimeout(() => {
        if (
          options.browserSetDownloadBehaviorError &&
          parsed.method === "Browser.setDownloadBehavior"
        ) {
          globalThis.ego?.onCDPMessage?.(
            JSON.stringify({
              id: parsed.id,
              error: { message: "'Browser.setDownloadBehavior' wasn't found" },
            }),
          );
          return;
        }
        const result =
          parsed.method === "Target.attachToTarget"
            ? { sessionId: `sess-${parsed.id}` }
            : {};
        globalThis.ego?.onCDPMessage?.(
          JSON.stringify({ id: parsed.id, result }),
        );
      }, 0);
    },
  };
  return calls;
}

// Fire on the active page session by default. Download events arrive on the
// session ego-browser attached to; the waiters are now scoped to that session
// (issue #204), so events must carry the same sessionId ego-browser resolved.
function fireEvent(method, params = {}, sessionId = state.sessionId) {
  globalThis.ego.onCDPMessage(JSON.stringify({ method, params, sessionId }));
}

function cleanup() {
  delete globalThis.ego;
  invalidateSession();
  clearPreferredTarget();
  drainBrowserEvents();
}

test("waitForEvent('download') returns a Playwright-style download facade", async () => {
  const calls = installAutoEgo();
  try {
    const promise = waitForEvent("download", { timeout: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    fireEvent("Page.downloadWillBegin", {
      guid: "download-1",
      url: "https://example.com/file.png",
      suggestedFilename: "file.png",
    });
    fireEvent("Page.downloadProgress", {
      guid: "download-1",
      state: "completed",
    });
    const download = await promise;
    assert.equal(download.suggestedFilename(), "file.png");
    assert.equal(download.url(), "https://example.com/file.png");
    assert.match(await download.path(), /file\.png$/);
    assert.ok(
      calls.some((call) => call.method === "Browser.setDownloadBehavior"),
      "enables browser download behavior",
    );
  } finally {
    cleanup();
  }
});

test("waitForEvent('download') rejects when the download is canceled", async () => {
  installAutoEgo();
  try {
    const promise = waitForEvent("download", { timeout: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    fireEvent("Page.downloadWillBegin", {
      guid: "download-1",
      suggestedFilename: "file.png",
    });
    fireEvent("Page.downloadProgress", {
      guid: "download-1",
      state: "canceled",
    });
    await assert.rejects(promise, /Download canceled: file\.png/);
  } finally {
    cleanup();
  }
});

test("waitForEvent('download') falls back to Page.setDownloadBehavior", async () => {
  const calls = installAutoEgo({ browserSetDownloadBehaviorError: true });
  try {
    const promise = waitForEvent("download", { timeout: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    fireEvent("Page.downloadWillBegin", {
      guid: "download-1",
      suggestedFilename: "file.png",
    });
    fireEvent("Page.downloadProgress", {
      guid: "download-1",
      state: "completed",
    });
    await promise;
    assert.ok(
      calls.some((call) => call.method === "Page.setDownloadBehavior"),
      "uses page-level download behavior when browser-level command is missing",
    );
  } finally {
    cleanup();
  }
});
