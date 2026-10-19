import { describe, expect, it } from 'vitest';

import type {
  UsageStatsCostPoint,
  UsageStatsModelPerformancePoint,
  UsageStatsTotals,
} from '../../core/src/messages.js';
import {
  cacheRateLabel,
  costBreakdown,
  costLabel,
  modelPerformanceRows,
  sortRows,
  timeSeriesPoints,
  tokenSum,
} from '../src/company/usage/usageStats.js';

function totals(overrides: Partial<UsageStatsTotals> = {}): UsageStatsTotals {
  return {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    errorRate: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    cacheRate: 0,
    cacheSavings: 0,
    totalCost: 0,
    unpricedRequests: 0,
    totalPremiumRequests: 0,
    avgDuration: 0,
    avgTtft: 0,
    avgTokensPerSecond: 0,
    ...overrides,
  };
}

function costPoint(overrides: Partial<UsageStatsCostPoint> = {}): UsageStatsCostPoint {
  return {
    timestamp: '2026-10-19T00:00:00.000Z',
    model: 'm1',
    provider: 'p',
    cost: 0,
    costInput: 0,
    costOutput: 0,
    costCacheRead: 0,
    costCacheWrite: 0,
    requests: 0,
    unpricedRequests: 0,
    ...overrides,
  };
}

function performancePoint(
  overrides: Partial<UsageStatsModelPerformancePoint> = {},
): UsageStatsModelPerformancePoint {
  return {
    timestamp: '2026-10-19T00:00:00.000Z',
    model: 'm1',
    provider: 'p',
    requests: 1,
    avgTtft: 0,
    avgTokensPerSecond: 0,
    ...overrides,
  };
}

describe('costBreakdown', () => {
  it('sums each kind and the reported total across points', () => {
    const breakdown = costBreakdown([
      costPoint({ cost: 4, costInput: 1, costOutput: 1, costCacheRead: 1, costCacheWrite: 1 }),
      costPoint({ cost: 3, costInput: 1 }),
    ]);
    expect(breakdown).toEqual({ input: 2, output: 1, cacheRead: 1, cacheWrite: 1, total: 7 });
  });

  it('leaves a cost with no split unattributed rather than spreading it', () => {
    const breakdown = costBreakdown([costPoint({ cost: 4, costInput: 1 })]);
    const parts = breakdown.input + breakdown.output + breakdown.cacheRead + breakdown.cacheWrite;
    expect(breakdown.total).toBe(4);
    expect(parts).toBe(1);
  });

  it('is all zero for no points', () => {
    expect(costBreakdown([])).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    });
  });
});

describe('costLabel', () => {
  it('says a cost is not yet priced when no request has a price', () => {
    expect(costLabel(totals({ totalCost: 0, unpricedRequests: 3 }))).toBe('chưa có giá');
  });

  it('shows a priced zero as a zero cost', () => {
    expect(costLabel(totals({ totalCost: 0, unpricedRequests: 0 }))).toBe('$0,00');
  });

  it('names the unpriced requests beside a partial cost', () => {
    expect(costLabel(totals({ totalCost: 1.5, unpricedRequests: 2 }))).toBe(
      '$1,50 · 2 yêu cầu chưa có giá',
    );
  });

  it('shows a fully priced cost in full', () => {
    expect(costLabel(totals({ totalCost: 1234.5, unpricedRequests: 0 }))).toBe('$1.234,50');
  });
});

describe('cacheRateLabel', () => {
  it('shows the cache share over input, cache read and cache write tokens', () => {
    expect(
      cacheRateLabel(
        totals({ totalInputTokens: 100, totalCacheReadTokens: 300, totalCacheWriteTokens: 100 }),
      ),
    ).toBe('60% từ cache · tính trên 500 token đầu vào và cache');
  });

  it('says there is nothing to rate when no token has been counted', () => {
    expect(cacheRateLabel(totals())).toBe('Chưa có token để tính tỷ lệ');
  });
});

describe('tokenSum', () => {
  it('adds the four token fields', () => {
    expect(
      tokenSum(
        totals({
          totalInputTokens: 1,
          totalOutputTokens: 2,
          totalCacheReadTokens: 3,
          totalCacheWriteTokens: 4,
        }),
      ),
    ).toBe(10);
  });
});

