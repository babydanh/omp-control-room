import { describe, expect, it } from 'vitest';

import { ledgerBasename, ledgerPathKey, normalizeLedgerPath } from '../src/ledger/ledgerPath.js';
import { formatLedgerTime, newestFirst, parseLedgerTime } from '../src/ledger/ledgerTime.js';

describe('normalizeLedgerPath', () => {
  it('uses forward slashes and drops trailing slashes', () => {
    expect(normalizeLedgerPath('C:\\Repo\\WT-A\\')).toBe('C:/Repo/WT-A');
    expect(normalizeLedgerPath('C:/Repo/wt///')).toBe('C:/Repo/wt');
  });

  it('keeps the slash on a drive root', () => {
    expect(normalizeLedgerPath('C:\\')).toBe('C:/');
  });

  it('keeps a POSIX root as a slash', () => {
    expect(normalizeLedgerPath('/')).toBe('/');
  });

  it('leaves an empty string empty', () => {
    expect(normalizeLedgerPath('')).toBe('');
  });
});

describe('ledgerPathKey', () => {
  it('matches case-insensitively across separator and slash variants', () => {
    expect(ledgerPathKey('C:\\Repo\\WT/')).toBe(ledgerPathKey('c:/repo/wt'));
    expect(ledgerPathKey('C:/Repo/WT')).toBe('c:/repo/wt');
  });
});

describe('ledgerBasename', () => {
  it('returns the last segment of a normalised path', () => {
    expect(ledgerBasename('C:\\Repo\\wt\\')).toBe('wt');
    expect(ledgerBasename('C:/Repo')).toBe('Repo');
  });
});

describe('parseLedgerTime', () => {
  it('reads a local ledger timestamp', () => {
    expect(parseLedgerTime('2026-04-10 12:00:00')).toBe(new Date(2026, 3, 10, 12, 0, 0).getTime());
  });

  it('rejects malformed text, out-of-range dates, and missing values', () => {
    for (const text of [
      '2026-04-10T12:00:00',
      '2026-02-30 00:00:00',
      'not a time',
      null,
      undefined,
    ]) {
      expect(parseLedgerTime(text)).toBeNull();
    }
  });
});

describe('formatLedgerTime', () => {
  it('formats an epoch value as a local ledger timestamp', () => {
    expect(formatLedgerTime(new Date(2026, 3, 10, 9, 5, 7).getTime())).toBe('2026-04-10 09:05:07');
  });

  it('round-trips through parseLedgerTime', () => {
    const text = '2026-12-31 23:59:58';
    expect(formatLedgerTime(parseLedgerTime(text) ?? Number.NaN)).toBe(text);
  });
});

describe('newestFirst', () => {
  it('orders by timestamp, then by row id, without mutating its input', () => {
    const rows = [
      { ts: '2026-04-10 10:00:00', id: 1 },
      { ts: '2026-04-10 11:00:00', id: 2 },
      { ts: '2026-04-10 11:00:00', id: 3 },
    ];
    expect(newestFirst(rows).map((row) => row.id)).toEqual([3, 2, 1]);
    expect(rows.map((row) => row.id)).toEqual([1, 2, 3]);
  });
});
