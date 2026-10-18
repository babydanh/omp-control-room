import { describe, expect, it } from 'vitest';

import type { CompanySessionLogEntry } from '../../core/src/company.js';
import {
  activityCounts,
  filterActivity,
  matchesActivityFilter,
} from '../src/company/sessionLogView.js';

function entry(
  seq: number,
  kind: CompanySessionLogEntry['kind'],
  extra: Partial<CompanySessionLogEntry> = {},
): CompanySessionLogEntry {
  return { seq, at: '2026-01-01T00:00:00.000Z', kind, runEpoch: 1, text: `entry ${seq}`, ...extra };
}

/** One entry of every group, plus a command still running and a command that failed. */
const LOG: CompanySessionLogEntry[] = [
  entry(1, 'text'),
  entry(2, 'tool', { toolName: 'read' }),
  entry(3, 'command', { exitCode: 0 }),
  entry(4, 'command', { exitCode: 1 }),
  entry(5, 'verdict', { ok: true }),
  entry(6, 'verdict', { ok: false }),
  entry(7, 'question'),
  entry(8, 'error'),
  entry(9, 'state'),
  entry(10, 'command'),
];

function seqs(entries: readonly CompanySessionLogEntry[]): number[] {
  return entries.map((item) => item.seq);
}

describe('activity filter', () => {
  it('shows every entry, state lines included, under all', () => {
    expect(seqs(filterActivity(LOG, 'all'))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('groups commands, tools and says apart', () => {
    expect(seqs(filterActivity(LOG, 'commands'))).toEqual([3, 4, 10]);
    expect(seqs(filterActivity(LOG, 'tools'))).toEqual([2]);
    expect(seqs(filterActivity(LOG, 'says'))).toEqual([1]);
  });

  it('puts verdicts and questions under asks', () => {
    expect(seqs(filterActivity(LOG, 'asks'))).toEqual([5, 6, 7]);
  });

  it('collects failed commands, failed verdicts and errors under errors', () => {
    expect(seqs(filterActivity(LOG, 'errors'))).toEqual([4, 6, 8]);
  });

  it('does not count a command still running as an error', () => {
    expect(matchesActivityFilter(entry(10, 'command'), 'errors')).toBe(false);
  });

  it('counts what each chip would show', () => {
    expect(activityCounts(LOG)).toEqual({
      all: 10,
      commands: 3,
      tools: 1,
      says: 1,
      asks: 3,
      errors: 3,
    });
  });

  it('shows nothing under a chip when no entry fits it', () => {
    expect(filterActivity([entry(1, 'text')], 'errors')).toEqual([]);
  });
});
