import { existsSync } from "node:fs";
import { join } from "node:path";

type LocateOptions = {
  env?: Record<string, string | undefined>;
  exists?: (path: string) => boolean;
};

/**
 * Locate a CDP-capable Chromium browser on Windows. Preference order:
 * the EGO_HOST_BROWSER_PATH override, then Microsoft Edge (preinstalled on
 * every Windows 10/11 machine), then Google Chrome, then Chromium.
 */
export function locateBrowser({
  env = process.env,
  exists = existsSync,
}: LocateOptions = {}) {
  const override = env.EGO_HOST_BROWSER_PATH;
  if (override) {
    if (!exists(override)) {
      throw new Error(`EGO_HOST_BROWSER_PATH does not exist: ${override}`);
    }
    return override;
  }
  for (const candidate of candidatePaths(env)) {
    if (exists(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "no Chromium-based browser found; set EGO_HOST_BROWSER_PATH to your msedge.exe or chrome.exe",
  );
}

/**
 * Standard Windows install locations, most specific browser first. Edge ships
 * under Program Files (x86) even on x64 Windows; per-user Chrome installs land
 * under LOCALAPPDATA.
 */
export function candidatePaths(env: Record<string, string | undefined>) {
  const roots = [
    env.PROGRAMFILES,
    env["PROGRAMFILES(X86)"],
    env.LOCALAPPDATA,
  ].filter(Boolean) as string[];
  const suffixes = [
    join("Microsoft", "Edge", "Application", "msedge.exe"),
    join("Google", "Chrome", "Application", "chrome.exe"),
    join("Chromium", "Application", "chrome.exe"),
  ];
  const out: string[] = [];
  for (const suffix of suffixes) {
    for (const root of roots) {
      out.push(join(root, suffix));
    }
  }
  return out;
}
