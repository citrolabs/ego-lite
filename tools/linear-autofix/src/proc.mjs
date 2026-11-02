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
 * `input` is written to stdin.
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
  { cwd, input, timeoutMs = 120_000, env, allowFailure = false } = {},
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
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
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
            `${cmd} ${args.join(" ").slice(0, 200)} exited ${code}${signal ? ` (${signal})` : ""}\n${tail(stderr || stdout)}`,
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

export function tail(text, lines = 40) {
  return String(text ?? "")
    .trimEnd()
    .split("\n")
    .slice(-lines)
    .join("\n");
}
