import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SRC_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SRC_DIR, "..");

export function agentWorkspace() {
  if (process.env.EGO_BROWSER_AGENT_WORKSPACE) {
    return resolvePath(process.env.EGO_BROWSER_AGENT_WORKSPACE);
  }

  const bundledSkill = resolve(SRC_DIR, "ego-browser");
  if (existsSync(bundledSkill)) {
    return bundledSkill;
  }

  return resolve(REPO_ROOT, "..", "..", "skills", "ego-browser");
}

export function resolvePath(path) {
  if (path.startsWith("~")) {
    // Use join, not resolve: path.slice(1) of "~/ws" is "/ws", which resolve()
    // would treat as an absolute path and return verbatim, dropping the home
    // directory. join keeps it relative to home ("~" -> home, "~/ws" -> home/ws).
    const home = process.env.HOME || process.env.USERPROFILE || ".";
    return resolve(join(home, path.slice(1)));
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
    const value = line
      .slice(index + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function loadEnv() {
  loadEnvFile(resolve(REPO_ROOT, ".env"));
  loadEnvFile(resolve(agentWorkspace(), ".env"));
}
