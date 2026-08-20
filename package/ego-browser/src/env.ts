import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SRC_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SRC_DIR, "..");

export function agentWorkspace({
  env = process.env,
  exists = existsSync,
} = {}) {
  if (env.EGO_BROWSER_AGENT_WORKSPACE) {
    return resolvePath(env.EGO_BROWSER_AGENT_WORKSPACE);
  }

  const bundledSkill = resolve(SRC_DIR, "ego-browser");
  if (exists(bundledSkill)) {
    return bundledSkill;
  }

  const repoSkill = resolve(REPO_ROOT, "..", "..", "skills", "ego-browser");
  if (exists(repoSkill)) {
    return repoSkill;
  }

  // In the app-bundled runtime neither module-relative candidate exists on
  // disk (the skill payload ships elsewhere in the bundle), so the repo-layout
  // path resolves to a directory that is not there. Onboarding registers the
  // shipped skill at a user-level location; accept it only when it actually
  // holds learnings, so a stale leftover directory cannot claim the workspace.
  for (const installedSkill of installedSkillCandidates(env)) {
    if (exists(resolve(installedSkill, "learnings"))) {
      return installedSkill;
    }
  }

  return repoSkill;
}

// Onboarding links the shipped skill payload to ~/.local/share/ego/ego-skills;
// depending on the link target that path is the skill directory itself or a
// directory holding an ego-browser/ subdirectory. Resolved against the home
// directory directly so behavior is identical on POSIX and Windows.
function installedSkillCandidates(env) {
  const home = env.HOME || env.USERPROFILE;
  if (!home) {
    return [];
  }
  const installRoot = resolve(home, ".local", "share", "ego", "ego-skills");
  return [resolve(installRoot, "ego-browser"), installRoot];
}

export function resolvePath(path) {
  if (path.startsWith("~")) {
    return resolve(
      process.env.HOME || process.env.USERPROFILE || ".",
      path.slice(1),
    );
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
