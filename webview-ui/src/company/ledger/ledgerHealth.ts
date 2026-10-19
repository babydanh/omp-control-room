/**
 * What is wrong with one checkout on the git tree, in words, and the tone that colours
 * its card. Pure: the tree view draws what this module decides, so these rules are tested
 * without a DOM. Each reason states one fact about the checkout; the tone is the worst
 * reason it carries.
 */

import type {
  LedgerOverlapScan,
  LedgerPending,
  LedgerWorktree,
} from '../../../../core/src/messages.js';
import type { IconName } from '../iconNames.js';
import { parseLedgerTimestamp } from './ledgerFormat.js';
import { normalizeCheckoutPath } from './ledgerSelection.js';

/** A checkout nobody has touched for this many days, with no session in it, is abandoned. */
export const STALE_AFTER_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The colour of a card: the worst reason it carries. */
export type NodeTone = 'ok' | 'attention' | 'conflict' | 'merged';

/** `info` is a fact that needs no action; it is drawn in muted text, with no colour. */
export type ReasonTone = NodeTone | 'info';

export type ReasonKey =
  | 'conflict'
  | 'gitError'
  | 'unscanned'
  | 'behind'
  | 'unpushed'
  | 'dirty'
  | 'stale'
  | 'ahead'
  | 'merged';

export interface HealthReason {
  readonly key: ReasonKey;
  readonly tone: ReasonTone;
  readonly icon: IconName;
  readonly text: string;
}

export interface NodeHealth {
  readonly tone: NodeTone;
  /** Ordered by severity: conflicts first, then problems, then facts. */
  readonly reasons: readonly HealthReason[];
  /** Merged, with nothing unsaved or unpushed and no session in it: the tree folds it away. */
  readonly cleanable: boolean;
}

export interface HealthInput {
  readonly worktree: LedgerWorktree;
  readonly scan: LedgerOverlapScan | null;
  readonly pending: readonly LedgerPending[];
  /** Normalized paths of the repo's merged branches; a clash with one is moot, its work is in main. */
  readonly mergedPaths: ReadonlySet<string>;
  /** When the view was generated, in ms; null when it cannot be read. */
  readonly nowMs: number | null;
  /** The latest call of any ledger session in this checkout, in ms, ended sessions included. */
  readonly sessionActivityMs: number | null;
}

export const TONE_LABEL: Readonly<Record<NodeTone, string>> = {
  ok: 'Ổn',
  attention: 'Cần chú ý',
  conflict: 'Xung đột',
  merged: 'Đã gộp',
};

export const UNSCANNED_TEXT = 'Chưa quét xong: chưa biết có xung đột không';

export function checkoutHealth(input: HealthInput): NodeHealth {
  const { worktree } = input;
  const key = normalizeCheckoutPath(worktree.path);
  const trunk = worktree.isMain;
  const merged = worktree.merged && !trunk;
  // Work still heading for main: only these checkouts can clash or fall behind.
  const live = !trunk && !merged;
  const reasons: HealthReason[] = [];

  if (live) reasons.push(...conflictReasons(key, input.scan, input.mergedPaths));
  if (worktree.gitError !== undefined) {
    reasons.push(reason('gitError', 'attention', 'alert-triangle', worktree.gitError));
  }
  const scanIssue = live ? scanProblem(input.scan) : null;
  if (scanIssue !== null) reasons.push(reason('unscanned', 'attention', 'help', scanIssue));
  if (live && worktree.behind > 0) {
    reasons.push(
      reason(
        'behind',
        'attention',
        'refresh',
        `Tụt sau main ${worktree.behind} commit — nên rebase`,
      ),
    );
  }
  if (worktree.unpushed !== null && worktree.unpushed > 0) {
    reasons.push(
      reason('unpushed', 'attention', 'send', `${worktree.unpushed} commit chưa đẩy lên GitHub`),
    );
  } else if (
    live &&
    !worktree.hasUpstream &&
    worktree.ahead > 0 &&
    !input.pending.some((row) => normalizeCheckoutPath(row.checkout) === key && !row.hasRemote)
  ) {
    reasons.push(reason('unpushed', 'attention', 'send', 'Chưa đẩy lên GitHub'));
  }
  if (worktree.dirtyCount > 0) {
    reasons.push(
      reason('dirty', 'attention', 'pencil', `${worktree.dirtyCount} file sửa chưa commit`),
    );
  }
  const stale = live ? staleReason(input) : null;
  if (stale !== null) reasons.push(stale);
  if (live && worktree.ahead > 0) {
    reasons.push(reason('ahead', 'info', 'git-branch', `${worktree.ahead} commit chưa vào main`));
  }
  if (merged) reasons.push(reason('merged', 'merged', 'archive', 'Đã gộp vào main'));

  return {
    tone: toneOf(reasons, merged),
    reasons,
    cleanable:
      merged &&
      worktree.dirtyCount === 0 &&
      (worktree.unpushed ?? 0) === 0 &&
      worktree.sessionIds.length === 0 &&
      worktree.gitError === undefined,
  };
}

