import { spawn } from "node:child_process";

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...options.env },
      stdio: options.input ? ["pipe", "pipe", "pipe"] : "inherit",
    });
    const timer =
      options.timeoutMs &&
      setTimeout(() => {
        settled = true;
        child.kill("SIGINT");
        reject(
          new Error(
            `${command} ${args.join(" ")} timed out after ${options.timeoutMs}ms`,
          ),
        );
      }, options.timeoutMs);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error.code === "ENOENT" && options.egoBrowserSdkPath) {
        reject(
          new Error(
            `Ego Lite CLI not found at ${command}; install/open Ego Lite or set EGO_BROWSER_REAL_E2E_CLI`,
          ),
        );
        return;
      }
      reject(error);
    });
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (
        /unknown option.*sdk-path|unrecognized option.*sdk-path/i.test(
          stdout + stderr,
        )
      ) {
        const error = new Error(
          `ego-browser nodejs --sdk-path is not supported; cannot verify SDK path ${options.egoBrowserSdkPath || "configured SDK path"}`,
        );
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      if (code === 0) {
        if (
          /ego's nodejs process exited with code\s+[1-9]\d*/.test(
            stdout + stderr,
          )
        ) {
          const error = new Error(
            `ego-browser nodejs reported an inner failure while exiting 0`,
          );
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      } else {
        const error = new Error(
          `${command} ${args.join(" ")} exited with code ${code}`,
        );
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
    if (options.input) {
      child.stdin.end(options.input);
    }
  });
}
