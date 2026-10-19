import { describe, expect, it } from 'vitest';

import type {
  QuotaCapacityRow,
  QuotaSnapshot,
  QuotaWindow,
  UsageHistoryEntry,
} from '../../core/src/messages.js';
import {
  accountEntries,
  accountTitle,
  arrangeAccounts,
  capacityLines,
  entryRecordsWindow,
  maxUsedFraction,
  nearLimitWindows,
  nextResetMs,
  providerNames,
  snapshotStatusLabel,
  usageBarTone,
  windowCountsText,
  windowScopeLabel,
} from '../src/company/usage/usageLimits.js';

const HOUR = 60 * 60_000;
const NOW = Date.parse('2026-10-19T12:00:00Z');

function window(overrides: Partial<QuotaWindow> = {}): QuotaWindow {
  return { id: 'w', label: '5 giờ', reportedUnit: 'requests', ...overrides };
}

function snapshot(overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return {
    provider: 'anthropic',
    windows: [],
    fetchedAt: '2026-10-19T11:59:00Z',
    status: 'available',
    ...overrides,
  };
}

function capacityRow(overrides: Partial<QuotaCapacityRow> = {}): QuotaCapacityRow {
  return {
    provider: 'anthropic',
    window: '5 hours',
    durationMs: 5 * HOUR,
    accounts: 4,
    usedAccounts: 2,
    remainingAccounts: 2,
    ...overrides,
  };
}

function historyEntry(overrides: Partial<UsageHistoryEntry> = {}): UsageHistoryEntry {
  return {
    recordedAt: '2026-10-19T11:00:00Z',
    provider: 'anthropic',
    accountKey: 'anthropic:a1',
    accountId: 'a1',
    limitId: 'w',
    label: '5 giờ',
    ...overrides,
  };
}

function resetIn(hours: number): string {
  return new Date(NOW + hours * HOUR).toISOString();
}

describe('usageBarTone', () => {
  it('reads a share below 70% as ok', () => {
    expect(usageBarTone(0)).toBe('ok');
    expect(usageBarTone(0.69)).toBe('ok');
  });

  it('reads a share from 70% up to 90% as warn', () => {
    expect(usageBarTone(0.7)).toBe('warn');
    expect(usageBarTone(0.89)).toBe('warn');
  });

  it('reads a share from 90% up, overuse included, as danger', () => {
    expect(usageBarTone(0.9)).toBe('danger');
    expect(usageBarTone(1.2)).toBe('danger');
  });

  it('reads an exhausted window as danger whatever its share', () => {
    expect(usageBarTone(0.1, true)).toBe('danger');
  });
});

describe('windowScopeLabel', () => {
  it('names a window shared across models as shared', () => {
    expect(windowScopeLabel(window({ shared: true, tier: 'fable' }))).toBe('Dùng chung');
    expect(windowScopeLabel(window())).toBe('Dùng chung');
  });

  it("names one model tier's own window with the tier", () => {
    expect(windowScopeLabel(window({ shared: false, tier: 'fable' }))).toBe('Riêng: fable');
  });
});

describe('windowCountsText', () => {
  it('shows used of limit in the window unit', () => {
    expect(windowCountsText(window({ reportedUnit: 'credits', used: 3, limit: 6 }))).toBe(
      '3 / 6 credits',
    );
  });

  it('shows used alone, or remaining alone', () => {
    expect(windowCountsText(window({ reportedUnit: 'requests', used: 4 }))).toBe(
      'đã dùng 4 requests',
    );
    expect(windowCountsText(window({ reportedUnit: 'credits', remaining: 7 }))).toBe(
      'còn 7 credits',
    );
  });

  it('shows no counts for a percent window, whose share already reads as a percent', () => {
    expect(windowCountsText(window({ reportedUnit: 'percent', used: 40, limit: 100 }))).toBe('');
  });

  it('shows nothing when no count is reported', () => {
    expect(windowCountsText(window({ reportedUnit: 'requests' }))).toBe('');
  });
});

describe('snapshotStatusLabel', () => {
  it('names each status in Vietnamese', () => {
    expect(snapshotStatusLabel('available')).toBe('Sẵn sàng');
    expect(snapshotStatusLabel('unauthenticated')).toBe('Chưa đăng nhập');
    expect(snapshotStatusLabel('stale')).toBe('Dữ liệu cũ');
  });
});

describe('accountTitle', () => {
  it('uses the label, then the id, then the provider', () => {
    expect(accountTitle(snapshot({ accountLabel: 'an@example.com', accountId: 'a1' }))).toBe(
      'an@example.com',
    );
    expect(accountTitle(snapshot({ accountId: 'a1' }))).toBe('a1');
    expect(accountTitle(snapshot())).toBe('anthropic');
  });
});

describe('providerNames', () => {
  it('lists each provider once, in the order it first appears', () => {
    expect(
      providerNames([
        snapshot({ provider: 'anthropic' }),
        snapshot({ provider: 'openai' }),
        snapshot({ provider: 'anthropic' }),
      ]),
    ).toEqual(['anthropic', 'openai']);
  });
});

describe('maxUsedFraction', () => {
  it('is the largest finite share among the windows', () => {
    expect(
      maxUsedFraction(
        snapshot({
          windows: [window({ usedFraction: 0.4 }), window({ usedFraction: 0.9 }), window()],
        }),
      ),
    ).toBe(0.9);
  });

  it('is null when no window reports a share, never zero', () => {
    expect(maxUsedFraction(snapshot({ windows: [window()] }))).toBeNull();
  });
});

