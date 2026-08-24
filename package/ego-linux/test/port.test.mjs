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

  it("draws the agent's cursor without disturbing the page it acts on", async () => {
    const out = await runScript(join(HERE, "cursor.js"));

    assert.match(out, /1\. overlay present:\s+true/, "the overlay is injected on a click");
    assert.match(out, /2\. cursor tracks click:\s+true/, "the cursor sits where the click landed");
    assert.match(out, /3\. badge text:\s+Claude · counting/, "the task state label is shown");

    // The overlay must stay invisible to everything the harness relies on.
    assert.match(out, /4\. hit test at cursor:\s+click-button/, "elementFromPoint still sees the page");
    assert.match(out, /5\. click still landed:\s+clicked/, "the click reached the element");
    assert.match(out, /6\. overlay in snapshot:\s+false/, "the overlay is absent from the agent's snapshot");
    assert.match(out, /7\. cursor held on wheel:\s+true/, "a scroll does not drag the cursor to (0, 0)");

    // The pressed look tracks the button, not a fixed animation: it holds for as
    // long as the button is down, and lets go when it comes up.
    assert.match(out, /8\. pressed on down:\s+true/, "the cursor holds pressed while the button is down");
    assert.match(out, /9\. released on up:\s+true/, "and springs back once it is released");

    // It marks an element, so it is anchored to the page rather than the screen.
    assert.match(out, /10\. travels with page:\s+true/, "the cursor scrolls with the element it is on");

    // Shape and label both come from whatever sits under the cursor.
    assert.match(out, /11\. hand over a link:\s+hand/, "a link gets the hand, as the page itself asks");
    assert.match(out, /12\. names what it is on:\s+Claude · Go to nav target/, "the badge names it unprompted");
    assert.match(out, /13\. beam over a field:\s+beam/, "a text field gets the beam");

    // fill() dispatches no pointer event at all, so this is the action that
    // would otherwise happen with nothing on screen to explain it.
    assert.match(out, /14\. says it is typing:\s+Claude · typing…/, "typing is announced");
    assert.match(out, /15\. marks the field:\s+on/, "and the field being typed into is ringed");
    assert.match(out, /16\. lets go when done:\s+true/, "the ring clears once the keystrokes stop");

    // The highlighter — a marker drawn to explain something, not a selection.
    assert.match(out, /17\. highlight lines:\s+1/, "a phrase is found by its text and measured per line");
    assert.match(out, /18\. bands drawn:\s+1/, "and gets a band");
    assert.match(out, /19\. note in badge:\s+Claude · explaining this/, "the note says why");
    assert.match(out, /20\. band matches text:\s+[0-2],[0-2]/, "the band sits on the text, within 2px");
    assert.match(out, /21\. miss draws nothing:\s+true/, "text that is not there draws nothing");
    assert.match(out, /22\. cleared:\s+true/, "and it can be wiped off again");

    // Reading dispatches no input at all, so without the sweep a snapshotting
    // agent drew nothing and the window looked idle while it worked.
    assert.match(out, /23\. says what it reads:\s+Claude · reading “.+”/, "the badge names the line being read");
    assert.match(out, /24\. marks the lines:\s+true/, "and the lines it has passed are marked");
    assert.match(out, /25\. input ends the read:\s+true/, "real input takes the cursor back from the sweep");

    // The trail the Spaces panel reads back. One entry per transition: the
    // fill() above sent dozens of key events and must appear once.
    assert.match(out, /26\. trail:.*clicked Increment counter/, "a click is recorded by what it hit");
    assert.match(out, /26\. trail:.*typed into Your name/, "named by the field's own label, not its placeholder");
    assert.match(out, /26\. trail:.*highlighted explaining this/, "so is a highlight, by its note");
    assert.match(out, /26\. trail:.*read Helper e2e fixture/, "and a read, by what it started on");

    // Anchored to its element, the cursor rides a long scroll off the screen —
    // which used to leave the window blank while the agent was still working.
    assert.match(out, /27\. cursor leaves view:\s+true/, "a long scroll carries the cursor off screen");
    assert.match(out, /28\. badge stays in it:\s+true/, "but the badge stays legible");
    assert.match(out, /29\. and points back:\s+↑/, "pointing back the way the cursor went");
    // Measuring in the right place is not proof of being drawn there: a badge
    // parented to the off-screen pointer passes check 28 and paints nothing.
    assert.match(out, /30\. drawn independently:\s+true/, "and does not depend on the off-screen pointer layer");
    assert.match(out, /31\. motion scales:\s+true/, "a nudge and a jump do not take the same time");
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
