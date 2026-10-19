/**
 * usageStats: the token and cost totals, shaped for the usage page's tables and charts.
 *
 * Pure: no network, no DOM. A cost that was never priced is never shown as zero.
 */

import type {
  UsageStatsCostPoint,
  UsageStatsModelPerformancePoint,
  UsageStatsTotals,
} from '../../../../core/src/messages.js';
import { formatCount, formatPercent, formatTokens, formatUsd } from './usageFormat.js';

/** The four token fields a row's totals share, with no cost. */
export type TokenTotals = Pick<
  UsageStatsTotals,
  'totalInputTokens' | 'totalOutputTokens' | 'totalCacheReadTokens' | 'totalCacheWriteTokens'
>;

/**
 * Cost split by kind, plus the reported total. `total` is the sum of each point's `cost`, which is
 * what the server reports as spend. The four parts are the sum of each point's split. When a point
 * reports a cost without a split, the parts sum to less than `total`; that gap is unattributed and is
 * not spread across the parts.
 */
export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export function costBreakdown(points: readonly UsageStatsCostPoint[]): CostBreakdown {
  const breakdown: CostBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  for (const point of points) {
    breakdown.input += point.costInput;
    breakdown.output += point.costOutput;
    breakdown.cacheRead += point.costCacheRead;
    breakdown.cacheWrite += point.costCacheWrite;
    breakdown.total += point.cost;
  }
  return breakdown;
}

/**
 * The cost as the page shows it. When some requests carry no price, zero is not a cost the user
 * spent: with no priced cost at all the label says so, and with some cost it names how many
 * requests are missing from it.
 */
export function costLabel(
  totals: Pick<UsageStatsTotals, 'totalCost' | 'unpricedRequests'>,
): string {
  if (totals.unpricedRequests > 0 && totals.totalCost === 0) return 'chưa có giá';
  if (totals.unpricedRequests > 0) {
    return `${formatUsd(totals.totalCost)} · ${formatCount(totals.unpricedRequests)} yêu cầu chưa có giá`;
  }
  return formatUsd(totals.totalCost);
}

/**
 * The share of input served from the cache. The denominator is the same one `cacheHitRate` in
 * usageView.ts uses: input + cache read + cache write. The label names that denominator, and
 * with no tokens at all it says so rather than showing a rate.
 */
export function cacheRateLabel(totals: TokenTotals): string {
  const denominator =
    totals.totalInputTokens + totals.totalCacheReadTokens + totals.totalCacheWriteTokens;
  if (denominator === 0) return 'Chưa có token để tính tỷ lệ';
  const rate = totals.totalCacheReadTokens / denominator;
  return `${formatPercent(rate)} từ cache · tính trên ${formatTokens(denominator)} token đầu vào và cache`;
}

/** Input, output, cache read and cache write tokens added together. */
export function tokenSum(totals: TokenTotals): number {
  return (
    totals.totalInputTokens +
    totals.totalOutputTokens +
    totals.totalCacheReadTokens +
    totals.totalCacheWriteTokens
  );
}

export type SortDirection = 'asc' | 'desc';

/** A sortable cell. null, undefined and NaN are missing and always sort last. */
export type SortValue = number | string | null | undefined;

function isMissing(value: SortValue): value is null | undefined {
  return (
    value === null || value === undefined || (typeof value === 'number' && Number.isNaN(value))
  );
}

function compareValues(left: number | string, right: number | string): number {
  if (typeof left === 'number' && typeof right === 'number') {
    if (left === right) return 0;
    return left < right ? -1 : 1;
  }
  if (typeof left === 'string' && typeof right === 'string') {
    if (left === right) return 0;
    return left < right ? -1 : 1;
  }
  // Mixed kinds in one column: numbers before text, so the order is still total.
  return typeof left === 'number' ? -1 : 1;
}

/**
 * A copy of `rows` sorted by the value `accessor` reads for `key`. The sort is stable, so rows
 * that tie keep their order, and the input array is never changed. Missing values stay last in
 * both directions.
 */
export function sortRows<T, K extends string>(
  rows: readonly T[],
  key: K,
  dir: SortDirection,
  accessor: (row: T, key: K) => SortValue,
): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((left, right) => {
    const leftValue = accessor(left, key);
    const rightValue = accessor(right, key);
    const leftMissing = isMissing(leftValue);
    const rightMissing = isMissing(rightValue);
    if (leftMissing || rightMissing) {
      if (leftMissing === rightMissing) return 0;
      return leftMissing ? 1 : -1;
    }
    return sign * compareValues(leftValue, rightValue);
  });
}

/** A point with its `timestamp` read as epoch milliseconds in `at`. */
export type TimedPoint<P extends { timestamp: string }> = P & { at: number };

/**
 * The points in time order, each with `at` set to its timestamp's epoch milliseconds. A point
 * whose timestamp cannot be read is left out.
 */
export function timeSeriesPoints<P extends { timestamp: string }>(
  points: readonly P[],
): TimedPoint<P>[] {
  const timed: TimedPoint<P>[] = [];
  for (const point of points) {
    const at = Date.parse(point.timestamp);
    if (Number.isFinite(at)) timed.push({ ...point, at });
  }
  return timed.sort((left, right) => left.at - right.at);
}

export interface ModelPerformanceRow {
  key: string;
  model: string;
  provider: string;
  requests: number;
  /** Time to first token in ms, averaged over requests. Null when no sample reports it. */
  avgTtft: number | null;
  /** Tokens per second, averaged over requests. Null when no sample reports it. */
  avgTokensPerSecond: number | null;
}

interface PerformanceAccumulator {
  model: string;
  provider: string;
  requests: number;
  ttftSum: number;
  ttftWeight: number;
  tpsSum: number;
  tpsWeight: number;
}

/**
 * Performance per model, one row for each provider and model pair. Each average is weighted by
 * requests and counts only the samples that report that metric, so a sample with no value never
 * pulls the average toward zero. Rows are ordered by key.
 */
export function modelPerformanceRows(
  points: readonly UsageStatsModelPerformancePoint[],
): ModelPerformanceRow[] {
  const groups = new Map<string, PerformanceAccumulator>();
  for (const point of points) {
    const key = JSON.stringify([point.provider, point.model]);
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        model: point.model,
        provider: point.provider,
        requests: 0,
        ttftSum: 0,
        ttftWeight: 0,
        tpsSum: 0,
        tpsWeight: 0,
      };
      groups.set(key, group);
    }
    group.requests += point.requests;
    // OMP leaves a timing average absent for an untimed model; such points are skipped, not counted as zero.
    const ttft = point.avgTtft;
    if (point.requests > 0 && ttft !== undefined && Number.isFinite(ttft)) {
      group.ttftSum += ttft * point.requests;
      group.ttftWeight += point.requests;
    }
    const tokensPerSecond = point.avgTokensPerSecond;
    if (point.requests > 0 && tokensPerSecond !== undefined && Number.isFinite(tokensPerSecond)) {
      group.tpsSum += tokensPerSecond * point.requests;
      group.tpsWeight += point.requests;
    }
  }
  return [...groups]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, group]) => ({
      key,
      model: group.model,
      provider: group.provider,
      requests: group.requests,
      avgTtft: group.ttftWeight > 0 ? group.ttftSum / group.ttftWeight : null,
      avgTokensPerSecond: group.tpsWeight > 0 ? group.tpsSum / group.tpsWeight : null,
    }));
}
