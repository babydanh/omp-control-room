/**
 * usageTime: the usage page's dates. A sample reads in the reader's local time, day and month
 * first, as Vietnamese writes it.
 */

/** A sample's day, month and time, e.g. `19/10 14:05`. */
export const WHEN_FORMAT = new Intl.DateTimeFormat('vi-VN', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/** Epoch milliseconds of an ISO time, or null when it is absent or unreadable. */
export function parseTime(iso: string | null | undefined): number | null {
  if (iso === undefined || iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}
