import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { runtimeStateDir } from "./env.js";
import {
  validatePageRefState,
  type PageRefState,
} from "./page-ref-registry.js";

export type PageOrigin = "agent" | "unknown";

export type PageLedgerEntry = {
  targetId: string;
  openedBy: PageOrigin;
  /**
   * Opened by the agent during the current task. Only these Pages count
   * against the page budget; finish() clears the flag on the Pages it keeps.
   */
  createdInTask?: boolean;
  refs?: PageRefState;
};

export type ManagedPage = PageLedgerEntry & {
  label: string;
};

export type PageLedger = {
  browserInstanceId?: string;
  spaceId: number;
  nextLabel: number;
  usedLabels: string[];
  releasedLabels: string[];
  initialized: boolean;
  userControlPending: boolean;
  /**
   * Tabs that are not Pages. Current runtimes record only the SDK's blank
   * anchor tabs here (origin "agent"); "unknown" entries come from earlier
   * runtimes and become Pages at the next reconcile with control.
   */
  unmanagedTargets: Record<string, PageOrigin>;
  /**
   * Written by earlier runtimes: agent tabs a finish() left open for the
   * user. Read once and converted into agent-origin Pages.
   */
  retainedTargets: string[];
  /**
   * Written by runtimes that track `createdInTask`. Without it, the agent
   * Pages of an earlier runtime's ledger belong to a task still in progress
   * and are read as budgeted.
   */
  budgetTracked: true;
  pages: Record<string, PageLedgerEntry>;
};

type PageLedgerStoreOptions = {
  rootDir?: string;
  browserInstanceId?: string | (() => string | Promise<string>);
  staleAfterMs?: number;
  now?: () => number;
  /** Test seam for removing superseded ledger versions. */
  remove?: (path: string) => Promise<void>;
  /** Test seam for reading one ledger version. */
  read?: (path: string) => Promise<string>;
  /** Test seam for pacing retries of a locked ledger version. */
  sleep?: (ms: number) => Promise<unknown>;
};

const DEFAULT_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_WRITE_CONFLICTS = 8;
const LEDGER_FILE_PATTERN = /^space-\d+(@[A-Za-z0-9_-]+)?(\.\d+)?\.json$/;

/**
 * Codes under which an existing ledger version cannot be opened right now.
 * Windows reports a file that another process holds without read sharing as
 * EPERM/EACCES/EBUSY. The hold normally clears within milliseconds, so the
 * read is retried briefly (about 1.8 s in total) before it fails. The locked
 * version is still the current ledger: reading an older version, or an empty
 * ledger, in its place would let the next write supersede it with stale state
 * that outlives the lock.
 */
const LOCKED_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const LOCKED_READ_ATTEMPTS = 10;
const LOCKED_READ_BASE_MS = 20;
const LOCKED_READ_MAX_MS = 250;

/** A version with the next sequence number appeared between load and write. */
class LedgerWriteConflict extends Error {}

/** The current ledger version is held open by another process. */
class LedgerLockedError extends Error {
  constructor(path: string, cause: Error) {
    super(
      `cannot read page ledger ${path}: ${cause.message}. Another process holds the file open; the ledger was left unchanged`,
      { cause },
    );
    this.name = "LedgerLockedError";
  }
}

type LedgerFile = { seq: number; path: string };

/** Stable across Agent rounds and Node-service restarts in one Ego Lite run. */
export function runtimeInstanceId(parentPid = process.ppid): string {
  return `browser-host:${parentPid}`;
}

type AddPageOptions = {
  openedBy?: PageOrigin;
};

type ReconcileOptions = {
  /**
   * The agent controls the space: every live tab that is not an SDK anchor
   * becomes a Page. Without control, new tabs are left unrecorded.
   */
  assignLabels?: boolean;
  afterUserControl?: boolean;
  /**
   * Live tabs still showing a blank document. At a user-control boundary an
   * SDK anchor outside this set was navigated by the user and becomes an
   * unknown-origin Page; without the set, anchors stay anchors.
   */
  blankTargetIds?: Iterable<string>;
};

