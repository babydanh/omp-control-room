import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { UsageRecord } from '../../core/src/company.js';
import {
  emptyCursor,
  type OmpUsageReadContext,
  readOmpSessionUsage,
  UsageLedger,
  type UsageObservation,
} from '../src/company/usageService.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const OTHER_SESSION = '22222222-2222-4222-8222-222222222222';

function observation(overrides: Partial<UsageObservation> = {}): UsageObservation {
  return {
    sessionId: SESSION,
    nativeSessionId: 'native-a',
    nativeEntryId: 'entry-1',
    role: 'worker',
    model: 'gpt-6-luna',
    provider: 'openai-codex',
    purpose: 'assistant_turn',
    tokens: { input: 100, output: 20, cacheRead: 400, cacheWrite: 50 },
    timestamp: '2026-10-02T10:00:00.000Z',
    source: 'provider',
    provenance: 'own_turn',
    runEpoch: 1,
    ...overrides,
  };
}

describe('UsageLedger', () => {
  it('counts a native entry once when the same entry is reported twice', () => {
    const ledger = new UsageLedger();

    const first = ledger.record(observation());
    const second = ledger.record(
      observation({ tokens: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0 } }),
    );

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.entry).toBe(first.entry);
    expect(ledger.size).toBe(1);
    expect(ledger.sessionTotals(SESSION)).toMatchObject({ input: 100, records: 1 });
  });

  it('treats a different native session as a different entry', () => {
    const ledger = new UsageLedger();
    ledger.record(observation());
    ledger.record(observation({ nativeSessionId: 'native-b' }));

    expect(ledger.size).toBe(2);
    expect(ledger.sessionTotals(SESSION).records).toBe(2);
  });

  it('counts a parent task rollup once while the child transcript is unreadable', () => {
    const ledger = new UsageLedger();
    ledger.record(
      observation({
        nativeEntryId: 'tool-result-1',
        purpose: 'subagent_aggregate',
        source: 'native_session',
        provenance: 'child_aggregate',
        toolCallId: 'call-1',
        tokens: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0 },
      }),
    );

    expect(ledger.sessionTotals(SESSION)).toMatchObject({ input: 500, records: 1 });
  });

  it('does not double count when the child entries arrive for the same tool call', () => {
    const rollup = observation({
      nativeEntryId: 'tool-result-1',
      purpose: 'subagent_aggregate',
      source: 'native_session',
      provenance: 'child_aggregate',
      toolCallId: 'call-1',
      tokens: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0 },
    });
    const child = observation({
      nativeEntryId: 'child-entry-1',
      purpose: 'assistant_turn',
      source: 'provider',
      provenance: 'native_child',
      toolCallId: 'call-1',
      tokens: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0 },
    });

    for (const entries of [
      [rollup, child],
      [child, rollup],
    ]) {
      const ledger = new UsageLedger();
      for (const entry of entries) ledger.record(entry);

      expect(ledger.sessionTotals(SESSION)).toMatchObject({ input: 500, output: 100, records: 1 });
    }
  });

  it('keeps a second child call separate from the first', () => {
    const ledger = new UsageLedger();
    const tokens = { input: 200, output: 10, cacheRead: 0, cacheWrite: 0 };
    ledger.record(
      observation({
        nativeEntryId: 'child-1',
        provenance: 'native_child',
        toolCallId: 'call-1',
        tokens,
      }),
    );
    ledger.record(
      observation({
        nativeEntryId: 'child-2',
        provenance: 'native_child',
        toolCallId: 'call-2',
        tokens,
      }),
    );
    ledger.record(
      observation({
        nativeEntryId: 'rollup-2',
        provenance: 'child_aggregate',
        toolCallId: 'call-2',
        tokens,
      }),
    );

    expect(ledger.sessionTotals(SESSION)).toMatchObject({ input: 400, records: 2 });
  });

  it('reports an unknown price as unavailable rather than zero', () => {
    const ledger = new UsageLedger();
    const { entry } = ledger.record(observation());

    expect(entry.record.availability).toBe('cost_unavailable');
    expect('costUsd' in entry.record).toBe(false);

    const totals = ledger.sessionTotals(SESSION);
    expect(totals.costUsd).toBeNull();
    expect(totals.costCoverage).toEqual({ reported: 0, unknown: 1 });
    expect(totals.byModel['openai-codex/gpt-6-luna'].costUsd).toBeNull();
  });

  it('reports a source-reported zero as zero, distinct from unknown', () => {
    const ledger = new UsageLedger();
    const { entry } = ledger.record(observation({ costUsd: 0 }));

    expect(entry.record.availability).toBe('cost_reported');
    expect(ledger.sessionTotals(SESSION).costUsd).toBe(0);
  });

  it('marks a partially priced scope instead of implying it is complete', () => {
    const ledger = new UsageLedger();
    ledger.record(observation({ nativeEntryId: 'priced', costUsd: 0.25 }));
    ledger.record(observation({ nativeEntryId: 'unpriced' }));

    const totals = ledger.sessionTotals(SESSION);
    expect(totals.costUsd).toBe(0.25);
    expect(totals.costCoverage).toEqual({ reported: 1, unknown: 1 });
  });

  it('carries the cache-hit denominator and refuses to invent a ratio', () => {
    const ledger = new UsageLedger();
    expect(ledger.sessionTotals(SESSION).cacheHit).toEqual({
      cacheRead: 0,
      denominator: 0,
      ratio: null,
    });

    ledger.record(observation());
    const { cacheHit } = ledger.sessionTotals(SESSION);
    expect(cacheHit.denominator).toBe(550);
    expect(cacheHit.ratio).toBeCloseTo(400 / 550, 10);
  });

  it('separates run, session, Contract and company totals', () => {
    const ledger = new UsageLedger({
      contractIdForSession: (sessionId) => (sessionId === SESSION ? 'contract-1' : undefined),
    });
    ledger.record(
      observation({ nativeEntryId: 'first-run', contractId: 'contract-1', runEpoch: 1 }),
    );
    ledger.beginRun(SESSION, 2);
    ledger.record(
      observation({ nativeEntryId: 'second-run', contractId: 'contract-1', runEpoch: 2 }),
    );
    ledger.record(
      observation({
        nativeEntryId: 'other-session',
        sessionId: OTHER_SESSION,
        contractId: 'contract-2',
      }),
    );

    expect(ledger.currentRunEpoch(SESSION)).toBe(2);
    expect(ledger.runTotals(SESSION)).toMatchObject({ records: 1, input: 100 });
    expect(ledger.sessionTotals(SESSION)).toMatchObject({ records: 2, input: 200 });
    expect(ledger.sessionTotals(OTHER_SESSION)).toMatchObject({ records: 1, input: 100 });
    expect(ledger.contractTotals('contract-1')).toMatchObject({ records: 2, input: 200 });
    expect(ledger.companyTotals()).toMatchObject({ records: 3, input: 300 });
  });

  it('keeps the newest context snapshot instead of summing occupancy', () => {
    const ledger = new UsageLedger();
    ledger.recordContext(SESSION, {
      contextTokens: 1000,
      providerReported: true,
      observedAt: '2026-10-02T10:00:00.000Z',
    });
    ledger.recordContext(SESSION, {
      contextTokens: 4000,
      providerReported: true,
      observedAt: '2026-10-02T10:05:00.000Z',
    });
    ledger.recordContext(SESSION, {
      contextTokens: 2000,
      providerReported: true,
      observedAt: '2026-10-02T10:01:00.000Z',
    });

    expect(ledger.contextOccupancy(SESSION)?.contextTokens).toBe(4000);
  });

  it('refuses an observation it could not dedupe later', () => {
    const ledger = new UsageLedger();
    expect(() => ledger.record(observation({ nativeEntryId: '  ' }))).toThrowError(
      expect.objectContaining({ code: 'usage_entry_identity_missing' }),
    );
  });
});

