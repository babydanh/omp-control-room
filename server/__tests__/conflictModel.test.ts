import { describe, expect, it } from 'vitest';

import type {
  LedgerOverlapConflict,
  LedgerOverlapPair,
  LedgerOverlapScan,
} from '../../core/src/messages.js';
import {
  type ConflictCheckout,
  conflictsFor,
  describeConflicts,
} from '../src/company/workItems/conflictModel.js';

const hunk: LedgerOverlapConflict = { file: 'src/app.ts', hunks: [] };

function pair(
  a: string,
  b: string,
  conflicts: LedgerOverlapConflict[] = [hunk],
): LedgerOverlapPair {
  return { a, b, aLabel: 'lane a', bLabel: 'lane b', conflicts, auto: [] };
}

function scan(overrides: Partial<LedgerOverlapScan>): LedgerOverlapScan {
  return {
    repo: '/repo',
    state: 'done',
    startedAt: null,
    finishedAt: null,
    base: null,
    lanes: 2,
    pairs: [],
    main: [],
    pending: [],
    complete: true,
    error: null,
    ...overrides,
  };
}

const A = '/repo/.worktrees/squad-a';
const B = '/repo/.worktrees/squad-b';

describe('conflictsFor', () => {
  it('links two items whose checkouts overlap, in both directions', () => {
    const checkouts: ConflictCheckout[] = [
      { sequence: 1, checkout: A },
      { sequence: 2, checkout: B },
    ];
    const reports = conflictsFor([scan({ pairs: [pair(A, B)] })], checkouts);
    expect(reports.get(1)).toEqual({ sequences: [2], main: false });
    expect(reports.get(2)).toEqual({ sequences: [1], main: false });
  });

  it('ignores a pair that reports no conflicting hunks', () => {
    const checkouts: ConflictCheckout[] = [
      { sequence: 1, checkout: A },
      { sequence: 2, checkout: B },
    ];
    expect(conflictsFor([scan({ pairs: [pair(A, B, [])] })], checkouts).size).toBe(0);
  });

  it('matches checkouts across slashes and letter case', () => {
    const checkouts: ConflictCheckout[] = [
      { sequence: 1, checkout: 'V:\\repo\\.worktrees\\Squad-A' },
      { sequence: 2, checkout: B },
    ];
    const reports = conflictsFor(
      [scan({ pairs: [pair('V:/repo/.worktrees/squad-a', B)] })],
      checkouts,
    );
    expect(reports.get(1)?.sequences).toEqual([2]);
  });

  it('marks an item whose checkout overlaps the main checkout', () => {
    const checkouts: ConflictCheckout[] = [{ sequence: 3, checkout: '/repo' }];
    const main = [{ lane: '/repo', label: 'main', conflicts: [hunk] }];
    expect(conflictsFor([scan({ main })], checkouts).get(3)).toEqual({
      sequences: [],
      main: true,
    });
  });

  it('ignores a main lane that reports no conflicting hunks', () => {
    const checkouts: ConflictCheckout[] = [{ sequence: 3, checkout: '/repo' }];
    const main = [{ lane: '/repo', label: 'main', conflicts: [] }];
    expect(conflictsFor([scan({ main })], checkouts).size).toBe(0);
  });

  it('leaves an item that overlaps nothing out of the reports', () => {
    const checkouts: ConflictCheckout[] = [{ sequence: 4, checkout: A }];
    expect(conflictsFor([scan({})], checkouts).has(4)).toBe(false);
  });

  it('ignores a pair whose checkouts no open item uses', () => {
    const checkouts: ConflictCheckout[] = [{ sequence: 1, checkout: A }];
    const reports = conflictsFor([scan({ pairs: [pair('/other/x', '/other/y')] })], checkouts);
    expect(reports.size).toBe(0);
  });

  it('does not link an item to itself', () => {
    const checkouts: ConflictCheckout[] = [{ sequence: 1, checkout: A }];
    expect(conflictsFor([scan({ pairs: [pair(A, A)] })], checkouts).size).toBe(0);
  });

  it('lists the linked items in ascending order', () => {
    const C = '/repo/.worktrees/squad-c';
    const D = '/repo/.worktrees/squad-d';
    const checkouts: ConflictCheckout[] = [
      { sequence: 1, checkout: A },
      { sequence: 3, checkout: C },
      { sequence: 5, checkout: D },
    ];
    const reports = conflictsFor([scan({ pairs: [pair(A, D), pair(A, C)] })], checkouts);
    expect(reports.get(1)?.sequences).toEqual([3, 5]);
  });
});

describe('describeConflicts', () => {
  it('names the linked items, then the main checkout', () => {
    expect(describeConflicts({ sequences: [3, 5], main: true })).toEqual([
      '#3',
      '#5',
      'checkout chính',
    ]);
  });

  it('names only the items when the main checkout is clear', () => {
    expect(describeConflicts({ sequences: [3], main: false })).toEqual(['#3']);
  });

  it('names nothing for a report with no overlap', () => {
    expect(describeConflicts({ sequences: [], main: false })).toEqual([]);
  });
});
