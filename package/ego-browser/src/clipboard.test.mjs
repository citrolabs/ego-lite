import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import {
  __testing,
  ClipboardRestoreError,
  withTemporaryClipboardContent,
  withTemporaryClipboardText,
} from "../dist/src/clipboard.js";

test("temporary clipboard text is restored after the action", async () => {
  const events = [];
  const value = await withTemporaryClipboardText(
    "temporary",
    async () => {
      events.push("action");
      return 42;
    },
    {
      async beginTransaction(text) {
        events.push(["begin", text]);
        return {
          async finish() {
            events.push("finish");
            return "restored";
          },
        };
      },
    },
  );

  assert.equal(value, 42);
  assert.deepEqual(events, [["begin", "temporary"], "action", "finish"]);
});

test("temporary clipboard content keeps text and HTML representations together", async () => {
  const content = {
    text: "A\tB",
    html: "<table><tr><td>A</td><td>B</td></tr></table>",
  };
  let prepared;

  await withTemporaryClipboardContent(content, async () => {}, {
    async beginTransaction(value) {
      prepared = value;
      return {
        async finish() {
          return "restored";
        },
      };
    },
  });

  assert.deepEqual(prepared, content);
});

test("temporary clipboard text is restored when the action throws", async () => {
  let finished = false;
  const primary = new Error("paste input failed");

  await assert.rejects(
    () =>
      withTemporaryClipboardText(
        "temporary",
        async () => {
          throw primary;
        },
        {
          async beginTransaction() {
            return {
              async finish() {
                finished = true;
                return "restored";
              },
            };
          },
        },
      ),
    (error) => error === primary,
  );
  assert.equal(finished, true);
});

test("a restore failure reports that the paste action already completed", async () => {
  await assert.rejects(
    () =>
      withTemporaryClipboardText("temporary", async () => "done", {
        async beginTransaction() {
          return {
            async finish() {
              throw new Error("pasteboard unavailable");
            },
          };
        },
      }),
    (error) => {
      assert.ok(error instanceof ClipboardRestoreError);
      assert.equal(error.code, "EGO_CLIPBOARD_RESTORE_FAILED");
      assert.equal(error.pasteCompleted, true);
      assert.match(error.message, /paste completed.*do not retry/i);
      return true;
    },
  );
});

test("an external clipboard change is respected instead of restoring stale data", async () => {
  const value = await withTemporaryClipboardText("temporary", async () => 7, {
    async beginTransaction() {
      return {
        async finish() {
          return "changed";
        },
      };
    },
  });

  assert.equal(value, 7);
});

test("clipboard transactions are serialized within one runtime", async () => {
  const events = [];
  let releaseFirst;
  const firstHold = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => {
    markFirstStarted = resolve;
  });
  const beginTransaction = async (text) => {
    events.push(`begin:${text}`);
    return {
      async finish() {
        events.push(`finish:${text}`);
        return "restored";
      },
    };
  };

  const first = withTemporaryClipboardText(
    "first",
    async () => {
      events.push("action:first");
      markFirstStarted();
      await firstHold;
    },
    { beginTransaction },
  );
  await firstStarted;
  const second = withTemporaryClipboardText(
    "second",
    async () => {
      events.push("action:second");
    },
    { beginTransaction },
  );
  await Promise.resolve();
  assert.deepEqual(events, ["begin:first", "action:first"]);

  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, [
    "begin:first",
    "action:first",
    "finish:first",
    "begin:second",
    "action:second",
    "finish:second",
  ]);
});

test("paste explains the supported clipboard platforms", async () => {
  await assert.rejects(
    () => __testing.beginNativeClipboardTransaction("temporary", "linux"),
    /requires macOS or Windows clipboard support.*insertText/,
  );
});

