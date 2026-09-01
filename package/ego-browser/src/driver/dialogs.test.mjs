import test from "node:test";
import assert from "node:assert/strict";

import {
  clearPreferredTarget,
  drainBrowserEvents,
  invalidateSession,
} from "../../dist/src/browser-runtime.js";
import { state } from "../../dist/src/state.js";
import {
  acceptDialog,
  dialog,
  dismissDialog,
  waitForDialog,
} from "../../dist/src/driver/dialogs.js";
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

function fireEvent(method, params = {}, sessionId = "sess-1") {
  globalThis.ego.onCDPMessage(JSON.stringify({ method, params, sessionId }));
}

function cleanup() {
  delete globalThis.ego;
  invalidateSession();
  clearPreferredTarget();
  drainBrowserEvents();
}

test("dialog() returns null when no dialog is pending", async () => {
  installAutoEgo();
  try {
    assert.equal(await dialog(), null);
  } finally {
    cleanup();
  }
});

test("dialog() returns pending dialog info", async () => {
  installAutoEgo();
  try {
    assert.equal(await dialog(), null);
    fireEvent(
      "Page.javascriptDialogOpening",
      {
        type: "alert",
        message: "Hello",
        url: "https://example.com/",
      },
      state.sessionId,
    );
    assert.deepEqual(await dialog(), {
      type: "alert",
      message: "Hello",
      url: "https://example.com/",
    });
  } finally {
    cleanup();
  }
});

test("acceptDialog sends Page.handleJavaScriptDialog with accept true", async () => {
  const calls = installAutoEgo();
  try {
    await acceptDialog();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const handleCall = calls.find(
      (call) => call.method === "Page.handleJavaScriptDialog",
    );
    assert.ok(handleCall, "sends handleJavaScriptDialog");
    assert.deepEqual(handleCall.params, { accept: true });
  } finally {
    cleanup();
  }
});

test("acceptDialog sends promptText for prompt dialogs", async () => {
  const calls = installAutoEgo();
  try {
    await acceptDialog("typed value");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const handleCall = calls.find(
      (call) => call.method === "Page.handleJavaScriptDialog",
    );
    assert.deepEqual(handleCall.params, {
      accept: true,
      promptText: "typed value",
    });
  } finally {
    cleanup();
  }
});

test("dismissDialog sends Page.handleJavaScriptDialog with accept false", async () => {
  const calls = installAutoEgo();
  try {
    await dismissDialog();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const handleCall = calls.find(
      (call) => call.method === "Page.handleJavaScriptDialog",
    );
    assert.deepEqual(handleCall.params, { accept: false });
  } finally {
    cleanup();
  }
});

test("waitForDialog resolves when a dialog opens", async () => {
  installAutoEgo();
  try {
    const promise = waitForDialog({ timeout: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    fireEvent("Page.javascriptDialogOpening", {
      type: "confirm",
      message: "Continue?",
      url: "https://example.com/confirm",
    });
    assert.deepEqual(await promise, {
      type: "confirm",
      message: "Continue?",
      url: "https://example.com/confirm",
    });
  } finally {
    cleanup();
  }
});

test("waitForDialog returns immediately when a dialog is already pending", async () => {
  installAutoEgo();
  try {
    assert.equal(await dialog(), null);
    fireEvent(
      "Page.javascriptDialogOpening",
      {
        type: "prompt",
        message: "Name?",
        url: "https://example.com/prompt",
        defaultPrompt: "guest",
      },
      state.sessionId,
    );
    assert.deepEqual(await waitForDialog({ timeout: 1000 }), {
      type: "prompt",
      message: "Name?",
      url: "https://example.com/prompt",
      defaultPrompt: "guest",
    });
  } finally {
    cleanup();
  }
});

test("waitForEvent('dialog') delegates to waitForDialog", async () => {
  installAutoEgo();
  try {
    const promise = waitForEvent("dialog", { timeout: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    fireEvent("Page.javascriptDialogOpening", {
      type: "alert",
      message: "Delegated",
      url: "https://example.com/",
    });
    assert.deepEqual(await promise, {
      type: "alert",
      message: "Delegated",
      url: "https://example.com/",
    });
  } finally {
    cleanup();
  }
});

test("waitForEvent rejects unsupported event names", async () => {
  await assert.rejects(
    waitForEvent("popup", { timeout: 1000 }),
    /supports only "download" and "dialog"/,
  );
});
