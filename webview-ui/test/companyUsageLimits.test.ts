import { describe, expect, it } from 'vitest';

import type { QuotaCapacityRow, QuotaSnapshot, QuotaWindow } from '../../core/src/messages.js';
import {
  capacityLines,
  groupSnapshots,
  snapshotStatusLabel,
  windowScopeLabel,
  windowTone,
} from '../src/company/usage/usageLimits.js';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

function window(overrides: Partial<QuotaWindow> = {}): QuotaWindow {
  return { id: 'w', label: '5 giờ', reportedUnit: 'requests', ...overrides };
}

function snapshot(overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return {
    provider: 'anthropic',
    windows: [],
    fetchedAt: '2026-10-19T00:00:00.000Z',
    status: 'available',
    ...overrides,
  };
}

function capacityRow(overrides: Partial<QuotaCapacityRow> = {}): QuotaCapacityRow {
  return {
    provider: 'anthropic',
    window: '5h',
    durationMs: 5 * HOUR,
    accounts: 4,
    usedAccounts: 2,
    remainingAccounts: 2,
    ...overrides,
  };
}

describe('windowTone', () => {
  it('reads a full or exhausted window as danger', () => {
    expect(windowTone(window({ usedFraction: 1 }))).toBe('danger');
    expect(windowTone(window({ status: 'exhausted', usedFraction: 0.1 }))).toBe('danger');
    expect(windowTone(window({ status: 'exhausted' }))).toBe('danger');
  });

  it('reads a window at or past 80% used, or a warning status, as warn', () => {
    expect(windowTone(window({ usedFraction: 0.95 }))).toBe('warn');
    expect(windowTone(window({ usedFraction: 0.8 }))).toBe('warn');
    expect(windowTone(window({ status: 'warning', usedFraction: 0.1 }))).toBe('warn');
  });

  it('reads a window with a known share below 80% as ok', () => {
    expect(windowTone(window({ usedFraction: 0.5 }))).toBe('ok');
    expect(windowTone(window({ usedFraction: 0 }))).toBe('ok');
  });

  it('reads a window with no usable share as unknown, never full or empty', () => {
    expect(windowTone(window({}))).toBe('unknown');
    expect(windowTone(window({ usedFraction: Number.NaN }))).toBe('unknown');
  });
});

describe('windowScopeLabel', () => {
  it('names a model tier its own limit', () => {
    expect(windowScopeLabel(window({ tier: 'opus' }))).toBe('Riêng: opus');
  });

  it('reads a shared window as shared, even when it names a tier', () => {
    expect(windowScopeLabel(window({ tier: 'opus', shared: true }))).toBe('Dùng chung');
  });

  it('reads a window with no tier, or an empty tier, as shared', () => {
    expect(windowScopeLabel(window({}))).toBe('Dùng chung');
    expect(windowScopeLabel(window({ tier: '' }))).toBe('Dùng chung');
  });
});

describe('snapshotStatusLabel', () => {
  it('labels every snapshot status in Vietnamese', () => {
    expect(snapshotStatusLabel('available')).toBe('Sẵn sàng');
    expect(snapshotStatusLabel('unsupported')).toBe('Không hỗ trợ');
    expect(snapshotStatusLabel('unauthenticated')).toBe('Chưa đăng nhập');
    expect(snapshotStatusLabel('error')).toBe('Lỗi');
    expect(snapshotStatusLabel('stale')).toBe('Dữ liệu cũ');
  });
});

describe('groupSnapshots', () => {
  it('groups by provider in first-seen order and keeps each account in input order', () => {
    const groups = groupSnapshots([
      snapshot({ provider: 'anthropic', accountId: 'a1' }),
      snapshot({ provider: 'openai' }),
      snapshot({ provider: 'anthropic', accountId: 'a2' }),
      snapshot({ provider: 'openai', accountId: 'o2' }),
    ]);
    expect(groups.map((group) => group.provider)).toEqual(['anthropic', 'openai']);
    expect(groups[0].accounts.map((account) => account.key)).toEqual(['a1', 'a2']);
    expect(groups[1].accounts.map((account) => account.key)).toEqual(['#1', 'o2']);
  });

  it('keeps the snapshot itself on its account entry', () => {
    const only = snapshot({ provider: 'openai', accountId: 'o1', note: 'ghi chú' });
    const groups = groupSnapshots([only]);
    expect(groups[0].accounts[0].snapshot).toBe(only);
  });

  it('returns no groups for no snapshots', () => {
    expect(groupSnapshots([])).toEqual([]);
  });
});

describe('capacityLines', () => {
  it('shows counts as counts and only the share as a percent', () => {
    const [line] = capacityLines([capacityRow({ meter: 'opus' })]);
    expect(line.title).toBe('5h · opus');
    expect(line.durationText).toBe('5 giờ');
    expect(line.usedText).toBe('2 / 4 tài khoản đã dùng');
    expect(line.remainingText).toBe('2 tài khoản còn lại');
    expect(line.usedFraction).toBe(0.5);
    expect(line.usedPercentText).toBe('50%');
  });

  it('uses the window alone as the title when no meter is named', () => {
    const [line] = capacityLines([capacityRow({ window: 'week', durationMs: 7 * DAY })]);
    expect(line.title).toBe('week');
    expect(line.durationText).toBe('7 ngày');
  });

  it('reads a row with no accounts as unknown, never as zero used', () => {
    const [line] = capacityLines([
      capacityRow({ accounts: 0, usedAccounts: 0, remainingAccounts: 0 }),
    ]);
    expect(line.usedFraction).toBeNull();
    expect(line.usedPercentText).toBe('—');
    expect(line.usedText).toBe('0 / 0 tài khoản đã dùng');
  });

  it('gives rows that differ only by meter distinct keys', () => {
    const [opus, sonnet] = capacityLines([
      capacityRow({ meter: 'opus' }),
      capacityRow({ meter: 'sonnet' }),
    ]);
    expect(opus.key).not.toBe(sonnet.key);
  });

  it('returns no lines for no rows', () => {
    expect(capacityLines([])).toEqual([]);
  });
});
