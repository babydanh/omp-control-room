/**
 * usageView: what the numbers actually say, and what they do not.
 *
 * Three rules, each one a way a dashboard usually lies:
 *
 *  - A cost total is a SUM OF REPORTED COSTS. If any record in the scope has
 *    no source-provided price, the total is `null` -- "unavailable" -- and
 *    never `0`, because a zero reads as "this was free" and it was not.
 *  - A cache-hit rate names its denominator. With no input, cache-read or
 *    cache-write tokens reported there is nothing to divide by, so the rate is
 *    `null` rather than 0%.
 *  - Context occupancy is NOT spend. It is read from the session's context
 *    snapshot the server sent, never derived from these totals.
 *
 * Records arrive per native entry and are already deduplicated by the client,
 * so a native child session's spend is counted once, on its own entries.
 */

import type {
  CompanySessionSummary,
  QuotaSnapshot,
  UsageRecord,
} from '../../../core/src/company.js';

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Sum of source-reported costs, or null when any record lacks one. */
  costUsd: number | null;
  recordCount: number;
}

export interface CacheHit {
  /** Null when the scope reported no tokens to divide by. */
  rate: number | null;
  denominator: number;
  cacheRead: number;
}

/**
 * The records a total may be built from.
 *
 * A native subagent's spend arrives twice: once as the parent's rollup for the
 * tool call that spawned it, and once as the child's own transcript entries.
 * Counting both invents spend the company never made, so a `child_aggregate`
 * whose tool call also has a `native_child` entry is dropped. An aggregate
 * with no child entries behind it is KEPT -- it is the only record of that
 * work, and dropping it would understate the bill.
 */
export function countableRecords(records: readonly UsageRecord[]): UsageRecord[] {
  const childToolCalls = new Set(
    records
      .filter((record) => record.provenance === 'native_child' && record.toolCallId !== undefined)
      .map((record) => record.toolCallId as string),
  );
  return records.filter(
    (record) =>
      record.provenance !== 'child_aggregate' ||
      record.toolCallId === undefined ||
      !childToolCalls.has(record.toolCallId),
  );
}

export function summarizeUsage(records: readonly UsageRecord[]): UsageTotals {
  const countable = countableRecords(records);
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let everyRecordPriced = countable.length > 0;
  for (const record of countable) {
    input += record.input;
    output += record.output;
    cacheRead += record.cacheRead;
    cacheWrite += record.cacheWrite;
    if (record.costUsd === undefined) {
      everyRecordPriced = false;
    } else {
      cost += record.costUsd;
    }
  }
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    costUsd: everyRecordPriced ? cost : null,
    recordCount: countable.length,
  };
}

export function cacheHitRate(records: readonly UsageRecord[]): CacheHit {
  let input = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const record of countableRecords(records)) {
    input += record.input;
    cacheRead += record.cacheRead;
    cacheWrite += record.cacheWrite;
  }
  const denominator = input + cacheRead + cacheWrite;
  return {
    rate: denominator === 0 ? null : cacheRead / denominator,
    denominator,
    cacheRead,
  };
}

export interface UsageModelRow {
  model: string;
  provider: string;
  totals: UsageTotals;
  cacheHit: CacheHit;
}

export function usageForSession(records: readonly UsageRecord[], sessionId: string): UsageTotals {
  return summarizeUsage(records.filter((record) => record.sessionId === sessionId));
}

export function usageByModel(records: readonly UsageRecord[]): UsageModelRow[] {
  const grouped = new Map<string, UsageRecord[]>();
  for (const record of countableRecords(records)) {
    const key = `${record.provider}/${record.model}`;
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(record);
    } else {
      grouped.set(key, [record]);
    }
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, bucket]) => ({
      model: bucket[0].model,
      provider: bucket[0].provider,
      totals: summarizeUsage(bucket),
      cacheHit: cacheHitRate(bucket),
    }));
}

export interface QuotaRow {
  provider: string;
  accountLabel: string;
  status: QuotaSnapshot['status'];
  fetchedAt: string;
  windows: {
    label: string;
    /** Exactly as reported, or null when the source did not report a number. */
    used: number | null;
    remaining: number | null;
    resetAt: string | null;
    reportedUnit: string;
  }[];
}

export function quotaRows(quotas: readonly QuotaSnapshot[]): QuotaRow[] {
  return quotas.map((quota) => ({
    provider: quota.provider,
    accountLabel: quota.accountLabel ?? '(đã che)',
    status: quota.status,
    fetchedAt: quota.fetchedAt,
    windows: quota.windows.map((window) => ({
      label: window.label,
      used: window.used ?? null,
      remaining: window.remaining ?? null,
      resetAt: window.resetAt ?? null,
      reportedUnit: window.reportedUnit,
    })),
  }));
}

/** Occupancy from the server's snapshot, not from the spend totals. */
export function contextOccupancy(session: CompanySessionSummary): number | null {
  const snapshot = session.contextSnapshot;
  if (!snapshot) return null;
  const used = snapshot['usedTokens'] ?? snapshot['contextTokens'];
  const window = snapshot['windowTokens'] ?? snapshot['maxContextTokens'];
  if (typeof used !== 'number' || typeof window !== 'number' || window <= 0) return null;
  return used / window;
}
