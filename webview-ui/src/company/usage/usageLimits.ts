/**
 * usageLimits: the account limits the usage page shows, as display values.
 *
 * Nothing here reads the network or the DOM. A window that reports no usedFraction has no bar, so
 * it is never drawn as full or as empty.
 */

import type {
  QuotaCapacityRow,
  QuotaSnapshot,
  QuotaWindow,
  UsageHistoryEntry,
} from '../../../../core/src/messages.js';
import { formatCount, formatPercent, MISSING_TEXT } from './usageFormat.js';
import { capacityWindowName } from './usageLabels.js';
import { sortRows } from './usageStats.js';

/** The colour band of a bar: green below 70% used, amber from 70%, red from 90% or once exhausted. */
export type UsageBarTone = 'ok' | 'warn' | 'danger';

/** From this share of a window used, its bar turns amber. */
const WARN_FRACTION = 0.7;
/** From this share of a window used, its bar turns red. */
const DANGER_FRACTION = 0.9;

/** The band for a finite share of a window used. An exhausted window is red whatever its share. */
export function usageBarTone(fraction: number, exhausted = false): UsageBarTone {
  if (exhausted || fraction >= DANGER_FRACTION) return 'danger';
  if (fraction >= WARN_FRACTION) return 'warn';
  return 'ok';
}

/** The share of a limit used, or null when the window reports none (a balance-only window). */
export function windowShare(quotaWindow: QuotaWindow): number | null {
  const fraction = quotaWindow.usedFraction;
  return fraction !== undefined && Number.isFinite(fraction) ? fraction : null;
}

/** Whose limit the window is: the shared pool, or one model tier's own limit. */
export function windowScopeLabel(quotaWindow: QuotaWindow): string {
  const tier = quotaWindow.tier;
  if (quotaWindow.shared !== true && tier !== undefined && tier !== '') return `Riêng: ${tier}`;
  return 'Dùng chung';
}

/** A window's counts in its own unit, e.g. `3 / 6 credits`, `đã dùng 4 requests`, `còn 7 credits`. */
export function windowCountsText(quotaWindow: QuotaWindow): string {
  const unit = quotaWindow.reportedUnit.trim();
  // A percent window's share already reads as a percent, so its counts would only repeat it.
  if (unit.toLowerCase() === 'percent' || unit === '%') return '';
  const withUnit = (text: string): string => (unit === '' ? text : `${text} ${unit}`);
  const { used, limit, remaining } = quotaWindow;
  if (used !== undefined && limit !== undefined) {
    return withUnit(`${formatCount(used)} / ${formatCount(limit)}`);
  }
  if (used !== undefined) return withUnit(`đã dùng ${formatCount(used)}`);
  if (remaining !== undefined) return withUnit(`còn ${formatCount(remaining)}`);
  return '';
}

const SNAPSHOT_STATUS_LABELS: Record<QuotaSnapshot['status'], string> = {
  available: 'Sẵn sàng',
  unsupported: 'Không hỗ trợ',
  unauthenticated: 'Chưa đăng nhập',
  error: 'Lỗi',
  stale: 'Dữ liệu cũ',
};

export function snapshotStatusLabel(status: QuotaSnapshot['status']): string {
  return SNAPSHOT_STATUS_LABELS[status];
}

/** An account's title in the grid: its label, else its id, else its provider. */
export function accountTitle(snapshot: QuotaSnapshot): string {
  return snapshot.accountLabel ?? snapshot.accountId ?? snapshot.provider;
}

/** One account's snapshot with the key of its card. The key holds while the list order does. */
export interface AccountEntry {
  key: string;
  snapshot: QuotaSnapshot;
}

export function accountEntries(snapshots: readonly QuotaSnapshot[]): AccountEntry[] {
  return snapshots.map((snapshot, index) => ({
    key: JSON.stringify([snapshot.provider, snapshot.accountId ?? null, index]),
    snapshot,
  }));
}

/** Every provider the snapshots name, in the order each first appears. */
export function providerNames(snapshots: readonly QuotaSnapshot[]): string[] {
  return [...new Set(snapshots.map((snapshot) => snapshot.provider))];
}

/** An account with no limit windows: nothing to show in its card but its note. */
export function isEmptyAccount(snapshot: QuotaSnapshot): boolean {
  return snapshot.windows.length === 0;
}

/** The share used of the account's most used window; null when no window reports one. */
export function maxUsedFraction(snapshot: QuotaSnapshot): number | null {
  let max: number | null = null;
  for (const quotaWindow of snapshot.windows) {
    const fraction = quotaWindow.usedFraction;
    if (fraction !== undefined && Number.isFinite(fraction) && (max === null || fraction > max)) {
      max = fraction;
    }
  }
  return max;
}

