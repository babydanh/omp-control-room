/**
 * Spam rule: pure evaluation over one session's tool calls. A session is
 * spamming when some window holds at least `callsPerWindow` calls, or the same
 * intent label at least `sameIntentPerWindow` times. Windows are half-open,
 * [start, start + window): two calls exactly one window apart never share one.
 */

import type { LedgerSpamRule } from '../../../core/src/messages.js';

export interface SpamCall {
  readonly tMs: number;
  readonly intent: string | null;
}

export interface SpamVerdict {
  readonly spamming: boolean;
  readonly reason: string | null;
}

const NOT_SPAMMING: SpamVerdict = { spamming: false, reason: null };

export function evaluateSpam(calls: readonly SpamCall[], rule: LedgerSpamRule): SpamVerdict {
  const windowMs = rule.windowMinutes * 60_000;
  if (windowMs <= 0) return NOT_SPAMMING;
  const ordered = [...calls].sort((a, b) => a.tMs - b.tMs);
  const intentCounts = new Map<string, number>();
  let peakCalls = 0;
  let peakIntent: { label: string; count: number } | null = null;
  let end = 0;
  for (let start = 0; start < ordered.length; start++) {
    while (end < ordered.length && ordered[end].tMs - ordered[start].tMs < windowMs) {
      const label = ordered[end].intent;
      if (label !== null && label !== '') {
        const count = (intentCounts.get(label) ?? 0) + 1;
        intentCounts.set(label, count);
        if (peakIntent === null || count > peakIntent.count) peakIntent = { label, count };
      }
      end++;
    }
    peakCalls = Math.max(peakCalls, end - start);
    const leaving = ordered[start].intent;
    if (leaving !== null && leaving !== '') {
      intentCounts.set(leaving, (intentCounts.get(leaving) ?? 0) - 1);
    }
  }
  if (peakCalls >= rule.callsPerWindow) {
    return { spamming: true, reason: `${peakCalls} lệnh trong ${rule.windowMinutes} phút` };
  }
  if (peakIntent !== null && peakIntent.count >= rule.sameIntentPerWindow) {
    return {
      spamming: true,
      reason: `lặp «${peakIntent.label}» ${peakIntent.count} lần trong ${rule.windowMinutes} phút`,
    };
  }
  return NOT_SPAMMING;
}
