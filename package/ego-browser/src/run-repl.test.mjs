import test from "node:test";
import assert from "node:assert/strict";

import { runMain } from "../dist/src/run.js";

function captureStream() {
  const chunks = [];
  return {
    write(chunk) {
      chunks.push(String(chunk));
    },
    text() {
      return chunks.join("");
    },
  };
}

function hardStopEgo(error_code) {
  return {
    calls: 0,
    async listTaskSpaces() {
      this.calls += 1;
      return {
        error: "native wording that should not leak",
        error_code,
      };
    },
  };
}

async function runRepl(input, ego) {
  const previousEgo = globalThis.ego;
  if (ego === undefined) {
    delete globalThis.ego;
  } else {
    globalThis.ego = ego;
  }
  const stdout = captureStream();
  const stderr = captureStream();
  try {
    const exitCode = await runMain({
      argv: ["--repl"],
      stdinText: input,
      stdout,
      stderr,
      services: { printUpdateBanner() {} },
    });
    return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
  } finally {
    if (previousEgo === undefined) {
      delete globalThis.ego;
    } else {
      globalThis.ego = previousEgo;
    }
  }
}

test("interactive cell mode preserves REPL state and prints expression results", async () => {
  const result = await runRepl(`
.cell
var count = 2
console.log('count=' + count)
count + 3
.end
.cell
count += 5
count
.end
.cell
const { value } = { value: 9 }
value
.end
.cell
value
.end
.exit
`);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /ego-browser nodejs REPL/);
  assert.match(result.stdout, /count=2\n5\nrepl> 7\nrepl> 9\nrepl> 9\nrepl> $/);
  assert.equal(result.stderr, "");
});

test("interactive cell mode supports cancel without running the discarded code", async () => {
  const result = await runRepl(`
.cell
console.log('discarded')
.cancel
.cell
console.log('after cancel')
.end
.exit
`);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /after cancel/);
  assert.doesNotMatch(result.stdout, /discarded/);
});

test("interactive cell mode reports syntax errors and keeps the REPL usable", async () => {
  const result = await runRepl(`
.cell
return 1
.end
.cell
console.log('after syntax')
.end
.exit
`);

  assert.equal(result.exitCode, 0);
  assert.match(result.stderr, /Uncaught SyntaxError: Illegal return statement/);
  assert.match(result.stdout, /after syntax/);
});

test("interactive cell mode returns usage error for EOF before .end", async () => {
  const result = await runRepl(`
.cell
console.log('unfinished')
`);

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /Expected \.end before EOF/);
  assert.doesNotMatch(result.stdout, /unfinished/);
});

test("interactive hard stop prints user-control guidance once and resets for the next cell", async () => {
  const ego = hardStopEgo("EGO_TASK_SPACE_USER_IN_CONTROL");
  const result = await runRepl(
    `
.cell
console.log('before hard stop')
try {
  await listTaskSpaces()
} catch (error) {
  console.log('caught: ' + error.message)
}
'suppressed expression'
.end
.cell
console.log('after hard stop')
.end
.exit
`,
    ego,
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /taken control of this task space/);
  assert.match(result.stdout, /takeOverTaskSpace\(\)/);
  assert.equal(result.stdout.match(/takeOverTaskSpace\(\)/g).length, 1);
  assert.doesNotMatch(result.stdout, /before hard stop|caught:|suppressed/);
  assert.match(result.stdout, /after hard stop/);
  assert.equal(result.stderr, "");
  assert.equal(ego.calls, 1);
});

test("interactive inactive task guidance uses claimTaskSpace and resets for the next cell", async () => {
  const ego = hardStopEgo("EGO_TASK_SPACE_INACTIVE");
  const result = await runRepl(
    `
.cell
try {
  await listTaskSpaces()
} catch {}
.end
.cell
console.log('after inactive')
.end
.exit
`,
    ego,
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /no longer assigned to the agent/);
  assert.match(result.stdout, /claimTaskSpace\(id\)/);
  assert.match(result.stdout, /after inactive/);
  assert.equal(result.stderr, "");
});
