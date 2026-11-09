/**
 * Round-local Page discovery shared by action receipts, popup waiters, URL
 * diagnostics, and the final unhandled-Page summary.
 */
export type UnhandledPageNotice = {
  spaceId: number;
  targetId: string;
  label: string;
  openerLabel?: string;
  url?: string;
};

type PageNoticeListener = (notice: UnhandledPageNotice) => void;

const pendingPageNotices = new Map<string, UnhandledPageNotice>();
const observedPages = new Set<string>();
const pageNoticeListeners = new Set<PageNoticeListener>();

/** Record or refresh one discovered Page that Agent code has not used yet. */
export function recordUnhandledPage(notice: UnhandledPageNotice): void {
  const key = pageKey(notice.spaceId, notice.targetId);
  if (observedPages.has(key)) return;
  const merged = {
    ...pendingPageNotices.get(key),
    ...notice,
  };
  pendingPageNotices.set(key, merged);
  for (const listener of [...pageNoticeListeners]) listener(merged);
}

/** Refresh the URL of an already-discovered Page without creating a new notice. */
export function refreshUnhandledPageNotice(
  spaceId: number,
  targetId: string,
  url: string,
): void {
  const key = pageKey(spaceId, targetId);
  const existing = pendingPageNotices.get(key);
  if (!existing) return;
  recordUnhandledPage({ ...existing, url });
}

/** Mark a Page as used during this round so it needs no further guidance. */
export function markPageObserved(spaceId: number, targetId: string): void {
  const key = pageKey(spaceId, targetId);
  observedPages.add(key);
  pendingPageNotices.delete(key);
}

/** Remove round state for a Page that no longer exists. */
export function forgetPageNotice(spaceId: number, targetId: string): void {
  const key = pageKey(spaceId, targetId);
  pendingPageNotices.delete(key);
  observedPages.delete(key);
}

/** Remove pending Page state when its task space reaches a terminal state. */
export function clearSpacePageNotices(spaceId: number): void {
  const prefix = `${spaceId}:`;
  for (const key of pendingPageNotices.keys()) {
    if (key.startsWith(prefix)) pendingPageNotices.delete(key);
  }
  for (const key of observedPages) {
    if (key.startsWith(prefix)) observedPages.delete(key);
  }
}

/** Read pending Page notices without consuming the round summary. */
export function peekUnhandledPageNotices(): UnhandledPageNotice[] {
  return [...pendingPageNotices.values()].map((notice) => ({ ...notice }));
}

/** Observe future Page discoveries. The caller owns the returned unsubscribe. */
export function subscribeUnhandledPageNotices(
  listener: PageNoticeListener,
): () => void {
  pageNoticeListeners.add(listener);
  return () => pageNoticeListeners.delete(listener);
}

/** Drain Page notices once when round output is flushed. */
export function consumeUnhandledPageNotices(): UnhandledPageNotice[] {
  const notices = peekUnhandledPageNotices();
  pendingPageNotices.clear();
  return notices;
}

/** Clear round state. Real runs get a new process; tests can reuse one process. */
export function resetPageNotices(): void {
  pendingPageNotices.clear();
  observedPages.clear();
  pageNoticeListeners.clear();
}

function pageKey(spaceId: number, targetId: string): string {
  return `${spaceId}:${targetId}`;
}
