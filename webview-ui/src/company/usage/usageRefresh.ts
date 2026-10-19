/**
 * usageRefresh: how often the usage page re-reads its data while it is open and visible.
 *
 * Nothing polls. The page asks again only when a refresh is due and the document is visible.
 */

/** Limits refresh every two minutes while the page is open and visible. */
export const USAGE_LIMITS_REFRESH_MS = 120_000;

/** History and stats refresh every ten minutes while the page is open and visible. */
export const USAGE_STATS_REFRESH_MS = 600_000;

/**
 * Whether a refresh is due. A hidden page is never due. A page that has never loaded is always due.
 * Otherwise the interval must have passed since the last load.
 */
export function isRefreshDue(
  lastAt: number | null,
  intervalMs: number,
  nowMs: number,
  visible: boolean,
): boolean {
  if (!visible) return false;
  if (lastAt === null) return true;
  return nowMs - lastAt >= intervalMs;
}

/**
 * When a report next falls due: its interval after the last request, or now when it was never
 * asked for, so the first due check sends it at once.
 */
export function nextRefreshDueAt(lastAt: number | null, intervalMs: number, nowMs: number): number {
  return lastAt === null ? nowMs : lastAt + intervalMs;
}
