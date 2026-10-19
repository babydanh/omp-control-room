/**
 * usageLabels: the short names the usage page gives a limit window. A window is named by its span
 * (`5 giờ`, `7 ngày`) or, failing that, by its own label, and the provider's label is kept only
 * when it adds something: `5-hour limit · 5-hour` reads `5 giờ` once.
 *
 * Pure: no network, no DOM.
 */

import type { QuotaCapacityRow, QuotaWindow } from '../../../../core/src/messages.js';
import type { UsageHistoryDays } from './usageState.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A span as a short name, when it is a whole number of days, hours or minutes; null otherwise. */
export function spanName(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return null;
  if (ms % DAY_MS === 0) return `${ms / DAY_MS} ngày`;
  if (ms % HOUR_MS === 0) return `${ms / HOUR_MS} giờ`;
  if (ms % MINUTE_MS === 0) return `${ms / MINUTE_MS} phút`;
  return null;
}

// Unicode-aware boundaries: `\b` would not stop after a Vietnamese letter such as `ờ`.
const HOURS = /(?<![\p{L}\d])(\d+)\s*-?\s*(?:hours?|hrs?|h|giờ)(?![\p{L}])/iu;
const DAYS = /(?<![\p{L}\d])(\d+)\s*-?\s*(?:days?|d|ngày)(?![\p{L}])/iu;
const MINUTES = /(?<![\p{L}\d])(\d+)\s*-?\s*(?:minutes?|mins?|phút)(?![\p{L}])/iu;
const WEEKLY = /(?<![\p{L}])(?:weekly|week|tuần)(?![\p{L}])/iu;
const DAILY = /(?<![\p{L}])daily(?![\p{L}])/iu;

/** The span a piece of label text names, such as `5-hour` or `7 Day`; null when it names none. */
export function spanNameFromText(text: string): string | null {
  const hours = HOURS.exec(text);
  if (hours !== null) return `${Number(hours[1])} giờ`;
  const days = DAYS.exec(text);
  if (days !== null) return `${Number(days[1])} ngày`;
  const minutes = MINUTES.exec(text);
  if (minutes !== null) return `${Number(minutes[1])} phút`;
  if (WEEKLY.test(text)) return 'Tuần';
  if (DAILY.test(text)) return 'Ngày';
  return null;
}

/** A model tier as a name: `fable` reads `Fable`. */
export function tierName(tier: string): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

/** `base` with the model tier after it, unless the base already names that tier. */
function withTier(base: string, tier: string): string {
  const name = tierName(tier.trim());
  if (name === '' || base.toLowerCase().includes(name.toLowerCase())) return base;
  return `${base} · ${name}`;
}

/**
 * A window's own name, without its model tier: its span when one is known, else its label with
 * each distinct part shown once.
 */
export function windowSpanName(
  quotaWindow: Pick<QuotaWindow, 'id' | 'label' | 'windowLabel' | 'durationMs'>,
): string {
  const span =
    spanName(quotaWindow.durationMs) ??
    spanNameFromText([quotaWindow.label, quotaWindow.windowLabel ?? '', quotaWindow.id].join(' '));
  if (span !== null) return span;
  const parts = [quotaWindow.label, quotaWindow.windowLabel ?? ''].map((part) => part.trim());
  const distinct = parts.filter(
    (part, index) =>
      part !== '' &&
      parts.findIndex((other) => other.toLowerCase() === part.toLowerCase()) === index,
  );
  return distinct.length > 0 ? distinct.join(' · ') : quotaWindow.id;
}

/** A window's full name: its span, then its model tier when the window is one model's own limit. */
export function windowName(
  quotaWindow: Pick<QuotaWindow, 'id' | 'label' | 'windowLabel' | 'durationMs' | 'shared' | 'tier'>,
): string {
  const base = windowSpanName(quotaWindow);
  if (quotaWindow.shared === true || quotaWindow.tier === undefined) return base;
  return withTier(base, quotaWindow.tier);
}

/** A capacity row's window as a name: its span, else its window text, with its meter as the tier. */
export function capacityWindowName(
  row: Pick<QuotaCapacityRow, 'window' | 'durationMs' | 'meter'>,
): string {
  const base =
    spanName(row.durationMs) ?? spanNameFromText(row.window) ?? (row.window.trim() || 'Cửa sổ');
  return row.meter === undefined ? base : withTier(base, row.meter);
}

/** The day window labels of the usage page's history toggle. */
export const HISTORY_DAY_LABELS: Record<UsageHistoryDays, string> = {
  1: '1 ngày',
  7: '7 ngày',
  30: '30 ngày',
};
