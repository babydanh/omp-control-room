/**
 * Geometry for one repo's git tree. Pure: the view measures its cards and passes their
 * boxes here; this module returns the SVG paths for the trunk, the forks that leave it
 * between cards, and the red conflict runs routed through the gutter on the right.
 *
 * Cards stack in one column. The trunk (origin/main) is the first card; each fork leaves
 * the trunk line at the seam above a branch card and curves into that card's left edge.
 */

import type { ConflictRef } from './ledgerSelection.js';

/** x of the trunk line, inside the left gutter. */
export const TRUNK_X = 14;
/** Left padding of the tree: the trunk line plus the run-up of the forks. */
export const TRUNK_GUTTER = 36;
/** Distance from the cards' right edge to the first conflict run. */
export const SLOT_OFFSET = 16;
/** Spacing between neighbouring conflict runs. */
export const SLOT_STEP = 10;
/** Room past the last run for the "N tệp xung đột" label column (desktop only). */
export const LABEL_GUTTER = 124;
/** Gap between the last run and the label column. */
const LABEL_INSET = 8;
/** Vertical room one conflict label needs; labels closer than this are pushed apart. */
const LABEL_HEIGHT = 22;
const CORNER = 8;
const JOIN_GAP = 4;

/** How many conflict runs side by side the gutter must hold: one more than the highest slot. */
export function slotCountOf(planned: readonly PlannedConflict[]): number {
  return planned.reduce((count, item) => Math.max(count, item.slot + 1), 0);
}

export interface TreeBox {
  readonly id: string;
  readonly top: number;
  readonly height: number;
  readonly left: number;
  readonly width: number;
}

export interface GraphPoint {
  readonly x: number;
  readonly y: number;
}

/** One conflict: two cards (or a card and main) whose files clash. */
export interface ConflictEdge {
  readonly id: string;
  readonly ref: ConflictRef;
  /** Node ids of the two ends. */
  readonly a: string;
  readonly b: string;
  readonly files: number;
}

export interface PlannedConflict extends ConflictEdge {
  /** The end that sits higher on the page, and the one below it. */
  readonly upper: string;
  readonly lower: string;
  readonly slot: number;
}

export interface TreeFork {
  readonly id: string;
  readonly path: string;
  readonly dot: GraphPoint;
}

export interface TreeRun {
  readonly edge: PlannedConflict;
  readonly path: string;
  readonly labelAt: GraphPoint;
}

export interface TreeShape {
  readonly trunkDot: GraphPoint | null;
  readonly trunkPath: string | null;
  readonly forks: readonly TreeFork[];
  readonly runs: readonly TreeRun[];
}

interface Span {
  readonly edge: ConflictEdge;
  readonly upperId: string;
  readonly lowerId: string;
  readonly from: number;
  readonly to: number;
}

/** Gives every conflict whose two ends are on the tree a slot, so runs never cross. */
export function planConflicts(
  order: readonly string[],
  edges: readonly ConflictEdge[],
): PlannedConflict[] {
  const position = new Map(order.map((id, index) => [id, index] as const));
  const spans: Span[] = [];
  for (const edge of edges) {
    const first = position.get(edge.a);
    const second = position.get(edge.b);
    if (first === undefined || second === undefined || first === second) continue;
    const upperFirst = first < second;
    spans.push({
      edge,
      upperId: upperFirst ? edge.a : edge.b,
      lowerId: upperFirst ? edge.b : edge.a,
      from: Math.min(first, second),
      to: Math.max(first, second),
    });
  }
  spans.sort((left, right) => left.from - right.from || left.to - right.to);

  const placed: { from: number; to: number; slot: number }[] = [];
  for (const span of spans) {
    let slot = 0;
    while (
      placed.some((other) => other.slot === slot && other.from <= span.to && span.from <= other.to)
    ) {
      slot += 1;
    }
    placed.push({ from: span.from, to: span.to, slot });
  }
  return spans.map((span, index) => ({
    ...span.edge,
    upper: span.upperId,
    lower: span.lowerId,
    slot: placed[index]?.slot ?? 0,
  }));
}

