/**
 * laneLayout: which board lanes fold to a strip, and how wide each lane column
 * is. Pure, so the collapse rule is tested without a DOM.
 *
 * A lane with no cards is a narrow strip until its reader opens it. A lane with
 * cards is always open, so a card that lands in an empty lane opens that lane in
 * the same render, before the flight measures where the card came to rest.
 */

import { COMPANY_LANE_MIN_WIDTH_PX, COMPANY_LANE_STRIP_WIDTH_PX } from './constants.js';

/** One lane column's flex share and floor, as CSS for the lanes row. */
export interface LaneColumnStyle {
  flex: string;
  minWidth: number;
}

/** A lane is a strip when it holds nothing and its reader has not opened it. */
export function isLaneCollapsed(count: number, opened: boolean): boolean {
  return count === 0 && !opened;
}

/**
 * A strip keeps a fixed width. An open lane takes an equal share of the row's
 * remaining width and never shrinks below its minimum, so the row scrolls
 * sideways rather than squeezing a lane.
 */
export function laneColumnStyle(collapsed: boolean): LaneColumnStyle {
  return collapsed
    ? { flex: `0 0 ${COMPANY_LANE_STRIP_WIDTH_PX}px`, minWidth: COMPANY_LANE_STRIP_WIDTH_PX }
    : { flex: '1 1 0', minWidth: COMPANY_LANE_MIN_WIDTH_PX };
}
