import test from "node:test";
import assert from "node:assert/strict";

import { drainConsole, waitForConsole } from "../../dist/src/driver/console.js";
import {
  drainConsoleMessages,
  invalidateSession,
} from "../../dist/src/browser-runtime.js";

function installManualEgo() {
  globalThis.ego = {
    async listTabs() {
      return { tabs: [{ targetId: "tab-1", active: true }] };
    },
    sendCDPMessage(payload) {},
  };
}

function fireEvent(method, params = {}) {
  globalThis.ego.onCDPMessage(JSON.stringify({ method, params }));
}

function cleanup() {
  delete globalThis.ego;
  invalidateSession();
  drainConsoleMessages();
}

test("page facade drainConsole and waitForConsole delegate to browser runtime", async () => {
  const { browserCdp } = await import("../../dist/src/browser-runtime.js");
  installManualEgo();
  try {
    const promise = browserCdp("Target.getVersion", {}, undefined, 5000);
    globalThis.ego.sendCDPMessage = (payload) => {
      const parsed = JSON.parse(payload);
      globalThis.ego.onCDPMessage(
        JSON.stringify({ id: parsed.id, result: {} }),
      );
    };
    globalThis.ego.sendCDPMessage(
      JSON.stringify({ id: 1, method: "Target.getVersion" }),
    );
    await promise;

    fireEvent("Runtime.consoleAPICalled", {
      type: "log",
      args: [{ type: "string", value: "via facade" }],
    });

    const drained = drainConsole();
    assert.equal(drained.length, 1);
    assert.equal(drained[0].text, "via facade");

    const pending = waitForConsole("next", { timeout: 500 });
    fireEvent("Runtime.consoleAPICalled", {
      type: "log",
      args: [{ type: "string", value: "next message" }],
    });
    const matched = await pending;
    assert.equal(matched.text, "next message");
  } finally {
    cleanup();
  }
});
