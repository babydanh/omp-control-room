import { describe, expect, it } from 'vitest';

import type { LedgerOverlapScan, LedgerPending } from '../../core/src/messages.js';
import {
  aheadLabel,
  behindLabel,
  dirtyLabel,
  fileName,
  formatClock,
  formatRelativeTime,
  LEDGER_MESSAGE_MAX_LENGTH,
  LEDGER_WINDOWS,
  ledgerMessageProblem,
  parseLedgerTimestamp,
  pendingFlags,
  scanLabel,
  shortSessionId,
} from '../src/company/ledger/ledgerFormat.js';

const NOW = '2026-10-18 10:30:00';

describe('parseLedgerTimestamp', () => {
  it('reads a ledger timestamp as local time and returns null for absent or unreadable input', () => {
    expect(parseLedgerTimestamp('2026-10-18 10:05:00')).toBe(Date.parse('2026-10-18T10:05:00'));
    expect(parseLedgerTimestamp(null)).toBeNull();
    expect(parseLedgerTimestamp('không phải ngày')).toBeNull();
  });
});

describe('formatClock', () => {
  it('shows local HH:MM with a leading zero', () => {
    expect(formatClock(Date.parse('2026-10-18T10:05:00'))).toBe('10:05');
  });
});

describe('formatRelativeTime', () => {
  it('says the age in Vietnamese against the reference time', () => {
    expect(formatRelativeTime('2026-10-18 10:29:30', NOW)).toBe('vừa xong');
    expect(formatRelativeTime('2026-10-18 10:00:00', NOW)).toBe('30 phút trước');
    expect(formatRelativeTime('2026-10-18 08:30:00', NOW)).toBe('2 giờ trước');
    expect(formatRelativeTime('2026-10-16 10:30:00', NOW)).toBe('2 ngày trước');
  });

  it('says chưa có when there is no timestamp', () => {
    expect(formatRelativeTime(null, NOW)).toBe('chưa có');
  });
});

describe('names and ids', () => {
  it('keeps the last eight characters of a session id', () => {
    expect(shortSessionId('abcdefghijkl')).toBe('efghijkl');
    expect(shortSessionId('abc')).toBe('abc');
  });

  it('reads the last path segment for both separators', () => {
    expect(fileName('D:\\Code\\omp-board')).toBe('omp-board');
    expect(fileName('D:/Code/omp-board/')).toBe('omp-board');
  });
});

describe('labels', () => {
  it('names a missing scan as not yet scanned, and a partial one as not finished', () => {
    expect(scanLabel(null)).toBe('Chưa quét');
    const partial: LedgerOverlapScan = {
      repo: 'D:/Code/app',
      state: 'partial',
      startedAt: null,
      finishedAt: null,
      base: 'main',
      lanes: 3,
      pairs: [],
      main: [],
      pending: ['feat-b'],
      complete: false,
      error: null,
    };
    expect(scanLabel(partial)).toBe('Chưa quét hết');
  });

  it('formats the commit, behind, and dirty counts', () => {
    expect(aheadLabel(3)).toBe('+3 commit chưa gộp');
    expect(behindLabel(2)).toBe('2 commit mới trên main');
    expect(dirtyLabel(4)).toBe('4 sửa');
  });

  it('lists the warning chips for a checkout with unfinished work', () => {
    const pending: LedgerPending = {
      checkout: 'D:/Code/app-feat',
      sessionId: null,
      branch: 'feat',
      dirty: 2,
      unpushed: 0,
      notInMain: 0,
      hasRemote: true,
      ts: NOW,
    };
    expect(pendingFlags(pending)).toContain('2 sửa chưa commit');
  });

  it('offers the four timeline windows, in minutes', () => {
    expect(LEDGER_WINDOWS).toEqual([15, 60, 360, 1440]);
  });
});

describe('ledgerMessageProblem', () => {
  it('rejects blank text and text over the limit, and accepts the rest', () => {
    expect(ledgerMessageProblem('')).toBe('Nhập nội dung trước khi gửi.');
    expect(ledgerMessageProblem('   ')).toBe('Nhập nội dung trước khi gửi.');
    expect(ledgerMessageProblem('xin chào')).toBeNull();
    expect(ledgerMessageProblem('a'.repeat(LEDGER_MESSAGE_MAX_LENGTH))).toBeNull();
    expect(ledgerMessageProblem('a'.repeat(LEDGER_MESSAGE_MAX_LENGTH + 1))).toBe(
      'Nội dung tối đa 4000 ký tự.',
    );
  });
});
