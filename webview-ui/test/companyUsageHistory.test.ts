import { describe, expect, it } from 'vitest';

import type { UsageHistoryEntry } from '../../core/src/messages.js';
import {
  buildHistorySeries,
  downsampleSeries,
  type HistoryPoint,
  nearestPoint,
  seriesPath,
} from '../src/company/usage/usageHistory.js';

const MINUTE = 60_000;
const T0 = Date.parse('2026-10-19T00:00:00.000Z');

function at(minutes: number): string {
  return new Date(T0 + minutes * MINUTE).toISOString();
}

function entry(overrides: Partial<UsageHistoryEntry> = {}): UsageHistoryEntry {
  return {
    recordedAt: at(0),
    provider: 'anthropic',
    accountKey: 'acc-1',
    limitId: '5h',
    label: '5 giờ',
    usedFraction: 0.1,
    ...overrides,
  };
}

function point(minutes: number, usedFraction: number): HistoryPoint {
  return { at: T0 + minutes * MINUTE, usedFraction, resetAt: null, reset: false };
}

describe('buildHistorySeries', () => {
  it('keeps only samples at or after sinceMs', () => {
    const series = buildHistorySeries(
      [
        entry({ recordedAt: at(-10), usedFraction: 0.1 }),
        entry({ recordedAt: at(0), usedFraction: 0.2 }),
        entry({ recordedAt: at(10), usedFraction: 0.3 }),
      ],
      T0,
    );
    expect(series).toHaveLength(1);
    expect(series[0].points.map((p) => p.usedFraction)).toEqual([0.2, 0.3]);
  });

  it('groups samples by account and limit, ordered by account then limit', () => {
    const series = buildHistorySeries(
      [
        entry({ accountKey: 'b', limitId: '5h' }),
        entry({ accountKey: 'a', limitId: '7d' }),
        entry({ accountKey: 'a', limitId: '5h' }),
      ],
      T0,
    );
    expect(series.map((s) => [s.accountKey, s.limitId])).toEqual([
      ['a', '5h'],
      ['a', '7d'],
      ['b', '5h'],
    ]);
  });

  it('orders each series by time whatever the input order', () => {
    const [only] = buildHistorySeries(
      [
        entry({ recordedAt: at(10), usedFraction: 0.3 }),
        entry({ recordedAt: at(0), usedFraction: 0.1 }),
        entry({ recordedAt: at(5), usedFraction: 0.2 }),
      ],
      T0,
    );
    expect(only.points.map((p) => p.at)).toEqual([T0, T0 + 5 * MINUTE, T0 + 10 * MINUTE]);
    expect(only.points.map((p) => p.usedFraction)).toEqual([0.1, 0.2, 0.3]);
  });

  it('marks a point where the window reset to a new reset time', () => {
    const [only] = buildHistorySeries(
      [
        entry({ recordedAt: at(0), resetAt: at(60) }),
        entry({ recordedAt: at(5), resetAt: at(60) }),
        entry({ recordedAt: at(10), resetAt: at(120) }),
      ],
      T0,
    );
    expect(only.points.map((p) => p.reset)).toEqual([false, false, true]);
    expect(only.points.map((p) => p.resetAt)).toEqual([
      T0 + 60 * MINUTE,
      T0 + 60 * MINUTE,
      T0 + 120 * MINUTE,
    ]);
  });

  it('counts a reset time appearing or disappearing as a change', () => {
    const [only] = buildHistorySeries(
      [
        entry({ recordedAt: at(0) }),
        entry({ recordedAt: at(5), resetAt: at(60) }),
        entry({ recordedAt: at(10) }),
      ],
      T0,
    );
    expect(only.points.map((p) => p.reset)).toEqual([false, true, true]);
    expect(only.points.map((p) => p.resetAt)).toEqual([null, T0 + 60 * MINUTE, null]);
  });

  it('takes the label from the newest sample', () => {
    const [only] = buildHistorySeries(
      [
        entry({ recordedAt: at(0), label: 'cũ' }),
        entry({ recordedAt: at(10), label: 'mới' }),
        entry({ recordedAt: at(5), label: 'giữa' }),
      ],
      T0,
    );
    expect(only.label).toBe('mới');
    expect(only.windowLabel).toBeNull();
    expect(only.email).toBeNull();
  });

  it('leaves out samples whose time or share cannot be read', () => {
    const [only] = buildHistorySeries(
      [
        entry({ recordedAt: 'không phải ngày' }),
        entry({ recordedAt: at(0), usedFraction: Number.NaN }),
        entry({ recordedAt: at(5), usedFraction: 0.4 }),
      ],
      T0,
    );
    expect(only.points.map((p) => p.usedFraction)).toEqual([0.4]);
  });

  it('returns no series for no samples', () => {
    expect(buildHistorySeries([], T0)).toEqual([]);
  });
});

