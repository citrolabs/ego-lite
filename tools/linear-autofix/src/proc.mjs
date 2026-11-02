import { spawn } from "node:child_process";

export class ProcessError extends Error {
  constructor(message, result) {
    super(message);
    this.name = "ProcessError";
    Object.assign(this, result);
  }
}

/**
 * Run a child process to completion. Rejects on a non-zero exit or on timeout.
 * `input` is written to stdin. `onLine` sees each complete output line as it
 * arrives, from either stream, for long runs that should show progress.
 *
 * The child is started in its own process group (`detached`), so a timeout
 * terminates the whole tree: Claude's npm, node and shell descendants go with
 * it (SIGTERM, then SIGKILL 10 s later). The promise settles only when every
 * holder of the stdio pipes has exited, so a worktree is quiet by the time a
 * timeout is reported.
 */
export function run(
  cmd,
  args,
  { cwd, input, timeoutMs = 120_000, env, allowFailure = false, onLine } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const lines = onLine ? lineSplitter(onLine) : () => {};
    const linesErr = onLine ? lineSplitter(onLine) : () => {};
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      stdout += d;
      lines(d);
    });
    child.stderr.on("data", (d) => {
      stderr += d;
      linesErr(d);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, "SIGTERM");
      setTimeout(() => killTree(child, "SIGKILL"), 10_000).unref();
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new ProcessError(`${cmd} failed to start: ${err.message}`, {
          stdout,
          stderr,
          code: null,
        }),
      );
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const result = { stdout, stderr, code, signal, timedOut };
      if (timedOut) {
        reject(
          new ProcessError(
            `${cmd} ${args[0] ?? ""} timed out after ${timeoutMs} ms`,
            result,
          ),
        );
      } else if (code !== 0 && !allowFailure) {
        reject(
          new ProcessError(
            `${cmd} ${args.join(" ").slice(0, 200)} exited ${code}${signal ? ` (${signal})` : ""}\n${bothTails(stdout, stderr)}`,
            result,
          ),
        );
      } else {
        resolve(result);
      }
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Turn chunks into complete lines. A progress callback never breaks the run. */
export function lineSplitter(onLine) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop();
    for (const line of parts) {
      try {
        onLine(line);
      } catch (err) {
        console.error(`progress callback failed: ${err.message}`);
      }
    }
  };
}

/** Signal the child's whole process group; fall back to the child alone. */
export function killTree(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (err) {
    if (err.code !== "ESRCH") {
      try {
        child.kill(signal);
      } catch {}
    }
  }
}

/** Both streams, each trimmed to its last lines. Hook output (lefthook, E2E) arrives on stdout while git reports on stderr. */
export function bothTails(stdout, stderr, lines = 40) {
  return [tail(stdout, lines), tail(stderr, lines)].filter(Boolean).join("\n");
}

export function tail(text, lines = 40) {
  return String(text ?? "")
    .trimEnd()
    .split("\n")
    .slice(-lines)
    .join("\n");
}
