import { describe, expect, it } from 'vitest';

import {
  type ConflictEdge,
  connectorGutter,
  layoutTree,
  planConflicts,
  sameBoxes,
  slotCountOf,
  type TreeBox,
} from '../src/company/ledger/ledgerTreeLayout.js';

function edge(id: string, a: string, b: string): ConflictEdge {
  return { id, ref: { kind: 'pair', a, b }, a, b, files: 1 };
}

const TRUNK_BOX: TreeBox = { id: 'T', top: 0, height: 60, left: 40, width: 400 };
const BRANCH_BOX: TreeBox = { id: 'B', top: 100, height: 60, left: 40, width: 400 };

describe('planConflicts', () => {
  it('gives overlapping conflicts their own slots, so their runs never cross', () => {
    const order = ['T', 'a', 'b', 'c'];
    const planned = planConflicts(order, [
      edge('e2', 'T', 'c'),
      edge('e1', 'a', 'b'),
      edge('e3', 'a', 'c'),
    ]);
    const slots = Object.fromEntries(planned.map((item) => [item.id, item.slot]));
    expect(slots).toEqual({ e2: 0, e1: 1, e3: 2 });
    expect(slotCountOf(planned)).toBe(3);
  });

  it('reuses a slot for conflicts that do not overlap on the page', () => {
    const planned = planConflicts(['x', 'y', 'z', 'w'], [edge('p', 'x', 'y'), edge('q', 'z', 'w')]);
    expect(planned.map((item) => item.slot)).toEqual([0, 0]);
  });

  it('puts the end higher on the page first, and skips an end that is not on the tree', () => {
    const planned = planConflicts(['T', 'B'], [edge('up', 'B', 'T'), edge('gone', 'B', 'Z')]);
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({ id: 'up', upper: 'T', lower: 'B', slot: 0 });
  });
});

describe('connectorGutter', () => {
  it('needs no room when there are no conflicts, and room for labels only when they are shown', () => {
    expect(connectorGutter(0, true)).toBe(0);
    expect(connectorGutter(1, false)).toBe(26);
    expect(connectorGutter(1, true)).toBe(150);
  });
});

describe('layoutTree', () => {
  it('draws the trunk line down to the last fork, and each branch fork as an S-curve into its card', () => {
    const shape = layoutTree([TRUNK_BOX, BRANCH_BOX], [], 'T');
    expect(shape.trunkDot).toEqual({ x: 14, y: 30 });
    expect(shape.trunkPath).toBe('M 14 30 V 80');
    expect(shape.forks).toEqual([
      {
        id: 'B',
        path: 'M 14 80 C 27 80 27 130 40 130',
        dot: { x: 14, y: 80 },
      },
    ]);
    expect(shape.runs).toEqual([]);
  });

  it('routes a conflict run to the right of the cards, with its label past the last run', () => {
    const planned = planConflicts(['T', 'B'], [edge('c1', 'T', 'B')]);
    const shape = layoutTree([TRUNK_BOX, BRANCH_BOX], planned, 'T');
    expect(shape.runs).toHaveLength(1);
    const [run] = shape.runs;
    // Cards end at x=440; the run sits 16px past them, the label 8px past the last run.
    expect(run?.path.startsWith('M 444 30 H 448')).toBe(true);
    expect(run?.labelAt).toEqual({ x: 474, y: 80 });
  });

  it('pushes a conflict label down when another label would sit on top of it', () => {
    const planned = planConflicts(['T', 'B'], [edge('c1', 'T', 'B'), edge('c2', 'B', 'T')]);
    const shape = layoutTree([TRUNK_BOX, BRANCH_BOX], planned, 'T');
    expect(shape.runs.map((run) => run.labelAt.y)).toEqual([80, 102]);
  });

  it('draws no trunk line when there is no trunk card', () => {
    const shape = layoutTree([BRANCH_BOX], [], null);
    expect(shape.trunkDot).toBeNull();
    expect(shape.trunkPath).toBeNull();
    expect(shape.forks).toHaveLength(1);
  });
});

describe('sameBoxes', () => {
  it('matches boxes that are identical in id and geometry, and nothing else', () => {
    const boxes = [TRUNK_BOX, BRANCH_BOX];
    expect(
      sameBoxes(
        boxes,
        boxes.map((box) => ({ ...box })),
      ),
    ).toBe(true);
    expect(sameBoxes(boxes, [{ ...TRUNK_BOX, top: 1 }, BRANCH_BOX])).toBe(false);
    expect(sameBoxes(boxes, [TRUNK_BOX])).toBe(false);
  });
});
