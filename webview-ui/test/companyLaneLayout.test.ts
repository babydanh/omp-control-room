import { describe, expect, it } from 'vitest';

import { COMPANY_LANE_GAP_PX, COMPANY_LANE_MIN_WIDTH_PX } from '../src/company/constants.js';
import { packLanes } from '../src/company/laneLayout.js';

describe('packLanes', () => {
  it('keeps every lane on one row, sharing the full width, when they all fit', () => {
    const packing = packLanes(7, 1500);
    expect(packing.rows).toEqual([[0, 1, 2, 3, 4, 5, 6]]);
    expect(packing.width).toBe(Math.floor((1500 - 6 * COMPANY_LANE_GAP_PX) / 7));
    expect(packing.width).toBeGreaterThanOrEqual(COMPANY_LANE_MIN_WIDTH_PX);
  });

  it('wraps onto a second row once a lane would drop below the minimum, balancing the rows', () => {
    // 1300px holds six 200px lanes, not seven: two rows of four and three, each lane 320px.
    expect(packLanes(7, 1300)).toEqual({
      rows: [
        [0, 1, 2, 3],
        [4, 5, 6],
      ],
      width: Math.floor((1300 - 3 * COMPANY_LANE_GAP_PX) / 4),
    });
  });

  it('keeps one lane per row on a board narrower than one minimum lane', () => {
    expect(packLanes(3, 150)).toEqual({ rows: [[0], [1], [2]], width: 150 });
  });

  it('returns no rows for no lanes', () => {
    expect(packLanes(0, 800)).toEqual({ rows: [], width: 0 });
  });

  it('places every lane once and never packs a row wider than the space it was given', () => {
    for (let count = 1; count <= 9; count += 1) {
      for (let available = 200; available <= 2000; available += 37) {
        const { rows, width } = packLanes(count, available);
        expect(rows.flat()).toEqual(Array.from({ length: count }, (_, i) => i));
        for (const row of rows) {
          expect(row.length * width + (row.length - 1) * COMPANY_LANE_GAP_PX).toBeLessThanOrEqual(
            available,
          );
        }
        // Balanced: no row is more than one lane shorter than the first.
        const first = rows[0]?.length ?? 0;
        for (const row of rows) expect(first - row.length).toBeLessThanOrEqual(1);
      }
    }
  });
});
