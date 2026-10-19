/**
 * laneLayout: which board lanes fold to a strip, and how wide each lane column
 * is. Pure, so the collapse rule is tested without a DOM.
 *
 * A lane with no cards is a narrow strip until its reader opens it. A lane with
 * cards is always open, so a card that lands in an empty lane opens that lane in
 * the same render, before the flight measures where the card came to rest.
 */

import {
  COMPANY_LANE_GAP_PX,
  COMPANY_LANE_MIN_WIDTH_PX,
  COMPANY_LANE_STRIP_WIDTH_PX,
  COMPANY_LANE_WIDTH_PX,
} from './constants.js';

/** A lane is a strip when it holds nothing and its reader has not opened it. */
export function isLaneCollapsed(count: number, opened: boolean): boolean {
  return count === 0 && !opened;
}

/**
 * The opened lanes that still hold no cards. A lane that fills is open anyway, so its opened
 * mark is dropped: when it empties again it folds to its strip, as a lane never opened does.
 * Returns the same set when nothing is dropped, so the caller can compare by reference.
 */
export function keepOpenEmptyLanes<Id extends string>(
  opened: ReadonlySet<Id>,
  counts: ReadonlyMap<Id, number>,
): ReadonlySet<Id> {
  const kept = new Set<Id>();
  for (const id of opened) {
    if ((counts.get(id) ?? 0) === 0) kept.add(id);
  }
  return kept.size === opened.size ? opened : kept;
}

/** One lane as the packer sees it. */
export interface LaneSlot {
  collapsed: boolean;
}

/**
 * How the lanes sit on the board: the lane indices on each row, and the width of
 * each lane column. `widths[i]` belongs to lane `i`; a strip is always the strip width.
 */
export interface LanePacking {
  rows: number[][];
  widths: number[];
}

/** The width a row's strips and gaps take up, for `count` lanes of which `strips` fold. */
function fixedWidth(count: number, strips: number): number {
  return strips * COMPANY_LANE_STRIP_WIDTH_PX + Math.max(0, count - 1) * COMPANY_LANE_GAP_PX;
}

/** Whether a row keeps every open lane at or above the minimum width. */
function rowFits(count: number, strips: number, open: number, available: number): boolean {
  const room = available - fixedWidth(count, strips);
  return open === 0 ? room >= 0 : Math.floor(room / open) >= COMPANY_LANE_MIN_WIDTH_PX;
}

/**
 * Packs lanes into rows that fit `availableWidth` without a horizontal scroll. Open
 * lanes share the row's room, at most COMPANY_LANE_WIDTH_PX each and never below
 * COMPANY_LANE_MIN_WIDTH_PX; a lane that would push its row below that minimum starts
 * another row. A lane alone on its row takes what the row has.
 */
export function packLanes(slots: readonly LaneSlot[], availableWidth: number): LanePacking {
  const available = Math.max(0, Math.floor(availableWidth));
  const isStrip = (index: number): boolean => slots[index]?.collapsed === true;
  const rows: number[][] = [];
  let current: number[] = [];
  let strips = 0;
  let open = 0;
  slots.forEach((_slot, index) => {
    const nextStrips = strips + (isStrip(index) ? 1 : 0);
    const nextOpen = open + (isStrip(index) ? 0 : 1);
    if (current.length > 0 && !rowFits(current.length + 1, nextStrips, nextOpen, available)) {
      rows.push(current);
      current = [];
      strips = 0;
      open = 0;
    }
    current.push(index);
    strips += isStrip(index) ? 1 : 0;
    open += isStrip(index) ? 0 : 1;
  });
  if (current.length > 0) rows.push(current);

  const widths = slots.map((_slot, index): number =>
    isStrip(index) ? COMPANY_LANE_STRIP_WIDTH_PX : COMPANY_LANE_WIDTH_PX,
  );
  for (const row of rows) {
    const rowStrips = row.filter(isStrip).length;
    const rowOpen = row.length - rowStrips;
    if (rowOpen === 0) continue;
    const share = Math.floor((available - fixedWidth(row.length, rowStrips)) / rowOpen);
    const width = Math.min(COMPANY_LANE_WIDTH_PX, Math.max(1, share));
    for (const index of row) {
      if (!isStrip(index)) widths[index] = width;
    }
  }
  return { rows, widths };
}
