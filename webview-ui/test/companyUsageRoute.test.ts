import { describe, expect, it } from 'vitest';

import {
  boardRouteHref,
  DEFAULT_USAGE_TAB,
  isUsageRoute,
  isUsageTab,
  resolveUsageTab,
  USAGE_HASH,
  usageRouteHref,
  usageTabFromHash,
} from '../src/company/usage/usageRoute.js';

describe('USAGE_HASH', () => {
  it('is the usage page hash', () => {
    expect(USAGE_HASH).toBe('#usage');
  });
});

describe('isUsageRoute', () => {
  it('opens the usage page for the hash, with or without one trailing slash', () => {
    expect(isUsageRoute('#usage')).toBe(true);
    expect(isUsageRoute('#usage/')).toBe(true);
  });

  it('opens the usage page for each of its tabs', () => {
    expect(isUsageRoute('#usage/overview')).toBe(true);
    expect(isUsageRoute('#usage/limits')).toBe(true);
    expect(isUsageRoute('#usage/details')).toBe(true);
  });

  it('does not open the usage page for any other hash', () => {
    expect(isUsageRoute('')).toBe(false);
    expect(isUsageRoute('#')).toBe(false);
    expect(isUsageRoute('#Usage')).toBe(false);
    expect(isUsageRoute('#usage/x')).toBe(false);
    expect(isUsageRoute('#usages')).toBe(false);
    expect(isUsageRoute('usage')).toBe(false);
  });
});

describe('isUsageTab', () => {
  it('accepts the three tabs and nothing else', () => {
    expect(isUsageTab('overview')).toBe(true);
    expect(isUsageTab('limits')).toBe(true);
    expect(isUsageTab('details')).toBe(true);
    expect(isUsageTab('x')).toBe(false);
    expect(isUsageTab(null)).toBe(false);
    expect(isUsageTab(1)).toBe(false);
  });
});

describe('usageTabFromHash', () => {
  it('reads the tab a hash names', () => {
    expect(usageTabFromHash('#usage/limits')).toBe('limits');
  });

  it('names no tab for the bare page, an empty tab, or an unknown one', () => {
    expect(usageTabFromHash('#usage')).toBeNull();
    expect(usageTabFromHash('#usage/')).toBeNull();
    expect(usageTabFromHash('#usage/x')).toBeNull();
    expect(usageTabFromHash('#usages/limits')).toBeNull();
  });
});

describe('resolveUsageTab', () => {
  it('shows the tab the hash names over a remembered one', () => {
    expect(resolveUsageTab('#usage/details', 'limits')).toBe('details');
  });

  it('shows the remembered tab on the bare hash', () => {
    expect(resolveUsageTab('#usage', 'limits')).toBe('limits');
  });

  it('shows the default tab when nothing is remembered', () => {
    expect(resolveUsageTab('#usage', null)).toBe(DEFAULT_USAGE_TAB);
    expect(DEFAULT_USAGE_TAB).toBe('overview');
  });
});

describe('usageRouteHref', () => {
  it('adds the usage hash and keeps the path and every search parameter', () => {
    expect(usageRouteHref('http://127.0.0.1:3000/board?token=abc&x=1')).toBe(
      'http://127.0.0.1:3000/board?token=abc&x=1#usage',
    );
  });

  it('replaces an existing hash rather than stacking one', () => {
    expect(usageRouteHref('http://127.0.0.1:3000/board?token=abc#other')).toBe(
      'http://127.0.0.1:3000/board?token=abc#usage',
    );
  });

  it('adds the hash to an address with no query', () => {
    expect(usageRouteHref('http://127.0.0.1:3000/')).toBe('http://127.0.0.1:3000/#usage');
  });

  it('adds a tab after the hash, replacing any earlier tab', () => {
    expect(usageRouteHref('http://127.0.0.1:3000/board?token=abc#usage/overview', 'limits')).toBe(
      'http://127.0.0.1:3000/board?token=abc#usage/limits',
    );
  });
});

describe('boardRouteHref', () => {
  it('removes the usage hash and keeps the path and every search parameter', () => {
    expect(boardRouteHref('http://127.0.0.1:3000/board?token=abc&x=1#usage')).toBe(
      'http://127.0.0.1:3000/board?token=abc&x=1',
    );
    expect(boardRouteHref('http://127.0.0.1:3000/board#usage/')).toBe(
      'http://127.0.0.1:3000/board',
    );
  });

  it('removes a usage tab with the hash', () => {
    expect(boardRouteHref('http://127.0.0.1:3000/board#usage/details')).toBe(
      'http://127.0.0.1:3000/board',
    );
  });

  it('leaves every other hash in place', () => {
    expect(boardRouteHref('http://127.0.0.1:3000/board?token=abc#other')).toBe(
      'http://127.0.0.1:3000/board?token=abc#other',
    );
  });

  it('leaves an address with no hash unchanged', () => {
    expect(boardRouteHref('http://127.0.0.1:3000/board?token=abc')).toBe(
      'http://127.0.0.1:3000/board?token=abc',
    );
  });

  it('undoes usageRouteHref', () => {
    const board = 'http://127.0.0.1:3000/board?token=abc';
    expect(boardRouteHref(usageRouteHref(board))).toBe(board);
    expect(boardRouteHref(usageRouteHref(board, 'limits'))).toBe(board);
  });
});
