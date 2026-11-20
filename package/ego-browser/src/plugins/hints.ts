import { registerRoundFinalizer } from "../output-sink.js";
import { schemaCallShape, schemaResultShape } from "./json-schema.js";
import { hostMatches, urlHostname, type PluginManifest } from "./manifest.js";
import {
  officialIndexIsStale,
  pluginPaths,
  readJsonFile,
  refreshOfficialIndex,
  writeJsonFile,
} from "./store.js";
import { knownPlugins } from "./catalog.js";

/**
 * Passive plugin discovery. When a round touched a Page on a site that has a
 * plugin, one short hint with the exact call is appended to that round's
 * output. The Agent learns about the plugin from the page it opened anyway, so
 * discovery costs no extra tool call. Each task space sees the hint for a
 * plugin once; `EGO_BROWSER_PLUGIN_HINTS=0` turns hints off.
 */

type PageLike = {
  label: string;
  spaceId: number;
  targetId?: string;
};
type TaskLike = {
  name?: string;
  cdp(method: string, params?: unknown, options?: unknown): Promise<any>;
};

type SeenFile = Record<string, number>;

const MAX_PAGES = 5;
const MAX_COMMANDS = 3;
const SEEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SEEN_MAX_ENTRIES = 1000;
const INDEX_REFRESH_MS = 3_000;

const touched = new Map<string, { page: PageLike; task: TaskLike }>();
const usedThisRound = new Set<string>();
let finalizerRegistered = false;

export function hintsEnabled(): boolean {
  const value = process.env.EGO_BROWSER_PLUGIN_HINTS;
  return !(value && ["0", "off", "false"].includes(value.toLowerCase()));
}

export function notePageTouched(page: unknown, task: unknown): void {
  if (!hintsEnabled()) return;
  const candidate = page as PageLike;
  if (!candidate || typeof candidate.label !== "string") return;
  const key = `${candidate.spaceId}:${candidate.label}`;
  if (!touched.has(key) && touched.size >= MAX_PAGES) return;
  touched.set(key, { page: candidate, task: task as TaskLike });
  if (!finalizerRegistered) {
    finalizerRegistered = true;
    registerRoundFinalizer(() => buildRoundHints());
  }
}

/** A plugin the Agent already called needs no hint in that space. */
export function notePluginUsed(
  spaceId: number,
  taskName: string | undefined,
  pluginId: string,
): void {
  usedThisRound.add(seenKey(spaceId, taskName, pluginId));
}

export async function buildRoundHints(
  resolveUrl: (
    page: PageLike,
    task: TaskLike,
  ) => Promise<string | undefined> = targetUrl,
): Promise<string | undefined> {
  if (!hintsEnabled() || touched.size === 0) return undefined;
  const pages = [...touched.values()];
  const located: Array<{ page: PageLike; task: TaskLike; host: string }> = [];
  for (const { page, task } of pages) {
    const host = urlHostname(
      await resolveUrl(page, task).catch(() => undefined),
    );
    if (host) located.push({ page, task, host });
  }
  if (located.length === 0) return undefined;
  if (officialIndexIsStale()) await refreshOfficialIndex(INDEX_REFRESH_MS);

  const plugins = knownPlugins();
  const seenPath = pluginPaths().hints;
  const seen = pruneSeen(readJsonFile<SeenFile>(seenPath) || {});
  const now = Date.now();
  const blocks: string[] = [];
  for (const { page, task, host } of located) {
    const matches = plugins.filter(
      (plugin) =>
        plugin.manifest &&
        hostMatches(host, plugin.manifest.domains) &&
        !plugin.revoked,
    );
    const fresh = matches.filter((plugin) => {
      const key = seenKey(page.spaceId, task.name, plugin.id);
      return !usedThisRound.has(key) && seen[key] === undefined;
    });
    if (fresh.length === 0) continue;
    for (const plugin of fresh)
      seen[seenKey(page.spaceId, task.name, plugin.id)] = now;
    blocks.push(
      formatHint(
        page.label,
        host,
        fresh.map((p) => p.manifest!),
      ),
    );
  }
  if (blocks.length === 0) return undefined;
  try {
    writeJsonFile(seenPath, seen);
  } catch {
    // Without a writable home the hint may repeat; it still helps.
  }
  return blocks.join("");
}

export function formatHint(
  label: string,
  host: string,
  manifests: PluginManifest[],
): string {
  const lines: string[] = [];
  let shown = 0;
  let total = 0;
  for (const manifest of manifests) {
    for (const [name, command] of Object.entries(manifest.commands)) {
      total += 1;
      if (shown >= MAX_COMMANDS) continue;
      shown += 1;
      lines.push(
        `  await page.runPlugin(${JSON.stringify(`${manifest.id}/${name}`)}, ${schemaCallShape(command.args)}) → ${schemaResultShape(command.returns)}  ${command.description}`,
      );
    }
  }
  const more = total > shown ? ` (${total - shown} more)` : "";
  const ids = manifests.map((manifest) => manifest.id).join(", ");
  return (
    `[ego-browser:plugins] Page ${label} is on ${host}. Site plugin ${ids} returns structured data without hand-written scraping; prefer it when it fits the task:\n` +
    `${lines.join("\n")}\n` +
    `  plugins(${JSON.stringify(host)}) shows every command and argument${more}. On a plugin error, follow its "Next:" line.\n`
  );
}

async function targetUrl(
  page: PageLike,
  task: TaskLike,
): Promise<string | undefined> {
  if (!page.targetId) return undefined;
  // A browser-level call: unlike Runtime.evaluate it answers even when the
  // page is busy or shows a JavaScript dialog.
  const result = await task.cdp(
    "Target.getTargetInfo",
    { targetId: page.targetId },
    { timeout: 1_000 },
  );
  return result?.targetInfo?.url;
}

function seenKey(
  spaceId: number,
  taskName: string | undefined,
  pluginId: string,
): string {
  return `${spaceId}:${taskName ?? ""}:${pluginId}`;
}

function pruneSeen(seen: SeenFile): SeenFile {
  const now = Date.now();
  const entries = Object.entries(seen)
    .filter(([, time]) => typeof time === "number" && now - time < SEEN_TTL_MS)
    .sort((a, b) => b[1] - a[1])
    .slice(0, SEEN_MAX_ENTRIES);
  return Object.fromEntries(entries);
}

/** Clear round state. Real rounds get a fresh process; tests reuse one. */
export function resetHints(): void {
  touched.clear();
  usedThisRound.clear();
  finalizerRegistered = false;
}
