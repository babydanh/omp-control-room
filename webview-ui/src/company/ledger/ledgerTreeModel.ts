/**
 * The git tree of one repo as the view draws it: the trunk and branch cards in visual
 * order, each with its health and managers, the conflicts between them, and the header
 * line. Pure, so the folding, ordering and conflict rules are tested without a DOM.
 */

import type {
  LedgerOverlapScan,
  LedgerPending,
  LedgerRepo,
  LedgerSession,
  LedgerWorktree,
} from '../../../../core/src/messages.js';
import { parseLedgerTimestamp } from './ledgerFormat.js';
import { checkoutHealth, type NodeHealth, type NodeTone, repoSummary } from './ledgerHealth.js';
import {
  type ManagerChip,
  managersByCheckout,
  type PaneInput,
  sessionActivityByCheckout,
} from './ledgerManagers.js';
import type { BoardSessionIndex } from './ledgerMapping.js';
import { normalizeCheckoutPath } from './ledgerSelection.js';
import type { ConflictEdge } from './ledgerTreeLayout.js';

/** The id of the trunk when this machine has no main checkout for the repo. */
export const TRUNK_ID = 'origin/main';

export interface TreeNode {
  readonly id: string;
  readonly trunk: boolean;
  /** Null for origin/main when this machine has no main checkout. */
  readonly worktree: LedgerWorktree | null;
  readonly health: NodeHealth;
  readonly managers: readonly ManagerChip[];
}

export interface RepoTree {
  readonly repo: string;
  readonly name: string;
  readonly summary: string;
  /** Visual order, top to bottom: the trunk first, then branches by urgency. */
  readonly nodes: readonly TreeNode[];
  /** Cleanable merged branches, whether shown or folded away. */
  readonly foldedCount: number;
  readonly conflicts: readonly ConflictEdge[];
}

export interface TreeContext {
  readonly sessions: readonly LedgerSession[];
  readonly pending: readonly LedgerPending[];
  readonly panes: readonly PaneInput[];
  readonly boardSessions: BoardSessionIndex;
  readonly generatedAt: string;
}

const TONE_RANK: Readonly<Record<NodeTone, number>> = {
  conflict: 0,
  attention: 1,
  ok: 2,
  merged: 3,
};

/**
 * Builds one repo's tree. Cleanable merged branches are left out unless `showFolded`,
 * and merged branches never take part in a conflict: their work is already in main.
 */
export function buildRepoTree(
  repo: LedgerRepo,
  scan: LedgerOverlapScan | null,
  context: TreeContext,
  showFolded: boolean,
): RepoTree {
  const keys = repo.worktrees.map((worktree) => normalizeCheckoutPath(worktree.path));
  const mainWorktree = repo.worktrees.find((worktree) => worktree.isMain);
  const branchWorktrees = repo.worktrees.filter((worktree) => !worktree.isMain);
  const mergedPaths = new Set(
    branchWorktrees
      .filter((worktree) => worktree.merged)
      .map((worktree) => normalizeCheckoutPath(worktree.path)),
  );
  const nowMs = parseLedgerTimestamp(context.generatedAt);
  const activity = sessionActivityByCheckout(context.sessions, keys);
  const managers = managersByCheckout({
    checkouts: keys,
    sessions: context.sessions,
    panes: context.panes,
    boardSessions: context.boardSessions,
    generatedAt: context.generatedAt,
  });

  const nodeOf = (worktree: LedgerWorktree): TreeNode => {
    const id = normalizeCheckoutPath(worktree.path);
    const health = checkoutHealth({
      worktree,
      scan,
      pending: context.pending,
      mergedPaths,
      nowMs,
      sessionActivityMs: activity.get(id) ?? null,
    });
    return { id, trunk: worktree.isMain, worktree, health, managers: managers.get(id) ?? [] };
  };

  const trunk: TreeNode =
    mainWorktree === undefined
      ? {
          id: TRUNK_ID,
          trunk: true,
          worktree: null,
          health: { tone: 'ok', reasons: [], cleanable: false },
          managers: [],
        }
      : nodeOf(mainWorktree);
  const branches = branchWorktrees.map(nodeOf);
  const folded = branches.filter((node) => node.health.cleanable);
  const open = branches
    .filter((node) => !node.health.cleanable)
    .sort((left, right) => TONE_RANK[left.health.tone] - TONE_RANK[right.health.tone]);
  const visible = showFolded ? [...open, ...folded] : open;
  const nodes = [trunk, ...visible];
  const shown = new Set(nodes.map((node) => node.id));

  return {
    repo: repo.repo,
    name: repo.name,
    summary: repoSummary([trunk, ...branches]),
    nodes,
    foldedCount: folded.length,
    conflicts: conflictEdges(scan, shown, mergedPaths, trunk.id),
  };
}

/** Conflicts whose two ends are both on the tree, skipping merged branches. */
function conflictEdges(
  scan: LedgerOverlapScan | null,
  shown: ReadonlySet<string>,
  mergedPaths: ReadonlySet<string>,
  trunkId: string,
): ConflictEdge[] {
  if (scan === null) return [];
  const edges: ConflictEdge[] = [];
  for (const pair of scan.pairs) {
    if (pair.conflicts.length === 0) continue;
    const a = normalizeCheckoutPath(pair.a);
    const b = normalizeCheckoutPath(pair.b);
    if (a === b || !shown.has(a) || !shown.has(b) || mergedPaths.has(a) || mergedPaths.has(b)) {
      continue;
    }
    edges.push({
      id: `pair:${a}|${b}`,
      ref: { kind: 'pair', a: pair.a, b: pair.b },
      a,
      b,
      files: pair.conflicts.length,
    });
  }
  for (const main of scan.main) {
    const lane = normalizeCheckoutPath(main.lane);
    if (
      main.conflicts.length === 0 ||
      lane === trunkId ||
      !shown.has(lane) ||
      mergedPaths.has(lane)
    ) {
      continue;
    }
    edges.push({
      id: `main:${lane}`,
      ref: { kind: 'main', lane: main.lane },
      a: lane,
      b: trunkId,
      files: main.conflicts.length,
    });
  }
  return edges;
}
