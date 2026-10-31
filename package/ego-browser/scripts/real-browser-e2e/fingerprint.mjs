import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/**
 * A full real-browser E2E run only tells something new when its inputs
 * changed: the built SDK (`dist/out`), the suite itself, or the ego lite CLI
 * that drives it. The fingerprint hashes those so an unchanged checkout can
 * skip the suite after one full pass.
 */
export async function computeE2eFingerprint({
  inputDirs,
  cliPath,
  statFile = stat,
}) {
  const hash = createHash("sha256");
  for (const dir of inputDirs) {
    for (const file of await listFiles(dir)) {
      hash.update(`${toPosix(relative(dir, file))}\0`);
      hash.update(await readFile(file));
      hash.update("\0");
    }
  }
  hash.update(`cli:${cliPath}\0`);
  // The CLI is a binary outside this checkout; size and mtime are enough to
  // notice an app update without hashing it.
  try {
    const info = await statFile(cliPath);
    hash.update(`${info.size}:${info.mtimeMs}\0`);
  } catch {
    hash.update("unstat\0");
  }
  return hash.digest("hex");
}

export async function readLastPass(recordPath) {
  try {
    const parsed = JSON.parse(await readFile(recordPath, "utf8"));
    if (typeof parsed?.fingerprint !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeLastPass(recordPath, record) {
  await mkdir(join(recordPath, ".."), { recursive: true });
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

export function isTruthyFlag(value) {
  return value === "1" || value === "true";
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

function toPosix(path) {
  return sep === "/" ? path : path.split(sep).join("/");
}
