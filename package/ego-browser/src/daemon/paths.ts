// Where ego-run keeps its state, and how the thin CLI finds the daemon.
//
// macOS   ~/.local/share/ego/daemon/      Unix domain socket
// Linux   $XDG_STATE_HOME/ego/daemon/     Unix domain socket
// Windows %LOCALAPPDATA%\ego\daemon\      named pipe \\.\pipe\ego-run-<user>
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

export type DaemonPaths = {
  stateDir: string;
  /** Unix socket path, or a named pipe on Windows. */
  endpoint: string;
  tokenFile: string;
  lockFile: string;
  logFile: string;
  /** Results larger than the inline limit are written here. */
  spillDir: string;
};

export function daemonPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): DaemonPaths {
  const stateDir = env.EGO_RUN_STATE_DIR || defaultStateDir(env, platform);
  return {
    stateDir,
    endpoint:
      platform === "win32"
        ? `\\\\.\\pipe\\ego-run-${safeUser(env)}`
        : join(stateDir, "daemon.sock"),
    tokenFile: join(stateDir, "token"),
    lockFile: join(stateDir, "daemon.lock"),
    logFile: join(stateDir, "daemon.log"),
    spillDir: join(stateDir, "results"),
  };
}

function defaultStateDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  const home = env.HOME || env.USERPROFILE || homedir();
  if (platform === "win32") {
    return join(
      env.LOCALAPPDATA || join(home, "AppData", "Local"),
      "ego",
      "daemon",
    );
  }
  if (platform === "darwin") {
    return join(home, ".local", "share", "ego", "daemon");
  }
  return join(
    env.XDG_STATE_HOME || join(home, ".local", "state"),
    "ego",
    "daemon",
  );
}

function safeUser(env: NodeJS.ProcessEnv) {
  let name = env.USERNAME || env.USER || "";
  if (!name) {
    try {
      name = userInfo().username;
    } catch {
      name = "user";
    }
  }
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}
