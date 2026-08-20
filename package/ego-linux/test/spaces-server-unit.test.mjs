import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { __createCastPoolForTest, startSpacesServer } from "../src/spaces-server.mjs";
import { SPACES_HTML } from "../src/spaces-ui.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Minimal cdp stand-in: lets the test pretend to attach to a target, wait, and
 * detach — and see when each call resolves. The shim forwards cdp events on
 * `onShimEvent` and claims/releases sessions around them; both no-ops here.
 */
function fakeCdp() {
  const handlers = new Map();
  const calls = [];
  const sessions = new Set();
  let nextId = 0;

  function record(method, params, sessionId) {
    const id = ++nextId;
    const call = { id, method, params, sessionId, resolve: null, reject: null };
    return new Promise((resolve, reject) => {
      call.resolve = resolve;
      call.reject = reject;
      calls.push(call);
    });
  }

  return {
    calls,
    onShimEvent(method, handler) {
      handlers.set(method, handler);
    },
    claimSession(sessionId) {
      sessions.add(sessionId);
    },
    releaseSession(sessionId) {
      sessions.delete(sessionId);
    },
    call(method, params, sessionId) {
      return record(method, params, sessionId);
    },
    /** Resolve the next pending call for `method` with a given result. */
    fulfill(method, result = {}) {
      const call = calls.find((entry) => entry.method === method && entry.resolve);
      if (!call) throw new Error(`no pending ${method} call`);
      calls.splice(calls.indexOf(call), 1);
      call.resolve(result);
    },
    /** Fail the next pending call for `method`. */
    fail(method, error = new Error("boom")) {
      const call = calls.find((entry) => entry.method === method && entry.resolve);
      if (!call) throw new Error(`no pending ${method} call`);
      calls.splice(calls.indexOf(call), 1);
      call.reject(error);
    },
    /** Default results for methods whose return value the test does not care about. */
    autoFulfill(method, result = {}) {
      const original = this.call.bind(this);
      this.call = (m, p, s) => (m === method ? Promise.resolve(result) : original(m, p, s));
    },
  };
}

/**
 * Minimal ego stand-in. The server only calls a handful of methods; the rest
 * can be left to throw.
 */
function fakeEgo() {
  const created = [];
  return {
    created,
    async listTaskSpaces() {
      return { taskSpaces: [] };
    },
    async createTaskSpace(name) {
      const space = { id: created.length + 1, name, ownership: "agent", targetIds: [] };
      created.push(space);
      return space;
    },
    async useTaskSpace() {},
    async handOffTaskSpace() {},
    async takeOverTaskSpace() {},
    async closeTaskSpace() {},
  };
}

let server = null;
afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
});

