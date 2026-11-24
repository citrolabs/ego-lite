import type { UnhandledPageNotice } from "./page-discovery.js";

/**
 * Round-end browser status: one line listing the task spaces the script
 * operated, so the next script knows which Pages it can use directly and which
 * spaces must be claimed or taken over first.
 *
 *   [7 "research" ready(p1:"Product",p2 user:"Sign in") | 12 "quotes" closed()]
 *
 * Spaces are listed in the order the script first operated them. `(-)` means
 * the Page list was not read: the user controls the space, or reading failed.
 * Like the rest of the round output, this state is per process.
 */

export type RoundSpaceState =
  | "ready"
  | "user_control"
  | "finished"
  | "closed"
  | "unknown";

export type RoundStatusPage = {
  label: string;
  title: string;
  targetId: string;
  openedBy: string;
};

export type RoundSpaceStatus = {
  state: RoundSpaceState;
  /** `null` prints as `(-)`: the Page list was not read. */
  pages: RoundStatusPage[] | null;
};

type TouchedSpace = {
  name: string;
  refresh?: () => Promise<RoundSpaceStatus>;
};

const REFRESH_TIMEOUT_MS = 1_500;

const touched = new Map<number, TouchedSpace>();
const statuses = new Map<number, RoundSpaceStatus>();

/**
 * Record that the script operated this space. The latest handle's refresher
 * wins, so a space claimed again in the same round reports the new handle.
 */
export function touchRoundSpace(
  spaceId: number,
  name: string,
  refresh?: () => Promise<RoundSpaceStatus>,
): void {
  touched.set(spaceId, { name, refresh });
}

/** Cache the latest known status; the exit path cannot read the browser. */
export function recordRoundSpaceStatus(
  spaceId: number,
  status: RoundSpaceStatus,
): void {
  statuses.set(spaceId, status);
}

/**
 * Drop the cached status at a control boundary (claim, takeover): a terminal
 * state recorded earlier in the round, such as `user_control` after
 * `handOff()`, no longer holds and the round-end refresh must read the space.
 */
export function forgetRoundSpaceStatus(spaceId: number): void {
  statuses.delete(spaceId);
}

/** Update a cached ready Page list after a Page was opened in this round. */
export function addRoundStatusPage(spaceId: number, page: RoundStatusPage) {
  const status = statuses.get(spaceId);
  if (status?.state !== "ready" || !status.pages) return;
  status.pages = sortPages([
    ...status.pages.filter((item) => item.label !== page.label),
    page,
  ]);
}

/** Update a cached ready Page list after a Page was closed in this round. */
export function removeRoundStatusPage(spaceId: number, label: string) {
  const status = statuses.get(spaceId);
  if (status?.state !== "ready" || !status.pages) return;
  status.pages = status.pages.filter((item) => item.label !== label);
}

/**
 * Re-read spaces whose last known state still lets the agent operate them.
 * Terminal states recorded by finish(), handOff() or a close are kept as they
 * are, so the user's Pages are never read. Never rejects; a space that cannot
 * be read in time reports `unknown(-)`.
 */
export async function refreshRoundStatus(
  timeoutMs = REFRESH_TIMEOUT_MS,
): Promise<void> {
  const pending = [...touched].filter(([spaceId, space]) => {
    const state = statuses.get(spaceId)?.state;
    return space.refresh && (state === undefined || state === "ready");
  });
  if (pending.length === 0) return;
  const deadline = Date.now() + timeoutMs;
  for (const [spaceId, space] of pending) {
    const remaining = deadline - Date.now();
    let status: RoundSpaceStatus = { state: "unknown", pages: null };
    if (remaining > 0) {
      status = await withTimeout(space.refresh!(), remaining).catch(
        () => status,
      );
    }
    statuses.set(spaceId, status);
  }
}

/** Whether a round-end refresh has anything to read. */
export function roundStatusNeedsRefresh(): boolean {
  return [...touched].some(([spaceId, space]) => {
    const state = statuses.get(spaceId)?.state;
    return space.refresh && (state === undefined || state === "ready");
  });
}

/**
 * Format the status line. Unhandled Page notices for listed spaces are folded
 * into the line (`p3 new from p1`); the rest are returned for the caller.
 */
export function formatRoundStatus(notices: UnhandledPageNotice[]): {
  line: string;
  remainingNotices: UnhandledPageNotice[];
} {
  if (touched.size === 0) return { line: "", remainingNotices: notices };
  const noticeByTarget = new Map(
    notices.map((notice) => [
      noticeKey(notice.spaceId, notice.targetId),
      notice,
    ]),
  );
  const folded = new Set<UnhandledPageNotice>();
  const parts = [...touched].map(([spaceId, space]) => {
    const status = statuses.get(spaceId) ?? { state: "unknown", pages: null };
    const pages =
      status.pages === null
        ? "-"
        : status.pages
            .map((page) => {
              const notice = noticeByTarget.get(
                noticeKey(spaceId, page.targetId),
              );
              if (notice) folded.add(notice);
              return `${page.label}${pageFlags(page, notice)}:${JSON.stringify(page.title)}`;
            })
            .join(",");
    return `${spaceId} ${JSON.stringify(space.name)} ${status.state}(${pages})`;
  });
  return {
    line: `[${parts.join(" | ")}]\n`,
    remainingNotices: notices.filter((notice) => !folded.has(notice)),
  };
}

/** Clear round state. Real runs get a new process; tests can reuse one. */
export function resetRoundStatus(): void {
  touched.clear();
  statuses.clear();
}

/** Ledger-label order: p2 before p10. */
export function sortPages(pages: RoundStatusPage[]): RoundStatusPage[] {
  return [...pages].sort((a, b) => labelNumber(a.label) - labelNumber(b.label));
}

function pageFlags(
  page: RoundStatusPage,
  notice: UnhandledPageNotice | undefined,
): string {
  let flags = "";
  if (page.openedBy !== "agent") flags += " user";
  if (notice) {
    flags += " new";
    if (notice.openerLabel) flags += ` from ${notice.openerLabel}`;
  }
  return flags;
}

function labelNumber(label: string): number {
  const match = /^p(\d+)$/.exec(label);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function noticeKey(spaceId: number, targetId: string): string {
  return `${spaceId}:${targetId}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The timer is deliberately not unref'd: on the SDK path it keeps the event
  // loop alive while `beforeExit` waits for the refresh.
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("round status timed out")),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