describe('UsageLedger restart hydration', () => {
  const childTokens = { input: 500, output: 100, cacheRead: 0, cacheWrite: 0 };
  const rollupObservation = observation({
    nativeEntryId: 'tool-result-1',
    purpose: 'subagent_aggregate',
    source: 'native_session',
    provenance: 'child_aggregate',
    toolCallId: 'call-1',
    tokens: childTokens,
  });
  const childObservation = observation({
    nativeEntryId: 'child-entry-1',
    provenance: 'native_child',
    toolCallId: 'call-1',
    tokens: childTokens,
  });

  function persistedFrom(ledger: UsageLedger): Record<string, UsageRecord[]> {
    return { [SESSION]: ledger.entries().map((entry) => entry.record) };
  }

  it('keeps a child entry superseding its parent rollup after a restore', () => {
    const running = new UsageLedger();
    running.record(rollupObservation);
    running.record(childObservation);

    const restored = new UsageLedger();
    restored.hydrateFromState(persistedFrom(running));

    // The rollup is still in the ledger, but it no longer counts: the child's
    // own entry is the truth for those calls, exactly as before the restart.
    expect(restored.size).toBe(2);
    expect(restored.sessionTotals(SESSION)).toMatchObject({ input: 500, output: 100, records: 1 });
  });

  it('keeps dedupe stable when a restored ledger is handed the same entry again', () => {
    const running = new UsageLedger();
    running.record(childObservation);

    const restored = new UsageLedger();
    restored.hydrateFromState(persistedFrom(running));
    const again = restored.record(
      observation({
        nativeEntryId: 'child-entry-1',
        provenance: 'native_child',
        toolCallId: 'call-1',
        tokens: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 },
      }),
    );

    expect(again.duplicate).toBe(true);
    expect(restored.size).toBe(1);
    expect(restored.sessionTotals(SESSION)).toMatchObject({ input: 500, records: 1 });
  });

  it('does not double a total when the same store is hydrated twice', () => {
    const running = new UsageLedger();
    running.record(childObservation);
    const persisted = persistedFrom(running);

    const restored = new UsageLedger();
    restored.hydrateFromState(persisted);
    restored.hydrateFromState(persisted);

    expect(restored.size).toBe(1);
    expect(restored.sessionTotals(SESSION)).toMatchObject({ input: 500, records: 1 });
  });

  it('scopes run totals to the newest epoch the restore saw', () => {
    const running = new UsageLedger();
    running.record(observation({ nativeEntryId: 'old-run', runEpoch: 1 }));
    running.record(observation({ nativeEntryId: 'live-run', runEpoch: 2 }));

    const restored = new UsageLedger();
    restored.hydrateFromState(persistedFrom(running));

    expect(restored.currentRunEpoch(SESSION)).toBe(2);
    expect(restored.runTotals(SESSION)).toMatchObject({ records: 1, input: 100 });
    expect(restored.sessionTotals(SESSION)).toMatchObject({ records: 2, input: 200 });
  });

  it('reports an empty run once a new epoch starts but has not spent yet', () => {
    const running = new UsageLedger();
    running.record(observation({ nativeEntryId: 'live-run', runEpoch: 2 }));

    const restored = new UsageLedger();
    restored.hydrateFromState(persistedFrom(running));
    restored.beginRun(SESSION, 3);

    expect(restored.runTotals(SESSION)).toMatchObject({ records: 0, input: 0, costUsd: null });
    restored.record(observation({ nativeEntryId: 'new-run', runEpoch: 3 }));
    expect(restored.runTotals(SESSION)).toMatchObject({ records: 1, input: 100 });
  });

  it('restores sessions in the same order whatever order the buckets arrive in', () => {
    const first = new UsageLedger();
    first.record(observation({ nativeEntryId: 'a' }));
    first.record(observation({ sessionId: OTHER_SESSION, nativeEntryId: 'b' }));
    const aRecords = first
      .entries()
      .filter((entry) => entry.record.sessionId === SESSION)
      .map((entry) => entry.record);
    const bRecords = first
      .entries()
      .filter((entry) => entry.record.sessionId === OTHER_SESSION)
      .map((entry) => entry.record);

    const forward = new UsageLedger();
    forward.hydrateFromState({ [SESSION]: aRecords, [OTHER_SESSION]: bRecords });
    const reversed = new UsageLedger();
    reversed.hydrateFromState({ [OTHER_SESSION]: bRecords, [SESSION]: aRecords });

    expect(forward.entries().map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(reversed.entries().map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(forward.entries().map((entry) => entry.record.sessionId)).toEqual(
      reversed.entries().map((entry) => entry.record.sessionId),
    );
  });
});

describe('readOmpSessionUsage', () => {
  let tempDir: string;
  let sessionFile: string;

  const context: OmpUsageReadContext = {
    sessionId: SESSION,
    role: 'worker',
    nativeSessionId: 'native-a',
    runEpoch: 4,
    contractId: 'contract-1',
  };

  function assistantEntry(entryId: string, overrides: Record<string, unknown> = {}): string {
    return `${JSON.stringify({
      type: 'message',
      id: entryId,
      parentId: null,
      timestamp: '2026-10-02T10:00:00.000Z',
      message: {
        role: 'assistant',
        api: 'openai-responses',
        provider: 'openai-codex',
        model: 'gpt-6-luna',
        usage: {
          input: 10,
          output: 4,
          cacheRead: 80,
          cacheWrite: 6,
          totalTokens: 100,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 },
          contextTokens: 5120,
        },
      },
      ...overrides,
    })}\n`;
  }

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pxl-company-usage-'));
    sessionFile = path.join(tempDir, '2026-10-02T10-00-00-000Z_native-a.jsonl');
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it('reads appended usage once and resumes a line that is still being written', async () => {
    const complete = assistantEntry('entry-1');
    const partial = assistantEntry('entry-2');
    const splitAt = partial.length - 12;
    await fs.promises.writeFile(sessionFile, complete + partial.slice(0, splitAt));

    const ledger = new UsageLedger();
    const cursor = emptyCursor();

    const first = await readOmpSessionUsage(sessionFile, cursor, context);
    expect(first.observations.map((entry) => entry.nativeEntryId)).toEqual(['entry-1']);
    // The cursor consumed every byte; the half-written line travels as raw
    // pending bytes instead of being re-read next time.
    expect(first.cursor.offset).toBe((await fs.promises.stat(sessionFile)).size);
    expect(Buffer.from(first.cursor.pending, 'base64').toString('utf8')).toBe(
      partial.slice(0, splitAt),
    );
    for (const entry of first.observations) ledger.record(entry);
    await fs.promises.appendFile(sessionFile, partial.slice(splitAt));
    const second = await readOmpSessionUsage(sessionFile, first.cursor, context);
    expect(second.observations.map((entry) => entry.nativeEntryId)).toEqual(['entry-2']);
    for (const entry of second.observations) ledger.record(entry);

    const third = await readOmpSessionUsage(sessionFile, second.cursor, context);
    expect(third.observations).toHaveLength(0);
    expect(third.malformedLines).toBe(0);

    expect(ledger.size).toBe(2);
    expect(ledger.sessionTotals(SESSION)).toMatchObject({ input: 20, output: 8, records: 2 });
  });

  it('never re-reads bytes before the cursor', async () => {
    const entry = assistantEntry('entry-1');
    await fs.promises.writeFile(sessionFile, entry);

    const cursor = emptyCursor();
    const first = await readOmpSessionUsage(sessionFile, cursor, context);
    expect(first.cursor.offset).toBe(entry.length);

    await fs.promises.writeFile(sessionFile, `${entry}${assistantEntry('entry-2')}`);
    const second = await readOmpSessionUsage(sessionFile, first.cursor, context);
    expect(second.observations.map((found) => found.nativeEntryId)).toEqual(['entry-2']);
    expect(second.restarted).toBe(false);
  });

  it('reads model_usage entries with their native purpose and price', async () => {
    await fs.promises.writeFile(
      sessionFile,
      `${JSON.stringify({
        type: 'model_usage',
        id: 'mu-1',
        parentId: null,
        timestamp: '2026-10-02T10:00:00.000Z',
        purpose: 'advisor',
        api: 'anthropic-messages',
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        usage: {
          input: 1,
          output: 2,
          cacheRead: 3,
          cacheWrite: 4,
          totalTokens: 10,
        },
      })}\n`,
    );

    const result = await readOmpSessionUsage(sessionFile, emptyCursor(), context);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      purpose: 'advisor',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      source: 'native_session',
      contractId: 'contract-1',
    });
    // No price in the payload means no price in the observation.
    expect('costUsd' in result.observations[0]).toBe(false);
  });

  it('reads a parent task rollup as a child aggregate linked by tool call', async () => {
    await fs.promises.writeFile(
      sessionFile,
      `${JSON.stringify({
        type: 'message',
        id: 'tr-1',
        parentId: null,
        timestamp: '2026-10-02T10:00:00.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'task',
          isError: false,
          content: [],
          details: {
            usage: { input: 300, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 330 },
          },
        },
      })}\n`,
    );

    const result = await readOmpSessionUsage(sessionFile, emptyCursor(), context);
    expect(result.observations[0]).toMatchObject({
      provenance: 'child_aggregate',
      toolCallId: 'call-1',
      purpose: 'subagent_aggregate',
    });
  });

  it('reports the newest context occupancy an assistant turn reported', async () => {
    await fs.promises.writeFile(sessionFile, assistantEntry('entry-1'));
    const result = await readOmpSessionUsage(sessionFile, emptyCursor(), context);

    expect(result.context).toMatchObject({ contextTokens: 5120, providerReported: true });
  });

  it('flags a subagent transcript by its header parent session', async () => {
    await fs.promises.writeFile(
      sessionFile,
      `${JSON.stringify({
        type: 'session',
        version: 3,
        id: 'native-a',
        parentSession: 'native-parent',
        timestamp: '2026-10-02T10:00:00.000Z',
        cwd: tempDir,
      })}\n`,
    );

    const result = await readOmpSessionUsage(sessionFile, emptyCursor(), context);
    expect(result.parentNativeSessionId).toBe('native-parent');
    expect(result.headerNativeSessionId).toBe('native-a');
  });

  it('skips a Claude transcript record instead of reading it as OMP usage', async () => {
    const claudeLine = `${JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-sonnet-4',
        usage: { input_tokens: 1234, output_tokens: 99 },
      },
    })}\n`;
    await fs.promises.writeFile(sessionFile, `${claudeLine}${assistantEntry('entry-1')}`);

    const result = await readOmpSessionUsage(sessionFile, emptyCursor(), context);
    expect(result.observations.map((entry) => entry.nativeEntryId)).toEqual(['entry-1']);
    expect(result.malformedLines).toBe(0);
  });

  it('counts an unparseable line as malformed and keeps reading', async () => {
    await fs.promises.writeFile(sessionFile, `{"type":"message",\n${assistantEntry('entry-1')}`);

    const result = await readOmpSessionUsage(sessionFile, emptyCursor(), context);
    expect(result.malformedLines).toBe(1);
    expect(result.observations.map((entry) => entry.nativeEntryId)).toEqual(['entry-1']);
  });

  it('restarts when the session file shrank', async () => {
    await fs.promises.writeFile(
      sessionFile,
      `${assistantEntry('entry-1')}${assistantEntry('entry-2')}`,
    );
    const first = await readOmpSessionUsage(sessionFile, emptyCursor(), context);
    expect(first.observations).toHaveLength(2);

    await fs.promises.writeFile(sessionFile, assistantEntry('entry-9'));
    const second = await readOmpSessionUsage(sessionFile, first.cursor, context);

    expect(second.restarted).toBe(true);
    expect(second.observations.map((entry) => entry.nativeEntryId)).toEqual(['entry-9']);
  });

  it('refuses a usage entry missing any token bucket instead of zero-filling it', async () => {
    await fs.promises.writeFile(
      sessionFile,
      `${JSON.stringify({
        type: 'message',
        id: 'entry-1',
        timestamp: '2026-10-02T10:00:00.000Z',
        message: {
          role: 'assistant',
          provider: 'openai-codex',
          model: 'gpt-6-luna',
          usage: { input: 10, output: 4 },
        },
      })}\n`,
    );

    const result = await readOmpSessionUsage(sessionFile, emptyCursor(), context);
    expect(result.observations).toHaveLength(0);
    expect(result.malformedLines).toBe(0);
  });
});