describe('sortRows', () => {
  interface Row {
    name: string;
    n: number | null;
  }

  const rows: Row[] = [
    { name: 'b', n: 2 },
    { name: 'a', n: null },
    { name: 'c', n: 1 },
    { name: 'd', n: 2 },
  ];

  function access(row: Row, key: string): number | string | null {
    return key === 'name' ? row.name : row.n;
  }

  it('sorts ascending with missing values last and ties in input order', () => {
    expect(sortRows(rows, 'n', 'asc', access).map((row) => row.name)).toEqual(['c', 'b', 'd', 'a']);
  });

  it('sorts descending with missing values still last and ties in input order', () => {
    expect(sortRows(rows, 'n', 'desc', access).map((row) => row.name)).toEqual([
      'b',
      'd',
      'c',
      'a',
    ]);
  });

  it('sorts text by code unit', () => {
    expect(sortRows(rows, 'name', 'asc', access).map((row) => row.name)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('treats a NaN as missing', () => {
    const withNaN: Row[] = [
      { name: 'x', n: Number.NaN },
      { name: 'y', n: 5 },
    ];
    expect(sortRows(withNaN, 'n', 'asc', access).map((row) => row.name)).toEqual(['y', 'x']);
  });

  it('returns a sorted copy and never changes the input', () => {
    const before = rows.map((row) => row.name);
    const sorted = sortRows(rows, 'n', 'asc', access);
    expect(sorted).not.toBe(rows);
    expect(rows.map((row) => row.name)).toEqual(before);
  });
});

describe('timeSeriesPoints', () => {
  it('orders points by time and reads each timestamp as epoch milliseconds', () => {
    const points = timeSeriesPoints([
      { timestamp: '2026-10-19T01:00:00.000Z', cost: 1 },
      { timestamp: '2026-10-19T00:00:00.000Z', cost: 2 },
    ]);
    expect(points.map((point) => point.cost)).toEqual([2, 1]);
    expect(points[0].at).toBe(Date.parse('2026-10-19T00:00:00.000Z'));
    expect(points[1].at).toBe(Date.parse('2026-10-19T01:00:00.000Z'));
  });

  it('keeps the point fields it was given', () => {
    const [only] = timeSeriesPoints([{ timestamp: '2026-10-19T00:00:00.000Z', cost: 7 }]);
    expect(only.timestamp).toBe('2026-10-19T00:00:00.000Z');
  });

  it('leaves out a point whose timestamp cannot be read', () => {
    const points = timeSeriesPoints([
      { timestamp: 'không phải ngày', cost: 3 },
      { timestamp: '2026-10-19T00:00:00.000Z', cost: 2 },
    ]);
    expect(points.map((point) => point.cost)).toEqual([2]);
  });
});

describe('modelPerformanceRows', () => {
  it('averages each metric weighted by requests', () => {
    const rows = modelPerformanceRows([
      performancePoint({ requests: 1, avgTtft: 100, avgTokensPerSecond: 10 }),
      performancePoint({ requests: 3, avgTtft: 200, avgTokensPerSecond: 30 }),
    ]);
    expect(rows).toEqual([
      {
        key: JSON.stringify(['p', 'm1']),
        model: 'm1',
        provider: 'p',
        requests: 4,
        avgTtft: 175,
        avgTokensPerSecond: 25,
      },
    ]);
  });

  it('reads a model with no requests as having no average, not a zero one', () => {
    const [row] = modelPerformanceRows([
      performancePoint({ model: 'm2', requests: 0, avgTtft: 50, avgTokensPerSecond: 5 }),
    ]);
    expect(row.requests).toBe(0);
    expect(row.avgTtft).toBeNull();
    expect(row.avgTokensPerSecond).toBeNull();
  });

  it('leaves a metric out of the average when a sample reports it as NaN', () => {
    const [row] = modelPerformanceRows([
      performancePoint({ model: 'm3', requests: 2, avgTtft: 80, avgTokensPerSecond: Number.NaN }),
    ]);
    expect(row.avgTtft).toBe(80);
    expect(row.avgTokensPerSecond).toBeNull();
  });

  it('groups by provider and model together, so one model name under two providers is two rows', () => {
    const rows = modelPerformanceRows([
      performancePoint({ provider: 'p', model: 'm1', requests: 1 }),
      performancePoint({ provider: 'q', model: 'm1', requests: 1 }),
    ]);
    expect(rows.map((row) => row.key)).toEqual([
      JSON.stringify(['p', 'm1']),
      JSON.stringify(['q', 'm1']),
    ]);
  });

  it('orders rows by key', () => {
    const rows = modelPerformanceRows([
      performancePoint({ model: 'm2', requests: 1 }),
      performancePoint({ model: 'm1', requests: 1 }),
    ]);
    expect(rows.map((row) => row.model)).toEqual(['m1', 'm2']);
  });
});
