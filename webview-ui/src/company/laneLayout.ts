/**
 * laneLayout: how the board's lanes sit in rows. Pure, so the packing is tested
 * without a DOM.
 *
 * Every lane is open, empty or not. The lanes fill the board's width; when a row
 * would push a lane below COMPANY_LANE_MIN_WIDTH_PX the lanes wrap onto more rows,
 * balanced so no row is left with one lonely lane, and every lane keeps the same
 * width so the rows line up as a grid.
 */

import { COMPANY_LANE_GAP_PX, COMPANY_LANE_MIN_WIDTH_PX } from './constants.js';

/** The lane indices on each row, and the one width every lane column takes. */
export interface LanePacking {
  rows: number[][];
  width: number;
}

export function packLanes(count: number, availableWidth: number): LanePacking {
  const available = Math.max(0, Math.floor(availableWidth));
  if (count <= 0) return { rows: [], width: 0 };
  const fitting = Math.floor(
    (available + COMPANY_LANE_GAP_PX) / (COMPANY_LANE_MIN_WIDTH_PX + COMPANY_LANE_GAP_PX),
  );
  const rowCount = Math.ceil(count / Math.max(1, Math.min(count, fitting)));
  // Rows differ by at most one lane: the first `count % rowCount` rows take one extra.
  const perRow = Math.ceil(count / rowCount);
  const shorter = Math.floor(count / rowCount);
  const rows: number[][] = [];
  let next = 0;
  for (let row = 0; row < rowCount; row += 1) {
    const length = row < count % rowCount ? shorter + 1 : shorter;
    rows.push(Array.from({ length }, (_, i) => next + i));
    next += length;
  }
  const width = Math.max(1, Math.floor((available - (perRow - 1) * COMPANY_LANE_GAP_PX) / perRow));
  return { rows, width };
}