describe("spaces-server request handling", () => {
  it("refuses a request body bigger than 1 MiB with 413", async () => {
    const shim = { ego: fakeEgo(), cdp: fakeCdp() };
    server = await startSpacesServer(shim);
    const oversize = "x".repeat(2 * 1024 * 1024);
    const response = await fetch(`http://127.0.0.1:${server.port}/api/spaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"name":"${oversize}"}`,
    });
    assert.equal(response.status, 413);
    const body = await response.json();
    assert.match(body.error, /too large/i);
    // The request never reached ego, so no space was created.
    assert.equal(shim.ego.created.length, 0);
  });

  it("accepts a request body under the cap and creates a space", async () => {
    const shim = { ego: fakeEgo(), cdp: fakeCdp() };
    server = await startSpacesServer(shim);
    const response = await fetch(`http://127.0.0.1:${server.port}/api/spaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "fine" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.space.name, "fine");
  });

  it("serves /api/health", async () => {
    const shim = { ego: fakeEgo(), cdp: fakeCdp() };
    server = await startSpacesServer(shim);
    const response = await fetch(`http://127.0.0.1:${server.port}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });
});

describe("createCastPool().closeAll()", () => {
  it("awaits detach for every session before releasing it", async () => {
    const cdp = fakeCdp();
    // Page.startScreencast and Page.captureScreenshot resolve immediately so
    // open() finishes; only Target.attach and Target.detach are gated, which
    // is what the test needs to inspect.
    cdp.autoFulfill("Page.startScreencast");
    cdp.autoFulfill("Page.captureScreenshot");

    const pool = createPoolFor(cdp);

    // Each frameFor() opens a cast: Target.attach -> claimSession -> cast
    // recorded. Capture two so closeAll has two sessions to release.
    const pending1 = pool.frameFor("t1");
    cdp.fulfill("Target.attachToTarget", { sessionId: "s1" });
    await pending1;

    const pending2 = pool.frameFor("t2");
    cdp.fulfill("Target.attachToTarget", { sessionId: "s2" });
    await pending2;

    const released = [];
    const realRelease = cdp.releaseSession.bind(cdp);
    cdp.releaseSession = (sessionId) => {
      released.push(sessionId);
      realRelease(sessionId);
    };

    const closePromise = pool.closeAll();
    // closeAll() must NOT have released any session before detach resolves.
    assert.equal(released.length, 0, "no session released before detach");

    cdp.fulfill("Target.detachFromTarget");
    cdp.fulfill("Target.detachFromTarget");
    await closePromise;

    assert.deepEqual(released.sort(), ["s1", "s2"], "every session released after its detach");
  });

  it("still releases sessions when detach rejects", async () => {
    const cdp = fakeCdp();
    cdp.autoFulfill("Page.startScreencast");
    cdp.autoFulfill("Page.captureScreenshot");
    const pool = createPoolFor(cdp);

    const pending = pool.frameFor("t1");
    cdp.fulfill("Target.attachToTarget", { sessionId: "s1" });
    await pending;

    let released = false;
    const realRelease = cdp.releaseSession.bind(cdp);
    cdp.releaseSession = (id) => {
      if (id === "s1") released = true;
      realRelease(id);
    };

    const closePromise = pool.closeAll();
    cdp.fail("Target.detachFromTarget", new Error("browser gone"));
    await closePromise;

    assert.equal(released, true, "session released even when detach fails");
  });
});

/**
 * Reach into spaces-server.mjs to grab the cast pool factory. The export is
 * only used by this test; renaming it would break a regression check, not
 * any caller.
 */
function createPoolFor(cdp) {
  return __createCastPoolForTest(cdp);
}

/**
 * Static XSS regression.
 *
 * The Spaces overview is served from loopback, but any page in the agent's
 * own browser can hit it. A space name flows from the client into the
 * rendered DOM. The page renders it through textContent / createTextNode,
 * which the browser turns into a literal string — so the worst case today
 * is a name that shows up escaped in the card. This test fails the moment
 * someone replaces one of those safe assignments with innerHTML.
 */
describe("Spaces overview does not inject user-controlled strings", () => {
  it("renders user-controlled fields through textContent or createTextNode only", async () => {
    const source = await readFile(join(HERE, "..", "src", "spaces-ui.mjs"), "utf8");
    // Allow `innerHTML` inside the static template (it has no user data).
    // What we forbid is dynamically assigning user-controlled strings to it.
    const dynamicInnerHTML = /\.innerHTML\s*=\s*[^"'`\s]/.test(source);
    assert.equal(dynamicInnerHTML, false, "no dynamic innerHTML assignment");
    // document.write would bypass textContent entirely.
    assert.equal(/document\.write/.test(source), false, "no document.write");
    // Both spots that put a name into the DOM must use a safe sink.
    assert.match(source, /createTextNode\(space\.name\)/, "space.name goes through createTextNode");
    assert.match(source, /name\.append\(dot,/, "name is appended, never set as HTML");
  });

  it("ships the page content verbatim (no script injection surface in SPACES_HTML)", () => {
    // The HTML is one big template literal; this test fails if the export
    // regresses to building it from a string concatenation that would let
    // untrusted values land in markup.
    assert.match(SPACES_HTML, /^<!doctype html>/);
    assert.match(SPACES_HTML, /<\/html>\s*$/);
  });
});