/**
 * usageHistory: the limit history as chart series.
 *
 * A series is one limit window of one account, read over time. Every value is a sample the
 * server recorded; nothing is interpolated. Points are in time order.
 */

import type { UsageHistoryEntry } from '../../../../core/src/messages.js';

export interface HistoryPoint {
  /** Epoch milliseconds of the sample. */
  at: number;
  usedFraction: number;
  /** Epoch milliseconds of the window's reset, or null when the sample names none. */
  resetAt: number | null;
  /** True where this sample's resetAt differs from the previous sample's: the window has reset. */
  reset: boolean;
}

export interface HistorySeries {
  key: string;
  provider: string;
  accountKey: string;
  email: string | null;
  limitId: string;
  /** The label from the newest sample. */
  label: string;
  windowLabel: string | null;
  points: HistoryPoint[];
}

export interface ChartBox {
  width: number;
  height: number;
}

interface Sample {
  at: number;
  entry: UsageHistoryEntry;
  usedFraction: number;
}

/** Epoch milliseconds of an optional ISO time, or null when it is absent or unreadable. */
function parseOptionalTime(iso: string | undefined): number | null {
  if (iso === undefined) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * The samples at or after `sinceMs`, grouped into one series per accountKey and limitId, each
 * in time order. A sample whose time or usedFraction cannot be read is left out, not zeroed.
 * Series are ordered by accountKey, then limitId.
 */
export function buildHistorySeries(
  entries: readonly UsageHistoryEntry[],
  sinceMs: number,
): HistorySeries[] {
  const groups = new Map<string, Sample[]>();
  for (const entry of entries) {
    const at = Date.parse(entry.recordedAt);
    // A limit that reports only a balance has no fraction, so it has no line to draw.
    const usedFraction = entry.usedFraction;
    if (
      !Number.isFinite(at) ||
      at < sinceMs ||
      usedFraction === undefined ||
      !Number.isFinite(usedFraction)
    )
      continue;
    const key = JSON.stringify([entry.accountKey, entry.limitId]);
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [{ at, entry, usedFraction }]);
    else bucket.push({ at, entry, usedFraction });
  }
  const series = [...groups].map(([key, samples]): HistorySeries => {
    // Array.prototype.sort is stable, so samples recorded at the same instant keep input order.
    const sorted = [...samples].sort((left, right) => left.at - right.at);
    const points: HistoryPoint[] = [];
    for (const { at, entry, usedFraction } of sorted) {
      const resetAt = parseOptionalTime(entry.resetAt);
      const previous = points[points.length - 1];
      points.push({
        at,
        usedFraction,
        resetAt,
        reset: previous !== undefined && resetAt !== previous.resetAt,
      });
    }
    const latest = sorted[sorted.length - 1].entry;
    return {
      key,
      provider: latest.provider,
      accountKey: latest.accountKey,
      email: latest.email ?? null,
      limitId: latest.limitId,
      label: latest.label,
      windowLabel: latest.windowLabel ?? null,
      points,
    };
  });
  return series.sort(
    (left, right) =>
      compareText(left.accountKey, right.accountKey) || compareText(left.limitId, right.limitId),
  );
}

/**
 * At most about `maxPoints` samples that keep the shape of the series: the lowest and highest
 * sample of each bucket of consecutive samples, every reset, and both ends. Time order is kept.
 * A series already within `maxPoints` comes back whole.
 */
export function downsampleSeries(
  points: readonly HistoryPoint[],
  maxPoints: number,
): HistoryPoint[] {
  if (points.length <= maxPoints) return [...points];
  const buckets = Math.max(1, Math.floor(maxPoints / 2));
  const keep = new Set<number>([0, points.length - 1]);
  points.forEach((point, index) => {
    if (point.reset) keep.add(index);
  });
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const start = Math.floor((bucket * points.length) / buckets);
    const end = Math.floor(((bucket + 1) * points.length) / buckets);
    let lowest = start;
    let highest = start;
    for (let index = start + 1; index < end; index += 1) {
      if (points[index].usedFraction < points[lowest].usedFraction) lowest = index;
      if (points[index].usedFraction > points[highest].usedFraction) highest = index;
    }
    keep.add(lowest);
    keep.add(highest);
  }
  return [...keep].sort((left, right) => left - right).map((index) => points[index]);
}

/**
 * The SVG path data for the used-fraction line. The x axis spans the first to the last sample;
 * the y axis is fixed at 0..max(1, the largest value), so 100% always sits at the top unless a
 * value is above it. Coordinates are rounded to two decimals. Empty for no points.
 */
export function seriesPath(points: readonly HistoryPoint[], box: ChartBox): string {
  if (points.length === 0) return '';
  const first = points[0].at;
  const span = points[points.length - 1].at - first;
  const yMax = points.reduce((max, point) => Math.max(max, point.usedFraction), 1);
  return points
    .map((point, index) => {
      const x = span > 0 ? ((point.at - first) / span) * box.width : 0;
      const value = Math.min(Math.max(point.usedFraction, 0), yMax);
      const y = box.height - (value / yMax) * box.height;
      const command = index === 0 ? 'M' : 'L';
      return `${command}${Math.round(x * 100) / 100} ${Math.round(y * 100) / 100}`;
    })
    .join(' ');
}

/**
 * The sample nearest to a point across the chart, where `xRatio` runs 0 at the first sample to 1
 * at the last. Undefined for no points or a non-finite ratio. A tie goes to the earlier sample.
 */
export function nearestPoint(
  points: readonly HistoryPoint[],
  xRatio: number,
): HistoryPoint | undefined {
  if (points.length === 0 || !Number.isFinite(xRatio)) return undefined;
  const first = points[0].at;
  const target = first + xRatio * (points[points.length - 1].at - first);
  let best = points[0];
  for (const point of points) {
    if (Math.abs(point.at - target) < Math.abs(best.at - target)) best = point;
  }
  return best;
}
