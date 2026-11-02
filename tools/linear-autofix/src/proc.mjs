import { spawn } from "node:child_process";

export class ProcessError extends Error {
  constructor(message, result) {
    super(message);
    this.name = "ProcessError";
    Object.assign(this, result);
  }
}

/**
 * Run a child process to completion. Rejects on a non-zero exit or on timeout
 * (SIGTERM, then SIGKILL 10 s later). `input` is written to stdin.
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
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
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

export function tail(text, lines = 40) {
  return String(text ?? "")
    .trimEnd()
    .split("\n")
    .slice(-lines)
    .join("\n");
}
