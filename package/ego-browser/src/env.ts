import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadEnvFile as loadNodeEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SRC_DIR, "..");

export function agentWorkspace() {
  if (process.env.EGO_BROWSER_AGENT_WORKSPACE) {
    return resolvePath(process.env.EGO_BROWSER_AGENT_WORKSPACE);
  }

  const bundledSkill = resolve(SRC_DIR, "agent-skills", "ego-browser");
  if (existsSync(bundledSkill)) {
    return bundledSkill;
  }

  return resolve(REPO_ROOT, "..", "..", "skills", "ego-browser");
}

/**
 * Root of the per-user state ego-browser keeps between rounds: Page ledgers
 * and the shared download directory.
 */
export function runtimeStateDir() {
  return resolvePath(
    process.env.EGO_BROWSER_STATE_DIR ||
      join(homedir(), ".ego-browser", "state"),
  );
}

/**
 * Root of installed and locally developed site plugins. Plugins are user
 * data, so they live next to the runtime state rather than inside it.
 */
export function pluginHomeDir() {
  return resolvePath(
    process.env.EGO_BROWSER_PLUGIN_HOME ||
      join(homedir(), ".ego-browser", "plugins"),
  );
}

/**
 * Index of the official plugins shipped with this SDK build. It is the
 * offline baseline; the remote official index can only add newer versions.
 */
export function bundledPluginIndexPath() {
  if (process.env.EGO_BROWSER_PLUGIN_BUNDLED_INDEX) {
    return resolvePath(process.env.EGO_BROWSER_PLUGIN_BUNDLED_INDEX);
  }
  const bundled = resolve(SRC_DIR, "official-plugins", "index.json");
  if (existsSync(bundled)) return bundled;
  // Per-file build (dist/src/...) used by tests: the bundle sits in dist/out.
  return resolve(REPO_ROOT, "out", "official-plugins", "index.json");
}

function resolvePath(path) {
  if (path.startsWith("~")) {
    return resolve(
      process.env.HOME || process.env.USERPROFILE || ".",
      path.slice(1),
    );
  }
  return resolve(path);
}

function loadEnvFile(path) {
  if (!existsSync(path)) {
    return;
  }
  loadNodeEnvFile(path);
}

export function loadEnv() {
  loadEnvFile(resolve(REPO_ROOT, ".env"));
  loadEnvFile(resolve(agentWorkspace(), ".env"));
}
