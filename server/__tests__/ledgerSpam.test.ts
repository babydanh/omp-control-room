import { describe, expect, it } from 'vitest';

import { LEDGER_SPAM_RULE } from '../src/ledger/constants.js';
import { evaluateSpam, type SpamCall } from '../src/ledger/spam.js';

const MINUTE_MS = 60_000;

/** `count` calls `gapMs` apart, starting at `startMs`, all with one intent. */
function callsEvery(count: number, gapMs: number, intent: string | null, startMs = 0): SpamCall[] {
  return Array.from({ length: count }, (_, index) => ({ tMs: startMs + index * gapMs, intent }));
}

describe('spam rule thresholds', () => {
  it('ships the documented thresholds', () => {
    expect(LEDGER_SPAM_RULE).toEqual({
      windowMinutes: 5,
      callsPerWindow: 60,
      sameIntentPerWindow: 12,
      lookbackMinutes: 30,
    });
  });
});

describe('evaluateSpam: tool call count', () => {
  it('does not flag 59 calls inside one 5-minute window', () => {
    const verdict = evaluateSpam(callsEvery(59, 1000, null), LEDGER_SPAM_RULE);
    expect(verdict).toEqual({ spamming: false, reason: null });
  });

  it('flags 60 calls inside one 5-minute window with the Vietnamese reason', () => {
    const verdict = evaluateSpam(callsEvery(60, 1000, null), LEDGER_SPAM_RULE);
    expect(verdict).toEqual({ spamming: true, reason: '60 lệnh trong 5 phút' });
  });

  it('does not pool calls that are exactly one window apart (half-open windows)', () => {
    // 60 calls, one every 5 minutes: every window [t, t+5m) holds exactly one call.
    const verdict = evaluateSpam(callsEvery(60, 5 * MINUTE_MS, null), LEDGER_SPAM_RULE);
    expect(verdict.spamming).toBe(false);
  });

  it('finds a busy window anywhere in the lookback, not only the first', () => {
    const quiet = callsEvery(59, 1000, null);
    const busy = callsEvery(60, 1000, null, 30 * MINUTE_MS);
    expect(evaluateSpam([...quiet, ...busy], LEDGER_SPAM_RULE).spamming).toBe(true);
  });
});

describe('evaluateSpam: same intent repeated', () => {
  it('does not flag 11 identical intents inside one window', () => {
    const verdict = evaluateSpam(callsEvery(11, 1000, 'sửa parser'), LEDGER_SPAM_RULE);
    expect(verdict).toEqual({ spamming: false, reason: null });
  });

  it('flags 12 identical intents with the repeated-intent reason', () => {
    const verdict = evaluateSpam(callsEvery(12, 1000, 'sửa parser'), LEDGER_SPAM_RULE);
    expect(verdict).toEqual({
      spamming: true,
      reason: 'lặp «sửa parser» 12 lần trong 5 phút',
    });
  });

  it('does not pool different intents together', () => {
    const verdict = evaluateSpam(
      [...callsEvery(6, 1000, 'a'), ...callsEvery(6, 1000, 'b', 10_000)],
      LEDGER_SPAM_RULE,
    );
    expect(verdict.spamming).toBe(false);
  });

  it('ignores null and empty intents', () => {
    expect(evaluateSpam(callsEvery(12, 1000, null), LEDGER_SPAM_RULE).spamming).toBe(false);
    expect(evaluateSpam(callsEvery(12, 1000, ''), LEDGER_SPAM_RULE).spamming).toBe(false);
  });

  it('does not flag 12 identical intents spread exactly one window apart', () => {
    const verdict = evaluateSpam(callsEvery(12, 5 * MINUTE_MS, 'x'), LEDGER_SPAM_RULE);
    expect(verdict.spamming).toBe(false);
  });

  it('reports the call-count reason first when both rules trip', () => {
    const verdict = evaluateSpam(callsEvery(60, 1000, 'same'), LEDGER_SPAM_RULE);
    expect(verdict.reason).toBe('60 lệnh trong 5 phút');
  });
});