test("Windows HTML clipboard offsets count UTF-8 bytes", () => {
  const fragment = "<b>世界 🙂</b>";
  const payload = __testing.windowsHtmlClipboardFormat(fragment);
  const header = payload.toString("utf8");
  const offset = (name) =>
    Number(header.match(new RegExp(`^${name}:(\\d{10})\\r$`, "m"))[1]);

  assert.match(header, /^Version:0\.9\r\n/);
  assert.equal(
    payload
      .subarray(offset("StartFragment"), offset("EndFragment"))
      .toString("utf8"),
    fragment,
  );
  assert.equal(
    payload.subarray(offset("StartHTML"), offset("EndHTML")).toString("utf8"),
    `<html><body>\r\n<!--StartFragment-->${fragment}<!--EndFragment-->\r\n</body></html>`,
  );
  assert.equal(offset("EndHTML"), payload.length);
});

function fakeWindowsClipboardHost(respond) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const spawned = {};
  const lines = [];
  let pending = "";
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk) => {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      lines.push(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      respond(lines, (message) =>
        child.stdout.write(`${JSON.stringify(message)}\n`),
      );
    }
  });
  child.stdin.on("finish", () => {
    child.stdout.end();
    setImmediate(() => child.emit("exit", spawned.exitCode ?? 0, null));
  });
  const spawnHost = (command, args, options) => {
    Object.assign(spawned, { command, args, options });
    return child;
  };
  return { spawnHost, spawned, lines };
}

test("Windows clipboard host receives text and HTML, then restores on signal", async () => {
  const host = fakeWindowsClipboardHost((lines, emit) => {
    if (lines.length === 2) emit({ state: "ready" });
    if (lines.length === 3) emit({ state: "restored" });
  });
  const transaction = await __testing.beginWin32ClipboardTransaction(
    { text: "A\t世界", html: "<td>A</td>" },
    host.spawnHost,
  );

  assert.match(
    host.spawned.command,
    /WindowsPowerShell\\v1\.0\\powershell\.exe$/i,
  );
  const args = host.spawned.args;
  assert.equal(args[args.indexOf("-InputFormat") + 1], "None");
  assert.ok(args.includes("-Sta"));
  assert.equal(
    Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString(
      "utf16le",
    ),
    __testing.WIN32_CLIPBOARD_HOST,
  );
  assert.equal(host.spawned.options.windowsHide, true);
  assert.equal(
    Buffer.from(host.lines[0], "base64").toString("utf8"),
    "A\t世界",
  );
  assert.deepEqual(
    Buffer.from(host.lines[1], "base64"),
    __testing.windowsHtmlClipboardFormat("<td>A</td>"),
  );

  assert.equal(await transaction.finish(), "restored");
  assert.equal(host.lines.length, 3);
});

test("Windows clipboard host sends an empty HTML line for plain text", async () => {
  const host = fakeWindowsClipboardHost((lines, emit) => {
    if (lines.length === 2) emit({ state: "ready" });
    if (lines.length === 3) emit({ state: "changed" });
  });
  const transaction = await __testing.beginWin32ClipboardTransaction(
    "plain",
    host.spawnHost,
  );

  assert.equal(host.lines[1], "");
  assert.equal(await transaction.finish(), "changed");
});

test("Windows clipboard host errors keep the host's message", async () => {
  const host = fakeWindowsClipboardHost((lines, emit) => {
    if (lines.length === 2) {
      emit({
        state: "error",
        message: "another ego-browser process is using the clipboard",
      });
    }
  });

  await assert.rejects(
    () => __testing.beginWin32ClipboardTransaction("plain", host.spawnHost),
    /another ego-browser process is using the clipboard/,
  );
});

test("Windows clipboard restore errors keep the host's message", async () => {
  const host = fakeWindowsClipboardHost((lines, emit) => {
    if (lines.length === 2) emit({ state: "ready" });
    if (lines.length === 3) {
      host.spawned.exitCode = 1;
      emit({ state: "error", message: "OpenClipboard failed" });
    }
  });
  const transaction = await __testing.beginWin32ClipboardTransaction(
    "plain",
    host.spawnHost,
  );

  await assert.rejects(() => transaction.finish(), /OpenClipboard failed/);
});
