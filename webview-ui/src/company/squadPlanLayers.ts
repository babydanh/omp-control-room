/**
 * squadPlanLayers: a squad proposal's rows grouped into layers by what they wait for, as pure
 * rules. A row that waits for no other row sits in layer 0; any other row sits one layer below the
 * deepest row it waits for. Rows in one layer run together; a later layer waits for the one before
 * it. Row references are 0-based positions in the proposal, as the server sends them. No DOM and no
 * React here, so the rules are tested on their own.
 */

import type { SquadDependency } from '../../../core/src/messages.js';

/** The part of a proposal row the layering reads: what it waits for. */
export interface LayerableRow {
  readonly dependsOn: readonly SquadDependency[];
}

/** One layer of a proposal: the rows that run together. */
export interface SquadLayer {
  /** 0 for rows that wait for no row; every other layer sits one below the layer it waits for. */
  depth: number;
  /** The 0-based indices of the rows in this layer, in proposal order. */
  rows: number[];
}

/**
 * The depth of each row, by index. A reference that points outside the proposal, at the row
 * itself, or back into a cycle adds nothing: the approval check refuses those, so the layering
 * only has to stay well defined.
 */
export function squadRowDepths(rows: readonly LayerableRow[]): number[] {
  const known = new Map<number, number>();
  const onPath = new Set<number>();

  function depthOf(index: number): number {
    const cached = known.get(index);
    if (cached !== undefined) return cached;
    const row = rows[index];
    if (row === undefined) return 0;
    onPath.add(index);
    let depth = 0;
    for (const dependency of row.dependsOn) {
      const target = dependency.kind === 'row' ? dependency.row : undefined;
      if (target === undefined || !Number.isInteger(target)) continue;
      if (target < 0 || target >= rows.length || target === index || onPath.has(target)) continue;
      depth = Math.max(depth, depthOf(target) + 1);
    }
    onPath.delete(index);
    known.set(index, depth);
    return depth;
  }

  return rows.map((_, index) => depthOf(index));
}

/** The layers of a proposal, shallowest first. A layer no row sits in is not listed. */
export function squadLayers(rows: readonly LayerableRow[]): SquadLayer[] {
  const layers: SquadLayer[] = [];
  squadRowDepths(rows).forEach((depth, index) => {
    const layer = layers.find((entry) => entry.depth === depth);
    if (layer === undefined) {
      layers.push({ depth, rows: [index] });
    } else {
      layer.rows.push(index);
    }
  });
  return layers.sort((a, b) => a.depth - b.depth);
}

/** A layer's heading: its number in the plan, and how it runs. */
export interface SquadLayerHead {
  title: string;
  hint: string;
}

/**
 * The heading of a layer. Layer 0 runs now, all its rows at once; a later layer waits for the
 * layer before it.
 */
export function squadLayerHead(layer: SquadLayer): SquadLayerHead {
  const title = `Bước ${layer.depth + 1}`;
  if (layer.depth > 0) return { title, hint: 'Chờ bước trước xong' };
  return { title, hint: layer.rows.length > 1 ? 'Chạy song song' : 'Chạy ngay' };
}

/**
 * What a row waits for, in words: `Chờ dòng 1, dòng 3, #5`, or null when it waits for nothing. A
 * row reference is named by its 1-based row number; an item reference by its #n.
 */
export function waitReasonText(dependsOn: readonly SquadDependency[]): string | null {
  if (dependsOn.length === 0) return null;
  const parts = dependsOn.map((dependency) =>
    dependency.kind === 'row'
      ? `dòng ${dependency.row === undefined ? '?' : dependency.row + 1}`
      : `#${dependency.sequence ?? '?'}`,
  );
  return `Chờ ${parts.join(', ')}`;
}