/** What the repo header needs to say about its nodes. */
export interface SummaryNode {
  readonly trunk: boolean;
  readonly health: NodeHealth;
}

/** One line for the repo header: counts of what needs doing, joined with " · ". */
export function repoSummary(nodes: readonly SummaryNode[]): string {
  const branches = nodes.filter((node) => !node.trunk);
  const parts: string[] = [
    branches.length === 0 ? 'Chưa có nhánh phụ' : `${branches.length} nhánh`,
  ];
  pushCount(parts, countWith(branches, 'behind'), 'cần rebase');
  pushCount(
    parts,
    branches.filter((node) => node.health.tone === 'conflict').length,
    'sắp xung đột',
  );
  pushCount(parts, countWith(nodes, 'unpushed'), 'chưa đẩy lên GitHub');
  pushCount(parts, countWith(branches, 'stale'), 'bỏ quên');
  pushCount(parts, countWith(nodes, 'dirty'), 'đang sửa dở');
  pushCount(parts, branches.filter((node) => node.health.cleanable).length, 'đã gộp, có thể dọn');
  if (countWith(nodes, 'unscanned') > 0) parts.push('chưa quét xong');
  return parts.join(' · ');
}

function reason(key: ReasonKey, tone: ReasonTone, icon: IconName, text: string): HealthReason {
  return { key, tone, icon, text };
}

function toneOf(reasons: readonly HealthReason[], merged: boolean): NodeTone {
  if (reasons.some((item) => item.tone === 'conflict')) return 'conflict';
  if (reasons.some((item) => item.tone === 'attention')) return 'attention';
  return merged ? 'merged' : 'ok';
}

/** One reason per overlap that still matters: both sides live, and the files really clash. */
function conflictReasons(
  key: string,
  scan: LedgerOverlapScan | null,
  mergedPaths: ReadonlySet<string>,
): HealthReason[] {
  if (scan === null) return [];
  const found: HealthReason[] = [];
  for (const pair of scan.pairs) {
    if (pair.conflicts.length === 0) continue;
    const first = normalizeCheckoutPath(pair.a);
    const second = normalizeCheckoutPath(pair.b);
    if (first !== key && second !== key) continue;
    const other = first === key ? second : first;
    if (mergedPaths.has(other)) continue;
    const label = first === key ? pair.bLabel : pair.aLabel;
    const files = pair.conflicts.length;
    found.push(
      reason('conflict', 'conflict', 'x-circle', `Sẽ xung đột với ${label} ở ${files} tệp`),
    );
  }
  for (const main of scan.main) {
    if (main.conflicts.length === 0 || normalizeCheckoutPath(main.lane) !== key) continue;
    const files = main.conflicts.length;
    found.push(reason('conflict', 'conflict', 'x-circle', `Sẽ xung đột với main ở ${files} tệp`));
  }
  return found;
}

/** Why the overlap answer cannot be trusted yet, or null when the scan is complete. */
function scanProblem(scan: LedgerOverlapScan | null): string | null {
  if (scan === null) return UNSCANNED_TEXT;
  if (scan.state === 'error') return `Quét lỗi: ${scan.error ?? 'không rõ nguyên nhân'}`;
  return scan.state === 'done' && scan.complete ? null : UNSCANNED_TEXT;
}

function staleReason(input: HealthInput): HealthReason | null {
  const { worktree, nowMs } = input;
  if (nowMs === null || worktree.sessionIds.length > 0) return null;
  const last = latestOf(parseLedgerTimestamp(worktree.lastCommitAt), input.sessionActivityMs);
  if (last === null) return null;
  const idleMs = nowMs - last;
  if (idleMs < STALE_AFTER_DAYS * DAY_MS) return null;
  const days = Math.floor(idleMs / DAY_MS);
  return reason('stale', 'attention', 'moon', `Bỏ quên: không ai động ${days} ngày`);
}

function latestOf(first: number | null, second: number | null): number | null {
  if (first === null) return second;
  if (second === null) return first;
  return Math.max(first, second);
}

function countWith(nodes: readonly SummaryNode[], key: ReasonKey): number {
  return nodes.filter((node) => node.health.reasons.some((item) => item.key === key)).length;
}

function pushCount(parts: string[], count: number, label: string): void {
  if (count > 0) parts.push(`${count} ${label}`);
}