describe('downsampleSeries', () => {
  const values = [0.1, 0.5, 0.3, 0.9, 0.2, 0.05, 0.6, 0.4, 0.7, 0.8];
  const series = values.map((value, index) => point(index, value));

  it('keeps the lowest and highest sample of each bucket', () => {
    const kept = downsampleSeries(series, 4);
    expect(kept.map((p) => p.usedFraction)).toEqual([0.1, 0.9, 0.05, 0.8]);
  });

  it('keeps every reset, even when it is neither a low nor a high', () => {
    const withReset = series.map((p, index) => (index === 7 ? { ...p, reset: true } : p));
    const kept = downsampleSeries(withReset, 4);
    expect(kept.map((p) => p.usedFraction)).toEqual([0.1, 0.9, 0.05, 0.4, 0.8]);
  });

  it('keeps both ends so the latest sample is never lost', () => {
    const flat = [0.5, 0.1, 0.9, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.2].map((value, index) =>
      point(index, value),
    );
    const kept = downsampleSeries(flat, 4);
    expect(kept.map((p) => p.at)).toEqual([
      T0,
      T0 + MINUTE,
      T0 + 2 * MINUTE,
      T0 + 5 * MINUTE,
      T0 + 9 * MINUTE,
    ]);
  });

  it('returns a copy of a series already within the limit', () => {
    const kept = downsampleSeries(series, 10);
    expect(kept).toEqual(series);
    expect(kept).not.toBe(series);
  });
});

describe('seriesPath', () => {
  const box = { width: 100, height: 50 };

  it('is empty for no points', () => {
    expect(seriesPath([], box)).toBe('');
  });

  it('maps time to x across the box and the share to y from the bottom', () => {
    expect(seriesPath([point(0, 0.5), point(10, 1)], box)).toBe('M0 25 L100 0');
  });

  it('scales the y axis to a share above 100% so the peak stays in the box', () => {
    expect(seriesPath([point(0, 0.5), point(10, 2)], box)).toBe('M0 37.5 L100 0');
  });

  it('draws a flat line along the bottom when every share is zero', () => {
    expect(seriesPath([point(0, 0), point(5, 0), point(10, 0)], box)).toBe('M0 50 L50 50 L100 50');
  });

  it('draws a single sample at the left edge', () => {
    expect(seriesPath([point(0, 0.5)], box)).toBe('M0 25');
  });
});

describe('nearestPoint', () => {
  const points = [point(0, 0.1), point(10, 0.2), point(20, 0.3)];

  it('is undefined for no points', () => {
    expect(nearestPoint([], 0.5)).toBeUndefined();
  });

  it('finds the sample nearest to the ratio across the span', () => {
    expect(nearestPoint(points, 0.4)?.usedFraction).toBe(0.2);
    expect(nearestPoint(points, 0)?.usedFraction).toBe(0.1);
    expect(nearestPoint(points, 1)?.usedFraction).toBe(0.3);
  });

  it('breaks a tie toward the earlier sample', () => {
    expect(nearestPoint(points, 0.25)?.usedFraction).toBe(0.1);
  });

  it('is undefined for a ratio that is not finite', () => {
    expect(nearestPoint(points, Number.NaN)).toBeUndefined();
    expect(nearestPoint(points, Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it('returns the only sample for any ratio', () => {
    expect(nearestPoint([point(0, 0.7)], 0.9)?.usedFraction).toBe(0.7);
  });
});
