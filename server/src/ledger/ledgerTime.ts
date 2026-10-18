/**
 * Ledger timestamps: the local `YYYY-MM-DD HH:MM:SS` text the activity ledger
 * writes. Pure: parsing and formatting only, no clock reads.
 */

const LEDGER_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/** Epoch ms for a ledger timestamp read as local time; null when malformed. */
export function parseLedgerTime(text: string | null | undefined): number | null {
  if (typeof text !== 'string') return null;
  const match = LEDGER_TIME_PATTERN.exec(text);
  if (match === null) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const date = new Date(year, month - 1, day, hour, minute, second);
  // Date rolls out-of-range fields over (Feb 30 becomes Mar 2); reject instead of guessing.
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== second
  ) {
    return null;
  }
  return date.getTime();
}

/** Local `YYYY-MM-DD HH:MM:SS` for an epoch ms value. */
export function formatLedgerTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** Copy of `rows` ordered newest first: by timestamp text, then by row id. */
export function newestFirst<T extends { readonly ts: string; readonly id: number }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort((a, b) => {
    if (a.ts !== b.ts) return a.ts < b.ts ? 1 : -1;
    return b.id - a.id;
  });
}
