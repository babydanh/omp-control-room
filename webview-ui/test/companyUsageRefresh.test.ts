import { describe, expect, it } from 'vitest';

import {
  isRefreshDue,
  USAGE_LIMITS_REFRESH_MS,
  USAGE_STATS_REFRESH_MS,
} from '../src/company/usage/usageRefresh.js';

describe('refresh intervals', () => {
  it('refreshes limits every two minutes and history and stats every ten', () => {
    expect(USAGE_LIMITS_REFRESH_MS).toBe(120_000);
    expect(USAGE_STATS_REFRESH_MS).toBe(600_000);
  });
});

describe('isRefreshDue', () => {
  const now = 1_000_000;

  it('is always due for a page that has never loaded while visible', () => {
    expect(isRefreshDue(null, USAGE_LIMITS_REFRESH_MS, now, true)).toBe(true);
  });

  it('is never due while the page is hidden, even if it never loaded', () => {
    expect(isRefreshDue(null, USAGE_LIMITS_REFRESH_MS, now, false)).toBe(false);
    expect(
      isRefreshDue(now - USAGE_LIMITS_REFRESH_MS * 10, USAGE_LIMITS_REFRESH_MS, now, false),
    ).toBe(false);
  });

  it('is not due before the interval has passed', () => {
    expect(isRefreshDue(now - 1, USAGE_LIMITS_REFRESH_MS, now, true)).toBe(false);
  });

  it('is due exactly when the interval has passed', () => {
    expect(isRefreshDue(now - USAGE_LIMITS_REFRESH_MS, USAGE_LIMITS_REFRESH_MS, now, true)).toBe(
      true,
    );
  });

  it('is due after the interval has passed', () => {
    expect(isRefreshDue(now - USAGE_STATS_REFRESH_MS * 2, USAGE_STATS_REFRESH_MS, now, true)).toBe(
      true,
    );
  });
});