/**
 * Stores durable page labels in one JSON document per task space and browser
 * instance. Space ids restart at 1 in every Ego Lite instance, so concurrent
 * instances sharing the state directory must not share a file.
 *
 * Every write creates a new numbered version (`space-<id>@<instance>.<n>.json`)
 * and the highest version that parses is the current ledger. No file is ever
 * renamed over or truncated in place: on Windows, replacing a file that
 * another process (an antivirus scan, the search indexer, a concurrent
 * reader) holds open fails with EPERM for as long as that handle stays open,
 * which used to abort the caller's script. Superseded versions are removed
 * best-effort after each write, so one that is still held open is simply
 * left for a later write. Readers skip a version that is gone or does not
 * parse yet, so a write in progress is invisible until it is complete; a
 * version that exists but is locked is retried and then reported, never
 * replaced.
 */
export class PageLedgerStore {
  readonly rootDir: string;
  readonly #browserInstanceId?: string | (() => string | Promise<string>);
  readonly #staleAfterMs: number;
  readonly #now: () => number;
  readonly #remove: (path: string) => Promise<void>;
  readonly #read: (path: string) => Promise<string>;
  readonly #sleep: (ms: number) => Promise<unknown>;
  #resolvedBrowserInstanceId?: Promise<string | undefined>;
  #cleanup?: Promise<void>;

