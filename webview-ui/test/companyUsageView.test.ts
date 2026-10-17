import { describe, expect, it } from 'vitest';

import {
  cacheHitRate,
  countableRecords,
  quotaRows,
  summarizeUsage,
  usageByModel,
  usageForSession,
} from '../src/company/usageView.js';
import { usageRecord } from './companyFixtures.js';

describe('usage totals', () => {
  it('sums the tokens the source reported', () => {
    const first = usageRecord({ input: 10, output: 5, cacheRead: 1, cacheWrite: 2, costUsd: 0.01 });
    const second = usageRecord({
      input: 20,
      output: 6,
      cacheRead: 3,
      cacheWrite: 4,
      costUsd: 0.02,
      nativeEntryId: 'entry-2',
    });

    expect(summarizeUsage([first, second])).toEqual({
      input: 30,
      output: 11,
      cacheRead: 4,
      cacheWrite: 6,
      costUsd: 0.03,
      recordCount: 2,
    });
  });

  it('reports an unknown cost as unavailable, never as zero', () => {
    const priced = usageRecord({ costUsd: 0.02 });
    const unpriced = usageRecord({ nativeEntryId: 'entry-2', costUsd: undefined });

    expect(summarizeUsage([priced, unpriced]).costUsd).toBeNull();
    expect(summarizeUsage([]).costUsd).toBeNull();
  });

  it('names the denominator, and refuses a rate with nothing to divide by', () => {
    const records = [usageRecord({ input: 0, output: 1, cacheRead: 0, cacheWrite: 0 })];

    expect(cacheHitRate(records)).toEqual({ rate: null, denominator: 0, cacheRead: 0 });
    expect(
      cacheHitRate([usageRecord({ input: 0, output: 0, cacheRead: 9, cacheWrite: 1 })]),
    ).toEqual({ rate: 0.9, denominator: 10, cacheRead: 9 });
  });

  it('does not count a child subagent twice: once as the parent rollup, once as its own entries', () => {
    const parentRollup = usageRecord({
      provenance: 'child_aggregate',
      toolCallId: 'tool-1',
      nativeEntryId: 'parent-entry',
      input: 500,
      output: 200,
    });
    const childTurn = usageRecord({
      provenance: 'native_child',
      toolCallId: 'tool-1',
      nativeEntryId: 'child-entry',
      input: 480,
      output: 190,
    });
    const ownTurn = usageRecord({ provenance: 'own_turn', nativeEntryId: 'own-entry', input: 10 });

    const countable = countableRecords([parentRollup, childTurn, ownTurn]);
    expect(countable).toHaveLength(2);
    expect(summarizeUsage([parentRollup, childTurn, ownTurn]).input).toBe(490);
  });

  it('keeps a child aggregate when nothing else recorded that tool call', () => {
    const orphanRollup = usageRecord({
      provenance: 'child_aggregate',
      toolCallId: 'tool-9',
      nativeEntryId: 'parent-entry',
      input: 500,
    });

    expect(countableRecords([orphanRollup])).toHaveLength(1);
    expect(summarizeUsage([orphanRollup]).input).toBe(500);
  });

  it('scopes a session total to that session and leaves the rest alone', () => {
    const mine = usageRecord({ sessionId: 'session-1', input: 10 });
    const theirs = usageRecord({ sessionId: 'session-2', input: 99, nativeEntryId: 'entry-2' });

    expect(usageForSession([mine, theirs], 'session-1').input).toBe(10);
    expect(summarizeUsage([mine, theirs]).input).toBe(109);
  });

  it('breaks the breakdown down by the model that actually ran', () => {
    const luna = usageRecord({ model: 'gpt-6-luna', input: 10, costUsd: 0.01 });
    const sonnet = usageRecord({
      model: 'claude-sonnet-5-5',
      provider: 'anthropic',
      input: 20,
      nativeEntryId: 'entry-2',
    });

    const rows = usageByModel([luna, sonnet]);
    expect(rows.map((row) => `${row.provider}/${row.model}`)).toEqual([
      'anthropic/claude-sonnet-5-5',
      'openai-codex/gpt-6-luna',
    ]);
    expect(rows[0].totals.costUsd).toBeNull();
  });
});

describe('provider quota', () => {
  it('shows the account scope and the units the source reported', () => {
    const rows = quotaRows([
      {
        provider: 'openai-codex',
        accountLabel: 'acct-***',
        fetchedAt: '2026-10-02T10:00:00.000Z',
        status: 'available',
        windows: [{ label: '5h', remaining: 120, reportedUnit: 'requests' }],
      },
      {
        provider: 'anthropic',
        fetchedAt: '2026-10-02T10:00:00.000Z',
        status: 'unauthenticated',
        windows: [],
      },
    ]);

    expect(rows[0]).toMatchObject({ provider: 'openai-codex', accountLabel: 'acct-***' });
    expect(rows[0].windows[0]).toEqual({
      label: '5h',
      used: null,
      remaining: 120,
      resetAt: null,
      reportedUnit: 'requests',
    });
    // No account label reported means "not reported", not a blank invention.
    expect(rows[1].accountLabel).toBe('(đã che)');
    expect(rows[1].status).toBe('unauthenticated');
  });
});
