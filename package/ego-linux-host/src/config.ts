import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  defaultCdpPort,
  defaultConfigDir,
  defaultDataDir,
  defaultProfileDir,
  defaultSocketPath,
} from "./paths.js";

export type HostConfig = {
  chromePath: string | null;
  userDataDir: string;
  cdpPort: number;
  headless: boolean;
  hostSocket: string;
  dataDir: string;
  seedFromChrome: boolean;
};

/** Optional fields from ~/.config/ego-lite/config.json */
type FileConfig = {
  chromePath?: string | null;
  userDataDir?: string;
  cdpPort?: number;
  headless?: boolean;
  seedFromChrome?: boolean;
  hostSocket?: string;
};

function configFilePath(env: NodeJS.ProcessEnv): string {
  return join(defaultConfigDir(env), "config.json");
}

async function readFileConfig(env: NodeJS.ProcessEnv): Promise<FileConfig> {
  const path = configFilePath(env);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as FileConfig;
    }
    return {};
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return {};
    throw err;
  }
}

function parseTruthy(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === "") return undefined;
  const v = raw.toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return Boolean(raw);
}

/**
 * Load host config: defaults from paths, optional config.json, env overrides.
 * Precedence: env > file > path defaults.
 */
export async function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HostConfig> {
  const file = await readFileConfig(env);

  const dataDir = defaultDataDir(env);

  let chromePath: string | null;
  if (env.EGO_CHROME_PATH !== undefined && env.EGO_CHROME_PATH !== "") {
    chromePath = env.EGO_CHROME_PATH;
  } else if (file.chromePath !== undefined) {
    chromePath = file.chromePath;
  } else {
    chromePath = null;
  }

  let userDataDir: string;
  if (env.EGO_USER_DATA_DIR) {
    userDataDir = env.EGO_USER_DATA_DIR;
  } else if (file.userDataDir) {
    userDataDir = file.userDataDir;
  } else {
    userDataDir = defaultProfileDir(env);
  }

  let cdpPort: number;
  if (env.EGO_CDP_PORT) {
    cdpPort = Number(env.EGO_CDP_PORT);
  } else if (file.cdpPort !== undefined) {
    cdpPort = Number(file.cdpPort);
  } else {
    cdpPort = defaultCdpPort(env);
  }

  const headlessEnv = parseTruthy(env.EGO_HEADLESS);
  const headless =
    headlessEnv !== undefined ? headlessEnv : (file.headless ?? false);

  let hostSocket: string;
  if (env.EGO_HOST_SOCK) {
    hostSocket = env.EGO_HOST_SOCK;
  } else if (file.hostSocket) {
    hostSocket = file.hostSocket;
  } else {
    hostSocket = defaultSocketPath(env);
  }

  const seedFromChrome = file.seedFromChrome ?? false;

  return {
    chromePath,
    userDataDir,
    cdpPort,
    headless,
    hostSocket,
    dataDir,
    seedFromChrome,
  };
}