/** Width of the right gutter that holds the conflict runs (and their labels, if shown). */
export function connectorGutter(slotCount: number, withLabels: boolean): number {
  if (slotCount === 0) return 0;
  return SLOT_OFFSET + slotCount * SLOT_STEP + (withLabels ? LABEL_GUTTER : 0);
}

export function layoutTree(
  boxes: readonly TreeBox[],
  planned: readonly PlannedConflict[],
  trunkId: string | null,
): TreeShape {
  const byId = new Map(boxes.map((box) => [box.id, box] as const));
  const cardsRight = boxes.reduce((right, box) => Math.max(right, box.left + box.width), 0);

  const forks: TreeFork[] = [];
  let previousBottom: number | null = null;
  for (const box of boxes) {
    if (box.id === trunkId) {
      previousBottom = box.top + box.height;
      continue;
    }
    // Leave the trunk midway through the gap above this card.
    const seam = previousBottom === null ? centreOf(box) : (previousBottom + box.top) / 2;
    const middle = centreOf(box);
    const reach = (box.left - TRUNK_X) / 2;
    forks.push({
      id: box.id,
      path: `M ${TRUNK_X} ${seam} C ${TRUNK_X + reach} ${seam} ${box.left - reach} ${middle} ${box.left} ${middle}`,
      dot: { x: TRUNK_X, y: seam },
    });
    previousBottom = box.top + box.height;
  }

  const trunk = trunkId === null ? undefined : byId.get(trunkId);
  const trunkCentre = trunk === undefined ? null : centreOf(trunk);
  const lowestSeam = forks[forks.length - 1]?.dot.y ?? null;
  const trunkPath =
    trunkCentre === null || lowestSeam === null
      ? null
      : `M ${TRUNK_X} ${trunkCentre} V ${lowestSeam}`;

  // Labels form one column past the last run, each at its run's midpoint, pushed down
  // where they would overlap so they stay readable.
  const labelX = cardsRight + SLOT_OFFSET + slotCountOf(planned) * SLOT_STEP + LABEL_INSET;
  const drafts = planned.flatMap((conflict) => {
    const upper = byId.get(conflict.upper);
    const lower = byId.get(conflict.lower);
    if (upper === undefined || lower === undefined) return [];
    const runX = cardsRight + SLOT_OFFSET + conflict.slot * SLOT_STEP;
    const y1 = centreOf(upper);
    const y2 = centreOf(lower);
    const x1 = upper.left + upper.width + JOIN_GAP;
    const x2 = lower.left + lower.width + JOIN_GAP;
    const path = `M ${x1} ${y1} H ${runX - CORNER} Q ${runX} ${y1} ${runX} ${y1 + CORNER} V ${y2 - CORNER} Q ${runX} ${y2} ${runX - CORNER} ${y2} H ${x2}`;
    return [{ edge: conflict, path, labelY: (y1 + y2) / 2 }];
  });
  drafts.sort((left, right) => left.labelY - right.labelY);
  let floor = Number.NEGATIVE_INFINITY;
  const runs: TreeRun[] = drafts.map((draft) => {
    const y = Math.max(draft.labelY, floor);
    floor = y + LABEL_HEIGHT;
    return { edge: draft.edge, path: draft.path, labelAt: { x: labelX, y } };
  });

  return {
    trunkDot: trunkCentre === null ? null : { x: TRUNK_X, y: trunkCentre },
    trunkPath,
    forks,
    runs,
  };
}

/** True when two measurements describe the same boxes, so a re-measure can keep the old state. */
export function sameBoxes(left: readonly TreeBox[], right: readonly TreeBox[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((box, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      box.id === other.id &&
      box.top === other.top &&
      box.height === other.height &&
      box.left === other.left &&
      box.width === other.width
    );
  });
}

function centreOf(box: TreeBox): number {
  return box.top + box.height / 2;
}
