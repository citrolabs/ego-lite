import { existsSync } from "node:fs";

export const MACOS_EGO_LITE_CLI =
  "/Applications/ego lite.app/Contents/Frameworks/ego Framework.framework/Versions/Current/Helpers/ego-browser";

export function resolveEgoBrowserCli({
  configured = process.env.EGO_BROWSER_REAL_E2E_CLI,
  platform = process.platform,
  pathExists = existsSync,
} = {}) {
  if (typeof configured === "string" && configured.trim()) {
    return configured.trim();
  }
  if (platform === "darwin" && pathExists(MACOS_EGO_LITE_CLI)) {
    return MACOS_EGO_LITE_CLI;
  }
  return "ego-browser";
}
