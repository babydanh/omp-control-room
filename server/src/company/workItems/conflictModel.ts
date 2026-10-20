/**
 * Overlap detection for squad items: which open items the ledger reports as overlapping.
 *
 * Pure. The service passes in the ledger's overlap scans and each open item's checkout. A lane in
 * the scan is a checkout path, so an item matches a lane by its checkout key. A pair with conflicts
 * links both items; a main entry with conflicts marks its item as overlapping the main checkout.
 */

import type { LedgerOverlapScan } from '../../../../core/src/messages.js';
import { checkoutKey } from './workItemScheduler.js';

/** One open item and the checkout it works in: its worktree, or the repo when it has none. */
export interface ConflictCheckout {
  readonly sequence: number;
  readonly checkout: string;
}

/** What one item overlaps right now. */
export interface ConflictReport {
  /** The #n of each other open item this one overlaps, ascending. */
  readonly sequences: readonly number[];
  /** Whether it overlaps the main checkout's dirty files. */
  readonly main: boolean;
}

/**
 * The overlaps of each checkout, keyed by item sequence. An item with no overlap is absent. The
 * scans are the ledger's, already limited to the repos the open items use.
 */
export function conflictsFor(
  scans: readonly LedgerOverlapScan[],
  checkouts: readonly ConflictCheckout[],
): Map<number, ConflictReport> {
  const sequenceByKey = new Map<string, number>();
  for (const { sequence, checkout } of checkouts)
    sequenceByKey.set(checkoutKey(checkout), sequence);
  const links = new Map<number, Set<number>>();
  const mainHits = new Set<number>();
  for (const scan of scans) {
    for (const pair of scan.pairs) {
      if (pair.conflicts.length === 0) continue;
      const a = sequenceByKey.get(checkoutKey(pair.a));
      const b = sequenceByKey.get(checkoutKey(pair.b));
      if (a === undefined || b === undefined || a === b) continue;
      linkInto(links, a, b);
      linkInto(links, b, a);
    }
    for (const lane of scan.main) {
      if (lane.conflicts.length === 0) continue;
      const sequence = sequenceByKey.get(checkoutKey(lane.lane));
      if (sequence !== undefined) mainHits.add(sequence);
    }
  }
  const reports = new Map<number, ConflictReport>();
  for (const { sequence } of checkouts) {
    const others = [...(links.get(sequence) ?? [])].sort((x, y) => x - y);
    const main = mainHits.has(sequence);
    if (others.length === 0 && !main) continue;
    reports.set(sequence, { sequences: others, main });
  }
  return reports;
}

function linkInto(links: Map<number, Set<number>>, from: number, to: number): void {
  const set = links.get(from) ?? new Set<number>();
  set.add(to);
  links.set(from, set);
}

/**
 * The text the board and the leader read for one report: "#3, #5" and "checkout chính" joined
 * with commas. Empty when the report names no overlap.
 */
export function describeConflicts(report: ConflictReport): string[] {
  const names = report.sequences.map((sequence) => `#${sequence}`);
  if (report.main) names.push('checkout chính');
  return names;
}
