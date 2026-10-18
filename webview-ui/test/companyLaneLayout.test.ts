import { describe, expect, it } from 'vitest';

import { isLaneCollapsed, laneColumnStyle } from '../src/company/laneLayout.js';

describe('isLaneCollapsed', () => {
  it('folds an empty lane its reader has not opened', () => {
    expect(isLaneCollapsed(0, false)).toBe(true);
  });

  it('keeps an empty lane open once its reader opens it', () => {
    expect(isLaneCollapsed(0, true)).toBe(false);
  });

  it('never folds a lane that holds cards, opened or not', () => {
    expect(isLaneCollapsed(1, false)).toBe(false);
    expect(isLaneCollapsed(3, true)).toBe(false);
  });
});

describe('laneColumnStyle', () => {
  it('gives a strip a fixed 40px column that does not grow', () => {
    expect(laneColumnStyle(true)).toEqual({ flex: '0 0 40px', minWidth: 40 });
  });

  it('shares the row among open lanes, each with a 220px floor', () => {
    expect(laneColumnStyle(false)).toEqual({ flex: '1 1 0', minWidth: 220 });
  });
});
