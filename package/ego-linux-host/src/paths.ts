import { homedir } from "node:os";
import { join } from "node:path";

export const APP_NAME = "ego-lite";

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.EGO_DATA_DIR) return env.EGO_DATA_DIR;
  const xdg = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(xdg, APP_NAME);
}

export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.EGO_CONFIG_DIR) return env.EGO_CONFIG_DIR;
  const xdg = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, APP_NAME);
}

export function defaultProfileDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.EGO_USER_DATA_DIR) return env.EGO_USER_DATA_DIR;
  return join(defaultDataDir(env), "profile");
}

export function defaultSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.EGO_HOST_SOCK) return env.EGO_HOST_SOCK;
  return join(defaultDataDir(env), "host.sock");
}

export function defaultCdpPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.EGO_CDP_PORT;
  if (raw) return Number(raw);
  return 9222;
}
