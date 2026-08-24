import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin", "ego-browser.mjs");
const FIXTURE_URL = `file://${join(HERE, "fixture", "index.html")}`;

// Its own profile and state dir, for the reason port.test.mjs has one: `npm test`
// must not hijack — and on teardown kill — the browser a real session is driving.
const SANDBOX = await mkdtemp(join(tmpdir(), "ego-spaces-test-"));
process.env.XDG_STATE_HOME = join(SANDBOX, "state");
process.env.EGO_LINUX_PROFILE = join(SANDBOX, "profile");

// Imported after that assignment on purpose: paths.mjs resolves its directories
// at module load, so a static import would bind the real ones first.
const { createEgoShim } = await import("../src/shim.mjs");
const { startSpacesServer } = await import("../src/spaces-server.mjs");

const shim = await createEgoShim({ headless: true });
const server = await startSpacesServer(shim);
const BASE = `http://127.0.0.1:${server.port}`;

/** The panel's own window is 1280 wide; an active card is cropped to 16/10. */
const FOLLOW_CROP = { width: 760, height: 475 };

async function api(path, options) {
  const response = await fetch(BASE + path, options);
  return { status: response.status, body: await response.json() };
}

/** Run a heredoc through the real CLI, against the browser this suite started. */
function runScript(source, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN], {
      env: { ...process.env, FIXTURE_URL },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out after ${timeout}ms\n${stdout}\n${stderr}`));
    }, timeout);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`exit ${code}\n${stdout}\n${stderr}`));
      else resolve(stdout);
    });
    child.stdin.end(source);
  });
}

/**
 * Width and height from a JPEG's start-of-frame marker. Enough to tell an
 * active space's crop from a whole-page thumbnail without a decoder.
 */
function jpegSize(dataUri) {
  const buffer = Buffer.from(String(dataUri).split(",")[1], "base64");
  for (let i = 2; i < buffer.length - 9; ) {
    if (buffer[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buffer[i + 1];
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      return { width: buffer.readUInt16BE(i + 7), height: buffer.readUInt16BE(i + 5) };
    }
    i += 2 + buffer.readUInt16BE(i + 2);
  }
  return null;
}

after(async () => {
  server.close();
  shim.close();
  try {
    const state = JSON.parse(
      await readFile(join(SANDBOX, "state", "ego-lite-linux", "browser.json"), "utf8"),
    );
    if (state.pid) process.kill(state.pid, "SIGTERM");
  } catch {
    // nothing running
  }
  // Chrome keeps writing to its profile while shutting down, so a removal racing
  // that hits ENOTEMPTY. A leftover temp dir is not a test failure.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await rm(SANDBOX, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(
    () => {},
  );
});

describe("Spaces overview server", () => {
  it("answers a health probe, which is how the CLI finds a live daemon", async () => {
    const { status, body } = await api("/api/health");
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true });
  });

  it("creates a space and describes it with a thumbnail", async () => {
    const created = await api("/api/spaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "idle space" }),
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.space.name, "idle space");

    const { body } = await api("/api/spaces");
    const space = body.spaces.find((candidate) => candidate.name === "idle space");
    assert.ok(space, "the new space is listed");
    assert.equal(space.ownership, "agent");
    assert.equal(space.tabCount, 1);
    assert.match(space.thumbnail, /^data:image\/jpeg;base64,/, "a card gets a picture");

    // Nothing has acted in it, so there is nothing to report and no reason to zoom.
    assert.equal(space.activity, null);
    assert.ok(
      jpegSize(space.thumbnail).width > FOLLOW_CROP.width,
      "an idle card shows the whole page, not a crop",
    );
  });

  it("reports what an agent is doing, and where on the card it is working", async () => {
    await runScript(`
      await taskSpaces.useOrCreate("busy space");
      await page.goto(process.env.FIXTURE_URL);
      await page.waitForLoadState();
      const point = await page.elementCenter("loc=css:#click-button");
      await page.mouse.click(point.x, point.y, { label: "counting clicks" });
    `);

    const { body } = await api("/api/spaces");
    const space = body.spaces.find((candidate) => candidate.name === "busy space");
    assert.ok(space, "the space the agent worked in is listed");

    // The panel and the agent are separate processes with separate CDP
    // connections; this only works because the overlay leaves its state in the
    // page, where the server reads it back.
    assert.equal(space.activity?.name, "Claude");
    assert.equal(space.activity?.label, "counting clicks");
    assert.ok(space.activity.ageMs >= 0 && space.activity.ageMs < 30000);

    // Frames now arrive by screencast, which delivers the whole viewport and
    // cannot crop. The card zooms to the cursor itself, so what the server has
    // to supply is where the cursor is — as a fraction of the viewport, which
    // survives whatever size the frame happens to be.
    const { fx, fy } = space.activity;
    assert.ok(
      typeof fx === "number" && fx >= 0 && fx <= 1,
      "the cursor's horizontal position travels with the card",
    );
    assert.ok(
      typeof fy === "number" && fy >= 0 && fy <= 1,
      "the cursor's vertical position travels with the card",
    );

    const size = jpegSize(space.thumbnail);
    assert.ok(size && size.width > 0 && size.height > 0, "a frame is served");

    // The trail travels the same way and outlives the activity window, so a
    // space that has gone quiet still says what it did.
    assert.ok(space.trail?.length, "the card carries a trail of what happened");
    assert.match(space.trail[0].text, /^clicked /, "newest first");
    assert.ok(space.trail[0].ageMs >= 0, "aged, not timestamped");
  });

  it("refuses a cross-origin caller", async () => {
    // Loopback is not a boundary here: any page in the agent's own browser can
    // reach this server, and it can create and close spaces.
    const { status } = await api("/api/spaces", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ name: "not yours" }),
    });
    assert.equal(status, 403);
  });

  it("closes a space and forgets it", async () => {
    // Creates its own rather than reusing another case's, so this still means
    // something when run alone through --test-name-pattern.
    const { body: created } = await api("/api/spaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "closeable space" }),
    });
    const target = created.space;

    const closed = await api(`/api/spaces/${target.id}/close`, { method: "POST" });
    assert.equal(closed.status, 200);

    const { body: after } = await api("/api/spaces");
    assert.ok(
      !after.spaces.some((candidate) => candidate.id === target.id),
      "the closed space is gone from the overview",
    );
  });

  it("404s an unknown route", async () => {
    const { status } = await api("/api/nope");
    assert.equal(status, 404);
  });
});