/** The soonest reset still ahead of `nowMs` across the account's windows; null when none is ahead. */
export function nextResetMs(snapshot: QuotaSnapshot, nowMs: number): number | null {
  let next: number | null = null;
  for (const quotaWindow of snapshot.windows) {
    const resetMs =
      quotaWindow.resetAt === undefined ? Number.NaN : Date.parse(quotaWindow.resetAt);
    if (Number.isFinite(resetMs) && resetMs > nowMs && (next === null || resetMs < next)) {
      next = resetMs;
    }
  }
  return next;
}

/** `reset` lists the soonest upcoming reset first; `usage` lists the most used first. */
export type AccountSort = 'reset' | 'usage';

export interface ArrangeOptions {
  /** The one provider to show, or null for every provider. */
  provider: string | null;
  /** Whether accounts with no limit windows leave the grid. */
  hideEmpty: boolean;
  sort: AccountSort;
  /** The clock the reset order is read against. */
  nowMs: number;
}

export interface ArrangedAccounts {
  shown: AccountEntry[];
  /** The empty accounts the grid leaves out, so the page can still name them. */
  hidden: AccountEntry[];
}

/**
 * The accounts the grid shows: filtered to one provider, split into shown and hidden, and sorted.
 * Accounts with nothing to sort on come last, in their input order.
 */
export function arrangeAccounts(
  entries: readonly AccountEntry[],
  options: ArrangeOptions,
): ArrangedAccounts {
  const { provider, hideEmpty, sort, nowMs } = options;
  const inProvider = entries.filter(
    (entry) => provider === null || entry.snapshot.provider === provider,
  );
  const hidden = hideEmpty ? inProvider.filter((entry) => isEmptyAccount(entry.snapshot)) : [];
  const visible = hideEmpty
    ? inProvider.filter((entry) => !isEmptyAccount(entry.snapshot))
    : inProvider;
  const shown = sortRows(visible, sort, sort === 'reset' ? 'asc' : 'desc', (entry, key) =>
    key === 'reset' ? nextResetMs(entry.snapshot, nowMs) : maxUsedFraction(entry.snapshot),
  );
  return { shown, hidden };
}

/** A limit window with a share used, named with its account, for the page's near-limit strip. */
export interface NearLimit {
  key: string;
  provider: string;
  accountTitle: string;
  quotaWindow: QuotaWindow;
  usedFraction: number;
}

/** The windows nearest their limit across every account, most used first; at most `count`. */
export function nearLimitWindows(snapshots: readonly QuotaSnapshot[], count: number): NearLimit[] {
  const found: NearLimit[] = [];
  for (const entry of accountEntries(snapshots)) {
    for (const quotaWindow of entry.snapshot.windows) {
      const fraction = quotaWindow.usedFraction;
      if (fraction === undefined || !Number.isFinite(fraction)) continue;
      found.push({
        key: `${entry.key}|${quotaWindow.id}`,
        provider: entry.snapshot.provider,
        accountTitle: accountTitle(entry.snapshot),
        quotaWindow,
        usedFraction: fraction,
      });
    }
  }
  return found.sort((left, right) => right.usedFraction - left.usedFraction).slice(0, count);
}

/**
 * Whether a history entry records this window of this account. The account id decides when the
 * snapshot names one; otherwise the e-mail the snapshot is labelled with does.
 */
export function entryRecordsWindow(
  entry: UsageHistoryEntry,
  snapshot: QuotaSnapshot,
  windowId: string,
): boolean {
  if (entry.provider !== snapshot.provider || entry.limitId !== windowId) return false;
  if (snapshot.accountId !== undefined) return entry.accountId === snapshot.accountId;
  return snapshot.accountLabel !== undefined && entry.email === snapshot.accountLabel;
}

/** One capacity row as the page shows it. Account counts are counts; only the share is a percent. */
export interface CapacityLine {
  key: string;
  provider: string;
  /** The window's name, with its meter when the server names one. */
  title: string;
  /** e.g. `2 / 4 tài khoản đã dùng`. */
  usedText: string;
  /** e.g. `2 tài khoản còn lại`. */
  remainingText: string;
  /** Used accounts over all accounts, or null when no account is counted. */
  usedFraction: number | null;
  /** The share as text; a dash when usedFraction is null. */
  usedPercentText: string;
}

export function capacityLines(rows: readonly QuotaCapacityRow[]): CapacityLine[] {
  return rows.map((row) => {
    const usedFraction =
      Number.isFinite(row.accounts) && row.accounts > 0 ? row.usedAccounts / row.accounts : null;
    return {
      key: JSON.stringify([row.provider, row.window, row.meter ?? null, row.durationMs]),
      provider: row.provider,
      title: capacityWindowName(row),
      usedText: `${formatCount(row.usedAccounts)} / ${formatCount(row.accounts)} tài khoản đã dùng`,
      remainingText: `${formatCount(row.remainingAccounts)} tài khoản còn lại`,
      usedFraction,
      usedPercentText: usedFraction === null ? MISSING_TEXT : formatPercent(usedFraction),
    };
  });
}
