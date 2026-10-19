import { describe, expect, it } from 'vitest';

import {
  COMPANY_LANE_GAP_PX,
  COMPANY_LANE_MIN_WIDTH_PX,
  COMPANY_LANE_STRIP_WIDTH_PX,
  COMPANY_LANE_WIDTH_PX,
  COMPANY_MOTION,
} from '../src/company/constants.js';
import { isLaneCollapsed, packLanes } from '../src/company/laneLayout.js';

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

describe('packLanes', () => {
  it('keeps open lanes at full width on one row when they fit', () => {
    const slots = [{ collapsed: false }, { collapsed: false }, { collapsed: false }];
    expect(packLanes(slots, 1000)).toEqual({
      rows: [[0, 1, 2]],
      widths: [COMPANY_LANE_WIDTH_PX, COMPANY_LANE_WIDTH_PX, COMPANY_LANE_WIDTH_PX],
    });
  });

  it('shrinks open lanes evenly down to the minimum before wrapping', () => {
    const slots = [{ collapsed: false }, { collapsed: false }, { collapsed: false }];
    const exact = 3 * COMPANY_LANE_MIN_WIDTH_PX + 2 * COMPANY_LANE_GAP_PX;
    expect(packLanes(slots, exact)).toEqual({
      rows: [[0, 1, 2]],
      widths: [COMPANY_LANE_MIN_WIDTH_PX, COMPANY_LANE_MIN_WIDTH_PX, COMPANY_LANE_MIN_WIDTH_PX],
    });
  });

  it('starts a second row instead of pushing an open lane below the minimum', () => {
    const slots = [0, 1, 2, 3].map(() => ({ collapsed: false }));
    const packing = packLanes(slots, 700);
    expect(packing.rows).toEqual([[0, 1, 2], [3]]);
    expect(packing.widths[0]).toBe(packing.widths[1]);
    expect(packing.widths[0]).toBeGreaterThanOrEqual(COMPANY_LANE_MIN_WIDTH_PX);
    expect(packing.widths[3]).toBe(COMPANY_LANE_WIDTH_PX);
  });

  it('folds empty lanes to strips that keep their 40px and leave the rest to open lanes', () => {
    const slots = [{ collapsed: true }, { collapsed: false }, { collapsed: false }];
    expect(packLanes(slots, 500)).toEqual({
      rows: [[0, 1, 2]],
      widths: [COMPANY_LANE_STRIP_WIDTH_PX, 224, 224],
    });
  });

  it('wraps strips onto a new row once the open lanes have claimed the minimum', () => {
    const slots = [
      { collapsed: false },
      { collapsed: true },
      { collapsed: true },
      { collapsed: false },
      { collapsed: true },
      { collapsed: true },
      { collapsed: true },
    ];
    const packing = packLanes(slots, 588);
    expect(packing.rows).toEqual([
      [0, 1, 2, 3, 4],
      [5, 6],
    ]);
    expect(packing.widths).toEqual([222, 40, 40, 222, 40, 40, 40]);
  });

  it('lets a lane alone on its row take what a narrow board has', () => {
    expect(packLanes([{ collapsed: false }], 150)).toEqual({ rows: [[0]], widths: [150] });
  });

  it('returns no rows for no lanes', () => {
    expect(packLanes([], 800)).toEqual({ rows: [], widths: [] });
  });

  it('never packs a row wider than the space it was given', () => {
    const patterns = [
      [false, false, false, false, false, false, false],
      [true, false, true, false, true, false, true],
      [false, true, true, true, true, true, false],
    ].map((pattern) => pattern.map((collapsed) => ({ collapsed })));
    for (const slots of patterns) {
      for (let available = 300; available <= 1400; available += 50) {
        const packing = packLanes(slots, available);
        for (const row of packing.rows) {
          const used = row.reduce((sum, index) => sum + (packing.widths[index] ?? 0), 0);
          expect(used + (row.length - 1) * COMPANY_LANE_GAP_PX).toBeLessThanOrEqual(available);
        }
      }
    }
  });
});

describe('lane motion timing', () => {
  it('eases the lane width over 420ms and fades the lane body over 240ms', () => {
    expect(COMPANY_MOTION.laneWidthMs).toBe(420);
    expect(COMPANY_MOTION.laneContentMs).toBe(240);
  });

  it('keeps the body fade shorter than the width ease it follows or precedes', () => {
    expect(COMPANY_MOTION.laneContentMs).toBeLessThan(COMPANY_MOTION.laneWidthMs);
  });
});