  constructor(options: PageLedgerStoreOptions = {}) {
    this.rootDir = options.rootDir || runtimeStateDir();
    this.#browserInstanceId = options.browserInstanceId;
    this.#staleAfterMs =
      options.staleAfterMs === undefined
        ? DEFAULT_STALE_AFTER_MS
        : options.staleAfterMs;
    this.#now = options.now || Date.now;
    this.#remove = options.remove || ((path) => rm(path, { force: true }));
    this.#read = options.read || ((path) => readFile(path, "utf8"));
    this.#sleep = options.sleep || sleep;
    if (!Number.isFinite(this.#staleAfterMs) || this.#staleAfterMs < 0) {
      throw new TypeError("staleAfterMs must be a non-negative number");
    }
  }

  async read(spaceId: number): Promise<PageLedger> {
    assertSpaceId(spaceId);
    const ledger = await this.#readCurrent(spaceId);
    return cloneLedger(ledger);
  }

  /** Replace any stale state for a newly created space with its Agent-owned p1. */
  async initializeCreatedSpace(
    spaceId: number,
    targetId: string,
  ): Promise<ManagedPage> {
    assertSpaceId(spaceId);
    assertTargetId(targetId);
    const browserInstanceId = await this.#currentBrowserInstanceId();
    await this.#cleanupExpiredLedgers(browserInstanceId);
    const ledger = emptyLedger(spaceId, browserInstanceId);
    const label = nextAutomaticLabel(ledger, new Set());
    const entry: PageLedgerEntry = {
      targetId,
      openedBy: "agent",
      createdInTask: true,
    };
    ledger.initialized = true;
    ledger.usedLabels.push(label);
    ledger.pages[label] = entry;
    await this.#writeLatest(spaceId, ledger);
    return { label, ...entry };
  }

  /**
   * Remove all Page-model state after its task space is finished or closed.
   * A version that another process still holds open stays behind; it is
   * expired like any other stale ledger.
   */
  async discard(spaceId: number): Promise<void> {
    assertSpaceId(spaceId);
    const browserInstanceId = await this.#currentBrowserInstanceId();
    await this.#removeAll(await this.#listVersions(spaceId, browserInstanceId));
  }

  /**
   * End a task whose space stays open for the user. The Pages left open keep
   * their labels and origin, so a later claim continues with the same labels
   * and closes only the agent's own Pages. Label numbering continues, the
   * Pages stop counting against the budget, and tabs the user opens before
   * the next claim are recorded as unknown origin.
   */
  async retainForUser(spaceId: number): Promise<void> {
    await this.#update(spaceId, (ledger) => {
      for (const page of Object.values(ledger.pages)) {
        delete page.createdInTask;
      }
      ledger.retainedTargets = [];
      ledger.userControlPending = true;
    });
  }

  async getPage(spaceId: number, label: string): Promise<ManagedPage> {
    assertLabel(label);
    const ledger = await this.read(spaceId);
    const entry = ledger.pages[label];
    if (entry) return { label, ...entry };
    if (ledger.releasedLabels.includes(label)) {
      throw new Error(`page ${label} was released`);
    }
    if (ledger.usedLabels.includes(label)) {
      throw new Error(`page ${label} was closed`);
    }
    throw new Error(`page label not found: ${label}`);
  }

  async addPage(
    spaceId: number,
    targetId: string,
    options: AddPageOptions = {},
  ): Promise<ManagedPage> {
    assertTargetId(targetId);
    let added: ManagedPage;
    await this.#update(spaceId, (ledger) => {
      const existing = Object.entries(ledger.pages).find(
        ([, page]) => page.targetId === targetId,
      );
      if (existing) {
        throw new Error(`target ${targetId} is already page ${existing[0]}`);
      }

      const label = nextAutomaticLabel(ledger, new Set(ledger.usedLabels));
      const openedBy = options.openedBy || "agent";
      const entry: PageLedgerEntry = {
        targetId,
        openedBy,
        ...(openedBy === "agent" ? { createdInTask: true } : {}),
      };
      ledger.initialized = true;
      delete ledger.unmanagedTargets[targetId];
      ledger.usedLabels.push(label);
      ledger.pages[label] = entry;
      added = { label, ...entry };
    });
    return added!;
  }

  async setPageRefs(
    spaceId: number,
    label: string,
    refs: PageRefState,
  ): Promise<void> {
    assertLabel(label);
    await this.#update(spaceId, (ledger) => {
      const page = ledger.pages[label];
      if (!page) throw new Error(`page label not found: ${label}`);
      page.refs = validatePageRefState(refs);
    });
  }

  async closePage(spaceId: number, label: string): Promise<ManagedPage> {
    assertLabel(label);
    let removed: ManagedPage;
    await this.#update(spaceId, (ledger) => {
      const entry = ledger.pages[label];
      if (!entry) {
        if (ledger.releasedLabels.includes(label)) {
          throw new Error(`page ${label} was released`);
        }
        if (ledger.usedLabels.includes(label)) {
          throw new Error(`page ${label} was closed`);
        }
        throw new Error(`page label not found: ${label}`);
      }
      removed = { label, ...entry };
      delete ledger.pages[label];
    });
    return removed!;
  }

  async keepUnmanaged(
    spaceId: number,
    targetId: string,
    openedBy: PageOrigin = "unknown",
  ): Promise<void> {
    assertTargetId(targetId);
    if (!["agent", "unknown"].includes(openedBy)) {
      throw new TypeError(`invalid unmanaged page origin: ${openedBy}`);
    }
    await this.#update(spaceId, (ledger) => {
      const existing = Object.entries(ledger.pages).find(
        ([, page]) => page.targetId === targetId,
      );
      if (existing) {
        throw new Error(`target ${targetId} is already page ${existing[0]}`);
      }
      ledger.initialized = true;
      ledger.unmanagedTargets[targetId] = openedBy;
    });
  }

  /** Mark the next reconciliation as crossing a user-control boundary. */
  async beginUserControl(spaceId: number): Promise<void> {
    await this.#update(spaceId, (ledger) => {
      ledger.userControlPending = true;
    });
  }

  /** Roll back a boundary marker when the native handoff itself fails. */
  async cancelUserControl(spaceId: number): Promise<void> {
    await this.#update(spaceId, (ledger) => {
      ledger.userControlPending = false;
    });
  }

  async reconcile(
    spaceId: number,
    liveTargetIds: Iterable<string>,
    options: ReconcileOptions = {},
  ): Promise<PageLedger> {
    const live = new Set(liveTargetIds);
    const current = await this.read(spaceId);
    const hasMissingPage = Object.values(current.pages).some(
      (page) => !live.has(page.targetId),
    );
    const hasMissingUnmanaged = Object.keys(current.unmanagedTargets).some(
      (targetId) => !live.has(targetId),
    );
    const blank = options.blankTargetIds
      ? new Set(options.blankTargetIds)
      : undefined;
    const atUserBoundary = (ledger: PageLedger) =>
      !ledger.initialized ||
      options.afterUserControl === true ||
      ledger.userControlPending;
    const usedAnchors = (ledger: PageLedger) =>
      blank && atUserBoundary(ledger) ? blank : undefined;
    const unlabeled = unlabeledTargets(current, live, usedAnchors(current));
    const needsLabels =
      options.assignLabels === true &&
      (unlabeled.length > 0 ||
        !current.initialized ||
        current.userControlPending ||
        current.retainedTargets.length > 0);
    if (!hasMissingPage && !hasMissingUnmanaged && !needsLabels) {
      return current;
    }

    return this.#update(spaceId, (ledger) => {
      for (const [label, page] of Object.entries(ledger.pages)) {
        if (!live.has(page.targetId)) delete ledger.pages[label];
      }
      for (const targetId of Object.keys(ledger.unmanagedTargets)) {
        if (!live.has(targetId)) delete ledger.unmanagedTargets[targetId];
      }
      ledger.retainedTargets = ledger.retainedTargets.filter((targetId) =>
        live.has(targetId),
      );
      if (!options.assignLabels) return;

      // A tab first seen without a ledger, or after the user had control, may
      // be the user's: record it as unknown origin so finish() leaves it open.
      // It is still a Page the agent can operate.
      const fromUser = atUserBoundary(ledger);
      const retained = new Set(ledger.retainedTargets);
      const used = new Set(ledger.usedLabels);
      for (const targetId of unlabeledTargets(
        ledger,
        live,
        usedAnchors(ledger),
      )) {
        const legacyOrigin = ledger.unmanagedTargets[targetId];
        const openedBy: PageOrigin = retained.has(targetId)
          ? "agent"
          : legacyOrigin === "unknown" || fromUser
            ? "unknown"
            : "agent";
        const createdInTask =
          openedBy === "agent" && !retained.has(targetId) && !fromUser;
        const label = nextAutomaticLabel(ledger, used);
        used.add(label);
        ledger.usedLabels.push(label);
        ledger.pages[label] = {
          targetId,
          openedBy,
          ...(createdInTask ? { createdInTask: true } : {}),
        };
        delete ledger.unmanagedTargets[targetId];
      }
      ledger.retainedTargets = [];
      ledger.initialized = true;
      ledger.userControlPending = false;
    });
  }

  async #update(
    spaceId: number,
    mutate: (ledger: PageLedger) => void,
  ): Promise<PageLedger> {
    assertSpaceId(spaceId);
    for (let conflicts = 0; ; conflicts++) {
      const { ledger, files } = await this.#load(spaceId);
      mutate(ledger);
      try {
        await this.#write(spaceId, ledger, files);
        return cloneLedger(ledger);
      } catch (error) {
        if (
          !(error instanceof LedgerWriteConflict) ||
          conflicts >= MAX_WRITE_CONFLICTS
        ) {
          throw error;
        }
      }
    }
  }

  async #readCurrent(spaceId: number): Promise<PageLedger> {
    return (await this.#load(spaceId)).ledger;
  }

  /**
   * The current ledger plus every version file it was chosen from. A version
   * held open by another process is retried with backoff, then reported.
   */
  async #load(
    spaceId: number,
  ): Promise<{ ledger: PageLedger; files: LedgerFile[] }> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#loadOnce(spaceId);
      } catch (error) {
        if (
          !(error instanceof LedgerLockedError) ||
          attempt >= LOCKED_READ_ATTEMPTS
        ) {
          throw error;
        }
        await this.#sleep(
          Math.min(LOCKED_READ_BASE_MS * 2 ** attempt, LOCKED_READ_MAX_MS),
        );
      }
    }
  }

  async #loadOnce(
    spaceId: number,
  ): Promise<{ ledger: PageLedger; files: LedgerFile[] }> {
    const browserInstanceId = await this.#currentBrowserInstanceId();
    await this.#cleanupExpiredLedgers(browserInstanceId);
    const files = await this.#listVersions(spaceId, browserInstanceId);
    for (const file of files) {
      const stored = await this.#readLedgerJson(file.path);
      if (stored === undefined) continue;
      return {
        ledger:
          ownedLedger(stored, spaceId, file.path, browserInstanceId) ||
          emptyLedger(spaceId, browserInstanceId),
        files,
      };
    }
    if (browserInstanceId === undefined || files.length > 0) {
      return { ledger: emptyLedger(spaceId, browserInstanceId), files };
    }

    // Earlier SDKs wrote every instance's ledger to the shared space file.
    // Move this instance's ledger (or one from before instance ids existed)
    // so an SDK upgrade does not discard live Page labels.
    const legacyPath = this.#legacyPath(spaceId);
    const legacy = await this.#readLedgerJson(legacyPath);
    const ledger =
      legacy === undefined
        ? undefined
        : ownedLedger(legacy, spaceId, legacyPath, browserInstanceId);
    if (!ledger) {
      return { ledger: emptyLedger(spaceId, browserInstanceId), files };
    }
    ledger.browserInstanceId = browserInstanceId;
    const written = await this.#writeLatest(spaceId, ledger);
    await this.#remove(legacyPath).catch(() => {});
    return { ledger, files: written };
  }

  /** Write `ledger` as the next version, whatever versions exist right now. */
  async #writeLatest(
    spaceId: number,
    ledger: PageLedger,
  ): Promise<LedgerFile[]> {
    const browserInstanceId = await this.#currentBrowserInstanceId();
    for (let conflicts = 0; ; conflicts++) {
      const files = await this.#listVersions(spaceId, browserInstanceId);
      try {
        return await this.#write(spaceId, ledger, files);
      } catch (error) {
        if (
          !(error instanceof LedgerWriteConflict) ||
          conflicts >= MAX_WRITE_CONFLICTS
        ) {
          throw error;
        }
      }
    }
  }

  /**
   * Create the version after `files` (the listing the ledger was loaded
   * from), then remove those superseded versions. Another writer that got
   * there first raises LedgerWriteConflict so the caller reloads instead of
   * overwriting its update.
   */
  async #write(
    spaceId: number,
    ledger: PageLedger,
    files: LedgerFile[],
  ): Promise<LedgerFile[]> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const seq = (files[0]?.seq ?? 0) + 1;
    const path = `${this.#base(spaceId, await this.#currentBrowserInstanceId())}.${seq}.json`;
    try {
      await writeFile(path, `${JSON.stringify(ledger, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if ((error as { code?: string })?.code === "EEXIST") {
        throw new LedgerWriteConflict(
          `page ledger ${path} was written concurrently`,
        );
      }
      throw error;
    }
    await this.#removeAll(files);
    return [{ seq, path }];
  }

  /** Best-effort removal: a version held open elsewhere is left behind. */
  async #removeAll(files: LedgerFile[]): Promise<void> {
    await Promise.all(
      files.map((file) => this.#remove(file.path).catch(() => {})),
    );
  }

  /** Every version of one space's ledger, newest first; the unnumbered legacy file is version 0. */
  async #listVersions(
    spaceId: number,
    browserInstanceId: string | undefined,
  ): Promise<LedgerFile[]> {
    let names: string[];
    try {
      names = await readdir(this.rootDir);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    // The base holds only digits and a sanitized [A-Za-z0-9_-] scope.
    const base = `space-${spaceId}${scopeSuffix(browserInstanceId)}`;
    const pattern = new RegExp(`^${base}(?:\\.(\\d+))?\\.json$`);
    return names
      .flatMap((name) => {
        const match = pattern.exec(name);
        if (!match) return [];
        return [
          {
            seq: match[1] ? Number(match[1]) : 0,
            path: join(this.rootDir, name),
          },
        ];
      })
      .sort((a, b) => b.seq - a.seq);
  }

  async #currentBrowserInstanceId(): Promise<string | undefined> {
    this.#resolvedBrowserInstanceId ||= Promise.resolve(
      typeof this.#browserInstanceId === "function"
        ? this.#browserInstanceId()
        : this.#browserInstanceId,
    ).then((value) => {
      if (value === undefined) return undefined;
      if (typeof value !== "string" || value.length === 0) {
        throw new TypeError("browserInstanceId must be a non-empty string");
      }
      return value;
    });
    return this.#resolvedBrowserInstanceId;
  }

  async #cleanupExpiredLedgers(
    browserInstanceId: string | undefined,
  ): Promise<void> {
    if (browserInstanceId === undefined) return;
    this.#cleanup ||= this.#removeExpiredLedgers(browserInstanceId);
    await this.#cleanup;
  }

  async #removeExpiredLedgers(browserInstanceId: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.rootDir);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    await Promise.all(
      names
        .filter((name) => LEDGER_FILE_PATTERN.test(name))
        .map(async (name) => {
          const path = join(this.rootDir, name);
          const metadata = await stat(path).catch(() => undefined);
          if (
            !metadata ||
            this.#now() - metadata.mtimeMs < this.#staleAfterMs
          ) {
            return;
          }
          let storedInstanceId: string | undefined;
          try {
            storedInstanceId = ledgerBrowserInstanceId(
              JSON.parse(await readFile(path, "utf8")),
            );
          } catch {
            // An expired unreadable ledger cannot belong to the active browser.
          }
          if (storedInstanceId !== browserInstanceId) {
            await rm(path, { force: true });
          }
        }),
    );
  }

  /**
   * Read one ledger document. Returns undefined when the file is gone or does
   * not parse: a version another process is still writing, or one left
   * truncated by a crash, must not shadow the version before it. A file that
   * exists but cannot be opened is reported instead, so a reader never
   * mistakes a locked current version for a missing one.
   */
  async #readLedgerJson(path: string): Promise<unknown> {
    let raw: string;
    try {
      raw = await this.#read(path);
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      if (LOCKED_CODES.has(error?.code)) {
        throw new LedgerLockedError(path, error);
      }
      throw error;
    }
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  #base(spaceId: number, browserInstanceId?: string): string {
    return join(
      this.rootDir,
      `space-${spaceId}${scopeSuffix(browserInstanceId)}`,
    );
  }

  /** The shared, unnumbered file that SDKs before instance ids wrote. */
  #legacyPath(spaceId: number): string {
    return `${this.#base(spaceId)}.json`;
  }
}

function scopeSuffix(browserInstanceId: string | undefined): string {
  return browserInstanceId === undefined
    ? ""
    : `@${browserInstanceId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

/** Validate a stored ledger, or return undefined when another browser wrote it. */
function ownedLedger(
  value: unknown,
  spaceId: number,
  path: string,
  browserInstanceId: string | undefined,
): PageLedger | undefined {
  const storedBrowserInstanceId = ledgerBrowserInstanceId(value);
  if (
    browserInstanceId !== undefined &&
    storedBrowserInstanceId !== undefined &&
    storedBrowserInstanceId !== browserInstanceId
  ) {
    return undefined;
  }
  return validateLedger(value, spaceId, path);
}

function emptyLedger(spaceId: number, browserInstanceId?: string): PageLedger {
  return {
    ...(browserInstanceId ? { browserInstanceId } : {}),
    spaceId,
    nextLabel: 1,
    usedLabels: [],
    releasedLabels: [],
    initialized: false,
    userControlPending: false,
    unmanagedTargets: {},
    retainedTargets: [],
    budgetTracked: true,
    pages: {},
  };
}

function ledgerBrowserInstanceId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const browserInstanceId = (value as { browserInstanceId?: unknown })
    .browserInstanceId;
  return typeof browserInstanceId === "string" && browserInstanceId.length > 0
    ? browserInstanceId
    : undefined;
}

/**
 * Live tabs that are neither Pages nor SDK anchors. An agent-origin
 * unmanaged tab is an anchor unless an earlier runtime retained it for the
 * user, or (when `blankTargets` is given at a user-control boundary) the
 * user navigated it away from its blank document.
 */
function unlabeledTargets(
  ledger: PageLedger,
  live: Set<string>,
  blankTargets?: Set<string>,
): string[] {
  const managed = new Set(
    Object.values(ledger.pages).map((page) => page.targetId),
  );
  const retained = new Set(ledger.retainedTargets);
  return [...live].filter(
    (targetId) =>
      !managed.has(targetId) &&
      (ledger.unmanagedTargets[targetId] !== "agent" ||
        retained.has(targetId) ||
        (blankTargets !== undefined && !blankTargets.has(targetId))),
  );
}

function nextAutomaticLabel(ledger: PageLedger, used: Set<string>): string {
  let sequence = ledger.nextLabel;
  let label = `p${sequence}`;
  while (used.has(label)) {
    sequence += 1;
    label = `p${sequence}`;
  }
  ledger.nextLabel = sequence + 1;
  return label;
}

function validateLedger(
  value: unknown,
  expectedSpaceId: number,
  path: string,
): PageLedger {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid page ledger ${path}: expected an object`);
  }
  const stored = value as PageLedger & { handoffBaseline?: unknown };
  // Defaults keep ledgers written by earlier runtimes readable. They start
  // uninitialized so the first new runtime observes a safe control baseline
  // instead of silently adopting pre-existing user tabs.
  const releasedLabels = stored.releasedLabels ?? [];
  const initialized = stored.initialized ?? false;
  const legacyHandoffBaseline = stored.handoffBaseline;
  const userControlPending =
    stored.userControlPending ??
    (legacyHandoffBaseline !== undefined && legacyHandoffBaseline !== null);
  const unmanagedTargets = stored.unmanagedTargets ?? {};
  const retainedTargets = stored.retainedTargets ?? [];
  // An earlier runtime discarded the ledger at finish(), so its agent Pages
  // always belong to the task in progress.
  const legacyBudget =
    (stored as { budgetTracked?: unknown }).budgetTracked !== true;
  if (
    (stored.browserInstanceId !== undefined &&
      (typeof stored.browserInstanceId !== "string" ||
        stored.browserInstanceId.length === 0)) ||
    stored.spaceId !== expectedSpaceId ||
    !Number.isInteger(stored.nextLabel) ||
    stored.nextLabel < 1 ||
    !Array.isArray(stored.usedLabels) ||
    stored.usedLabels.some((label) => typeof label !== "string") ||
    !Array.isArray(releasedLabels) ||
    releasedLabels.some(
      (label) =>
        typeof label !== "string" ||
        !stored.usedLabels.includes(label) ||
        Object.hasOwn(stored.pages || {}, label),
    ) ||
    typeof initialized !== "boolean" ||
    typeof userControlPending !== "boolean" ||
    (legacyHandoffBaseline !== undefined &&
      legacyHandoffBaseline !== null &&
      (!Array.isArray(legacyHandoffBaseline) ||
        legacyHandoffBaseline.some(
          (targetId) => typeof targetId !== "string" || targetId.length === 0,
        ))) ||
    !unmanagedTargets ||
    typeof unmanagedTargets !== "object" ||
    Array.isArray(unmanagedTargets) ||
    Object.entries(unmanagedTargets).some(
      ([targetId, openedBy]) =>
        targetId.length === 0 ||
        !["agent", "user", "unknown"].includes(openedBy),
    ) ||
    !Array.isArray(retainedTargets) ||
    retainedTargets.some(
      (targetId) => typeof targetId !== "string" || targetId.length === 0,
    ) ||
    !stored.pages ||
    typeof stored.pages !== "object" ||
    Array.isArray(stored.pages)
  ) {
    throw new Error(`invalid page ledger ${path}: schema mismatch`);
  }
  const pages: Record<string, PageLedgerEntry> = {};
  for (const [label, page] of Object.entries(stored.pages)) {
    if (
      !stored.usedLabels.includes(label) ||
      !page ||
      typeof page.targetId !== "string" ||
      !["agent", "user", "unknown"].includes(page.openedBy) ||
      (page.createdInTask !== undefined &&
        typeof page.createdInTask !== "boolean")
    ) {
      throw new Error(`invalid page ledger ${path}: invalid page ${label}`);
    }
    if (Object.hasOwn(unmanagedTargets, page.targetId)) {
      throw new Error(
        `invalid page ledger ${path}: target ${page.targetId} is both managed and unmanaged`,
      );
    }
    pages[label] = {
      targetId: page.targetId,
      openedBy: normalizePageOrigin(page.openedBy),
      ...(page.createdInTask ||
      (legacyBudget && normalizePageOrigin(page.openedBy) === "agent")
        ? { createdInTask: true }
        : {}),
      ...(page.refs === undefined
        ? {}
        : { refs: validatePageRefState(page.refs) }),
    };
  }
  const normalizedUnmanagedTargets = Object.fromEntries(
    Object.entries(unmanagedTargets).map(([targetId, openedBy]) => [
      targetId,
      normalizePageOrigin(openedBy),
    ]),
  );
  return {
    ...(stored.browserInstanceId
      ? { browserInstanceId: stored.browserInstanceId }
      : {}),
    spaceId: stored.spaceId,
    nextLabel: stored.nextLabel,
    usedLabels: [...stored.usedLabels],
    releasedLabels: [...releasedLabels],
    initialized,
    userControlPending,
    unmanagedTargets: normalizedUnmanagedTargets,
    retainedTargets: [...retainedTargets],
    budgetTracked: true,
    pages,
  };
}

function normalizePageOrigin(value: unknown): PageOrigin {
  return value === "agent" ? "agent" : "unknown";
}

function cloneLedger(ledger: PageLedger): PageLedger {
  return structuredClone(ledger);
}

function assertSpaceId(spaceId: number): void {
  if (!Number.isInteger(spaceId) || spaceId < 0) {
    throw new TypeError("spaceId must be a non-negative integer");
  }
}

function assertTargetId(targetId: string): void {
  if (typeof targetId !== "string" || targetId.length === 0) {
    throw new TypeError("targetId must be a non-empty string");
  }
}

function assertLabel(label: string): void {
  if (
    typeof label !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(label)
  ) {
    throw new TypeError(
      "page label must start with a letter and contain only letters, numbers, _ or -",
    );
  }
}
