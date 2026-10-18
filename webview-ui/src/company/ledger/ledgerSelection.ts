/**
 * What the ledger view has selected, and the lookups that resolve a selection against
 * the current view. Selections hold keys, not objects, so they stay valid when the
 * server sends a fresh view: a selection whose target has gone resolves to null.
 */

import type {
  LedgerOverlapConflict,
  LedgerOverlapScan,
  LedgerRepo,
  LedgerSession,
  LedgerView,
  LedgerWorktree,
} from '../../../../core/src/messages.js';

/** One overlap entry in a repo's scan: a pair of worktrees, or a worktree against main. */
export type ConflictRef = { kind: 'pair'; a: string; b: string } | { kind: 'main'; lane: string };

export type LedgerSelection =
  | { kind: 'branch'; repo: string; path: string }
  | { kind: 'conflict'; repo: string; ref: ConflictRef }
  | { kind: 'session'; sessionId: string };

export type ResolvedSelection =
  | { kind: 'branch'; repo: LedgerRepo; worktree: LedgerWorktree }
  | {
      kind: 'conflict';
      repo: LedgerRepo;
      scan: LedgerOverlapScan;
      leftLabel: string;
      rightLabel: string;
      conflicts: LedgerOverlapConflict[];
      auto: string[];
    }
  | { kind: 'session'; session: LedgerSession };

/**
 * The key a checkout path is compared by: forward slashes, no trailing slash,
 * lower case. Git on Windows reports paths in more than one spelling.
 */
export function normalizeCheckoutPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function resolveSelection(
  view: LedgerView,
  selection: LedgerSelection,
): ResolvedSelection | null {
  if (selection.kind === 'session') {
    const session = view.sessions.find((item) => item.sessionId === selection.sessionId);
    return session === undefined ? null : { kind: 'session', session };
  }

  const repo = view.repos.find((item) => item.repo === selection.repo);
  if (repo === undefined) return null;

  if (selection.kind === 'branch') {
    const key = normalizeCheckoutPath(selection.path);
    const worktree = repo.worktrees.find((item) => normalizeCheckoutPath(item.path) === key);
    return worktree === undefined ? null : { kind: 'branch', repo, worktree };
  }

  const scan = view.overlaps.find((item) => item.repo === selection.repo);
  if (scan === undefined) return null;

  const ref = selection.ref;
  if (ref.kind === 'pair') {
    const pair = scan.pairs.find((item) => item.a === ref.a && item.b === ref.b);
    if (pair === undefined) return null;
    return {
      kind: 'conflict',
      repo,
      scan,
      leftLabel: pair.aLabel,
      rightLabel: pair.bLabel,
      conflicts: pair.conflicts,
      auto: pair.auto,
    };
  }

  const main = scan.main.find((item) => item.lane === ref.lane);
  if (main === undefined) return null;
  return {
    kind: 'conflict',
    repo,
    scan,
    leftLabel: main.label,
    rightLabel: 'main',
    conflicts: main.conflicts,
    auto: [],
  };
}