describe('nextResetMs', () => {
  it('is the soonest reset still ahead', () => {
    const next = nextResetMs(
      snapshot({
        windows: [window({ resetAt: resetIn(5) }), window({ resetAt: resetIn(1) })],
      }),
      NOW,
    );
    expect(next).toBe(NOW + HOUR);
  });

  it('ignores resets already passed or not given', () => {
    expect(
      nextResetMs(snapshot({ windows: [window({ resetAt: resetIn(-1) }), window()] }), NOW),
    ).toBeNull();
  });
});

describe('arrangeAccounts', () => {
  const soon = snapshot({
    accountId: 'soon',
    windows: [window({ resetAt: resetIn(1), usedFraction: 0.2 })],
  });
  const busy = snapshot({
    accountId: 'busy',
    windows: [window({ resetAt: resetIn(5), usedFraction: 0.95 })],
  });
  const other = snapshot({
    provider: 'openai',
    accountId: 'other',
    windows: [window({ resetAt: resetIn(0.5), usedFraction: 0.5 })],
  });
  const empty = snapshot({ accountId: 'empty', status: 'unauthenticated' });
  const entries = accountEntries([busy, empty, soon, other]);

  function ids(accounts: { snapshot: QuotaSnapshot }[]): (string | undefined)[] {
    return accounts.map((account) => account.snapshot.accountId);
  }

  it('shows accounts with windows, the soonest reset first, and leaves empty ones hidden', () => {
    const { shown, hidden } = arrangeAccounts(entries, {
      provider: null,
      hideEmpty: true,
      sort: 'reset',
      nowMs: NOW,
    });
    expect(ids(shown)).toEqual(['other', 'soon', 'busy']);
    expect(ids(hidden)).toEqual(['empty']);
  });

  it('orders by the most used window first when asked', () => {
    const { shown } = arrangeAccounts(entries, {
      provider: null,
      hideEmpty: true,
      sort: 'usage',
      nowMs: NOW,
    });
    expect(ids(shown)).toEqual(['busy', 'other', 'soon']);
  });

  it('keeps empty accounts in the grid, last, when they are not hidden', () => {
    const { shown, hidden } = arrangeAccounts(entries, {
      provider: null,
      hideEmpty: false,
      sort: 'reset',
      nowMs: NOW,
    });
    expect(ids(shown)).toEqual(['other', 'soon', 'busy', 'empty']);
    expect(hidden).toEqual([]);
  });

  it('keeps only the chosen provider', () => {
    const { shown, hidden } = arrangeAccounts(entries, {
      provider: 'openai',
      hideEmpty: true,
      sort: 'reset',
      nowMs: NOW,
    });
    expect(ids(shown)).toEqual(['other']);
    expect(hidden).toEqual([]);
  });
});

describe('nearLimitWindows', () => {
  const snapshots = [
    snapshot({
      accountLabel: 'Tài khoản A',
      windows: [window({ id: 'a1', usedFraction: 0.4 }), window({ id: 'a2', usedFraction: 0.95 })],
    }),
    snapshot({
      provider: 'openai',
      accountId: 'b',
      windows: [window({ id: 'b1', usedFraction: 0.8 }), window({ id: 'b2' })],
    }),
  ];

  it('lists the windows nearest their limit first, across accounts, up to the count', () => {
    const result = nearLimitWindows(snapshots, 2);
    expect(result.map((item) => item.quotaWindow.id)).toEqual(['a2', 'b1']);
    expect(result[0]?.accountTitle).toBe('Tài khoản A');
    expect(result[1]?.provider).toBe('openai');
  });

  it('skips windows that report no share', () => {
    expect(nearLimitWindows(snapshots, 10).map((item) => item.quotaWindow.id)).toEqual([
      'a2',
      'b1',
      'a1',
    ]);
  });
});

describe('entryRecordsWindow', () => {
  const account = snapshot({ accountId: 'a1' });

  it('matches the account id, provider and window', () => {
    expect(entryRecordsWindow(historyEntry(), account, 'w')).toBe(true);
  });

  it('rejects another account, provider or window', () => {
    expect(entryRecordsWindow(historyEntry({ accountId: 'a2' }), account, 'w')).toBe(false);
    expect(entryRecordsWindow(historyEntry({ provider: 'openai' }), account, 'w')).toBe(false);
    expect(entryRecordsWindow(historyEntry(), account, 'other')).toBe(false);
  });

  it('matches on the e-mail label when the snapshot names no account id', () => {
    const labelled = snapshot({ accountLabel: 'an@example.com' });
    expect(entryRecordsWindow(historyEntry({ email: 'an@example.com' }), labelled, 'w')).toBe(true);
  });
});

describe('capacityLines', () => {
  it('names each row by its span and meter, and counts its accounts', () => {
    const [line] = capacityLines([capacityRow({ meter: 'fable' })]);
    expect(line?.title).toBe('5 giờ · Fable');
    expect(line?.usedText).toBe('2 / 4 tài khoản đã dùng');
    expect(line?.remainingText).toBe('2 tài khoản còn lại');
    expect(line?.usedFraction).toBe(0.5);
    expect(line?.usedPercentText).toBe('50%');
  });

  it('shows a dash, never zero, when no account is counted', () => {
    const [line] = capacityLines([
      capacityRow({ accounts: 0, usedAccounts: 0, remainingAccounts: 0 }),
    ]);
    expect(line?.usedFraction).toBeNull();
    expect(line?.usedPercentText).toBe('—');
  });
});
