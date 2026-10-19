import { describe, expect, it } from 'vitest';

import {
  boardRouteHref,
  isUsageRoute,
  USAGE_HASH,
  usageRouteHref,
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

  it('does not open the usage page for any other hash', () => {
    expect(isUsageRoute('')).toBe(false);
    expect(isUsageRoute('#')).toBe(false);
    expect(isUsageRoute('#Usage')).toBe(false);
    expect(isUsageRoute('#usage/x')).toBe(false);
    expect(isUsageRoute('#usages')).toBe(false);
    expect(isUsageRoute('usage')).toBe(false);
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
  });
});
