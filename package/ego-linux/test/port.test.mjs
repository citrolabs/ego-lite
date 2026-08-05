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

// The suite drives a browser of its own, in its own profile and state dir.
// Sharing the default ones would make `npm test` hijack — and on teardown kill —
// whatever browser the user's agent sessions are currently driving.
const SANDBOX = await mkdtemp(join(tmpdir(), "ego-linux-test-"));
const TEST_ENV = {
  XDG_STATE_HOME: join(SANDBOX, "state"),
  EGO_LINUX_PROFILE: join(SANDBOX, "profile"),
};
const TEST_BROWSER_STATE = join(SANDBOX, "state", "ego-lite-linux", "browser.json");

/** Run a script through the real CLI, exactly as an agent would. */
function runScript(scriptPath, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, "--headless"], {
      env: { ...process.env, ...TEST_ENV, FIXTURE_URL },
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
      if (code !== 0) {
        reject(new Error(`exit ${code}\n${stdout}\n${stderr}`));
        return;
      }
      resolve(stdout);
    });

    readFile(scriptPath, "utf8").then(
      (code) => child.stdin.end(code),
      (error) => reject(error),
    );
  });
}

after(async () => {
  try {
    const state = JSON.parse(await readFile(TEST_BROWSER_STATE, "utf8"));
    if (state.pid) process.kill(state.pid, "SIGTERM");
  } catch {
    // nothing running
  }
  // Chrome keeps writing to its profile while shutting down, so a removal
  // racing that hits ENOTEMPTY. Cleanup is best-effort — a leftover temp dir is
  // not a test failure.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await rm(SANDBOX, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(
    () => {},
  );
});

describe("ego-browser Linux port", () => {
  it("observes a page: navigation, tabs, refs and nested iframes", async () => {
    const out = await runScript(join(HERE, "smoke.js"));

    assert.match(out, /TITLE:\s+ego linux port fixture/, "page title read back");
    assert.match(out, /TABS:\s+\d+ \(active: 1\)/, "exactly one tab reports active");

    // Snapshot content: the semantic tree the agent reads.
    assert.match(out, /Helper e2e fixture/, "page text is in the snapshot");
    assert.match(out, /button "Increment counter" \[ref=\d+/, "button carries a ref");
    assert.match(out, /link "Go to nav target".*url=\/nav-target/, "link exposes its href");
    assert.match(out, /textbox "Your name".*loc=css:#name-input/, "input gets a stable locator");

    // Iframe piercing, two levels deep — the case the native snapshot is built for.
    assert.match(out, /iframe "nested frame"/, "first-level iframe is entered");
    assert.match(out, /iframe "deep frame"/, "second-level iframe is entered");
    assert.match(out, /button "Deep button" \[ref=\d+/, "element inside the deep iframe gets a ref");

    // Layout-driven visibility, not a DOM dump.
    assert.doesNotMatch(out, /hidden text must not appear/, "display:none content is excluded");
  });

  it("acts on a page: refs, locators, pointer input and screenshots", async () => {
    const out = await runScript(join(HERE, "interact.js"));

    assert.match(out, /2\. @ref center:\s+\{"x":\d/, "@ref resolves to coordinates");
    assert.match(out, /3\. after mouse click:\s+clicked/, "a synthesised click reaches the element");
    assert.match(out, /5\. after locator click:\s+clicked/, "locator click reaches the element");
    assert.match(out, /6\. locator fill:\s+Vikt/, "locator fill writes into the input");
    assert.match(out, /7\. deep iframe ref:\s+\{"x":\d/, "a ref inside the deep iframe resolves");
    assert.match(out, /8\. getByRole count:\s+1/, "getByRole matches the computed accessible name");
    assert.match(out, /9\. screenshot:\s+\/.*\.png/, "screenshot round trips to a file");
  });

  it("emulates task spaces with their own windows, ownership and lifecycle", async () => {
    const out = await runScript(join(HERE, "spaces.js"));

    assert.match(out, /1\. created:\s+\{"id":\d+.*"ownership":"agent"/, "a space is created agent-owned");
    assert.match(out, /2\. alpha page:\s+ego linux port fixture/, "the agent works inside the space");
    assert.match(out, /3\. second space: \{"id":\d+/, "a second, independent space is created");
    assert.match(out, /4\. beta page:\s+about:blank#beta/, "the second space navigates on its own");
    assert.match(out, /5\. back in alpha:ego linux port fixture/, "switching returns the agent to that space's page");
    assert.match(out, /7\. after handOff:\["agentDelegatedToUser"/, "handOff flips ownership");
    assert.match(out, /8\. after cleanup:\[\]/, "completing a space closes its window");
  });
});
