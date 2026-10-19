/**
 * usageLimits: the account limits the usage page shows, as display values.
 *
 * Nothing here reads the network or the DOM. A window that reports no usedFraction is `unknown`,
 * never full and never empty.
 */

import type {
  QuotaCapacityRow,
  QuotaSnapshot,
  QuotaWindow,
} from '../../../../core/src/messages.js';
import { formatCount, formatDuration, formatPercent, MISSING_TEXT } from './usageFormat.js';

export type WindowTone = 'ok' | 'warn' | 'danger' | 'unknown';

/** From this share of a window used, the window reads as close to its limit. */
const WARN_FRACTION = 0.8;
/** At this share of a window used, the window is exhausted. */
const DANGER_FRACTION = 1;

/** How alarming a window is: danger from a full window or an `exhausted` status, warn from a `warning` one. */
export function windowTone(window: QuotaWindow): WindowTone {
  const fraction = window.usedFraction;
  if (window.status === 'exhausted' || (fraction !== undefined && fraction >= DANGER_FRACTION)) {
    return 'danger';
  }
  if (window.status === 'warning' || (fraction !== undefined && fraction >= WARN_FRACTION)) {
    return 'warn';
  }
  if (fraction !== undefined && Number.isFinite(fraction)) return 'ok';
  return 'unknown';
}

/** Whose limit the window is: the shared pool, or one model tier's own limit. */
export function windowScopeLabel(window: QuotaWindow): string {
  const tier = window.tier;
  if (window.shared !== true && tier !== undefined && tier !== '') return `Riêng: ${tier}`;
  return 'Dùng chung';
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

/** One account's snapshot inside its provider. `key` is the accountId, or `#<index>` when the snapshot names none. */
export interface UsageAccountEntry {
  key: string;
  snapshot: QuotaSnapshot;
}

export interface UsageProviderGroup {
  provider: string;
  accounts: UsageAccountEntry[];
}

/** Groups snapshots by provider, in the order each provider first appears, then keeps each account in input order. */
export function groupSnapshots(snapshots: readonly QuotaSnapshot[]): UsageProviderGroup[] {
  const groups = new Map<string, UsageAccountEntry[]>();
  snapshots.forEach((snapshot, index) => {
    const entry: UsageAccountEntry = { key: snapshot.accountId ?? `#${index}`, snapshot };
    const accounts = groups.get(snapshot.provider);
    if (accounts === undefined) groups.set(snapshot.provider, [entry]);
    else accounts.push(entry);
  });
  return [...groups].map(([provider, accounts]) => ({ provider, accounts }));
}

/** One capacity row as the page shows it. Account counts are counts; only the share is a percent. */
export interface CapacityLine {
  key: string;
  provider: string;
  /** The window, followed by its meter when the server names one. */
  title: string;
  /** How long the window lasts, e.g. `5 giờ`. */
  durationText: string;
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
      title:
        row.meter === undefined || row.meter === '' ? row.window : `${row.window} · ${row.meter}`,
      durationText: formatDuration(row.durationMs),
      usedText: `${formatCount(row.usedAccounts)} / ${formatCount(row.accounts)} tài khoản đã dùng`,
      remainingText: `${formatCount(row.remainingAccounts)} tài khoản còn lại`,
      usedFraction,
      usedPercentText: usedFraction === null ? MISSING_TEXT : formatPercent(usedFraction),
    };
  });
}
