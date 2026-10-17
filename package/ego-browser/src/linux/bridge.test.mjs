import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { LinuxBridge } from "../../dist/src/linux/bridge.js";

function fixture(timeout = 200) {
  const input = new PassThrough();
  const output = new PassThrough();
  return { input, output, bridge: new LinuxBridge(input, output, timeout) };
}
test("pipe CDP preserves browser/session messages and fragmented responses", async () => {
  const { bridge, input, output } = fixture();
  const frames = [];
  input.on("data", (data) =>
    frames.push(JSON.parse(data.toString().replace(/\0$/, ""))),
  );
  const result = bridge.call(
    "Runtime.evaluate",
    { expression: "2+2" },
    "owned-session",
  );
  assert.equal(frames[0].sessionId, "owned-session");
  output.write('{"id":1,"result":');
  output.write('{"value":4}}\0');
  assert.deepEqual(await result, { value: 4 });
  const event = new Promise((resolve) => (bridge.onEvent = resolve));
  output.write(
    '{"method":"Target.attachedToTarget","sessionId":"parent","params":{"sessionId":"child"}}\0',
  );
  assert.equal((await event).params.sessionId, "child");
  bridge.close();
});
test("a connected pipe that never responds reaches the actual timeout", async () => {
  const { bridge } = fixture(30);
  const start = Date.now();
  await assert.rejects(bridge.call("Browser.getVersion"), /timed out/);
  assert.ok(Date.now() - start >= 25);
  bridge.close();
});
test("pipe closure rejects pending commands promptly", async () => {
  const { bridge, output } = fixture(5000);
  const pending = bridge.call("Browser.getVersion");
  output.end();
  await assert.rejects(pending, /closed/);
});
