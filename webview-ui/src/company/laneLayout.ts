/**
 * laneLayout: which board lanes fold to a strip, and how wide each lane column
 * is. Pure, so the collapse rule is tested without a DOM.
 *
 * A lane with no cards is a narrow strip until its reader opens it. A lane with
 * cards is always open, so a card that lands in an empty lane opens that lane in
 * the same render, before the flight measures where the card came to rest.
 */

import { COMPANY_LANE_STRIP_WIDTH_PX, COMPANY_LANE_WIDTH_PX } from './constants.js';

/** One lane column's width and flex rule, as CSS for the lanes row. */
export interface LaneColumnStyle {
  flex: string;
  width: number;
}

/** A lane is a strip when it holds nothing and its reader has not opened it. */
export function isLaneCollapsed(count: number, opened: boolean): boolean {
  return count === 0 && !opened;
}

/**
 * A lane column never stretches. A strip and an open lane each keep their own
 * fixed width; spare width stays empty on the row's right.
 */
export function laneColumnStyle(collapsed: boolean): LaneColumnStyle {
  const width = collapsed ? COMPANY_LANE_STRIP_WIDTH_PX : COMPANY_LANE_WIDTH_PX;
  return { flex: `0 0 ${width}px`, width };
}
