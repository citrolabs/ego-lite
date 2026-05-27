import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SRC_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SRC_DIR, "..");

export function agentWorkspace() {
  return resolvePath(process.env.EGO_BROWSER_AGENT_WORKSPACE || resolve(REPO_ROOT, "..", "..", "skills", "ego-browser"));
}

export function resolvePath(path) {
  if (path.startsWith("~")) {
    return resolve(process.env.HOME || process.env.USERPROFILE || ".", path.slice(1));
  }
  return resolve(path);
}

export function loadEnvFile(path) {
  if (!existsSync(path)) {
    return;
  }
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) {
      continue;
    }
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function loadEnv() {
  loadEnvFile(resolve(REPO_ROOT, ".env"));
  loadEnvFile(resolve(agentWorkspace(), ".env"));
}
