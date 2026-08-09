import { stat, unlink, writeFile } from "node:fs/promises";

export async function acquireRestartLock(
  path,
  { maxAgeMs = 20_000, now = Date.now() } = {},
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(path, String(now), { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
    }

    try {
      const info = await stat(path);
      if (now - info.mtimeMs < maxAgeMs) {
        return false;
      }
      await unlink(path);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  return false;
}
