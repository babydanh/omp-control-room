/**
 * workItemReviewView: the review-stage facts a work item shows, as pure rules. The judge's chip,
 * the conflict chip, the parked badge and the worktree clean-up offer. The server owns every field
 * read here; nothing in this module decides a transition.
 *
 * DOM-free and React-free, so the board card, the drawer, the squad rows and the tests read one set
 * of rules.
 */

import type {
  WorkItem,
  WorkItemAssignee,
  WorkItemConflicts,
  WorkItemJudge,
  WorkItemStatus,
} from '../../../core/src/messages.js';

/** How many judge follow-ups a work item gets before the judge sends it back for the user's input. */
export const JUDGE_FOLLOW_UP_MAX = 2;

/** The start of the reason a needs-input item carries when the judge sent it back unpassed. */
export const JUDGE_UNPASSED_REASON_PREFIX = 'Giám khảo chưa thấy đạt';

/** The words of the parked badge: the item's assignee is a squad session that is parked. */
export const PARKED_BADGE_TEXT = 'Phiên đã đậu';

/** The name a conflict chip gives the main checkout when the item overlaps its dirty files. */
const MAIN_CHECKOUT_LABEL = 'checkout chính';

/** How loud a review chip reads. The colour each tone takes is the component's concern. */
export type ReviewChipTone = 'muted' | 'warning' | 'danger' | 'success';

/** A judge chip: its words, how loud it reads, and whether the drawer offers to judge again. */
export interface JudgeChip {
  text: string;
  tone: ReviewChipTone;
  /** True when the judge did not finish on a review item, so the drawer offers 'Chấm lại'. */
  rejudge: boolean;
}

/** The chip for a judge's state, or null when the judge has no verdict to name yet. */
function judgeStateChip(judge: WorkItemJudge): JudgeChip | null {
  switch (judge.status) {
    case 'running':
      return { text: 'Giám khảo đang chấm…', tone: 'muted', rejudge: false };
    case 'waiting':
      return { text: 'Giám khảo chờ xung đột xong', tone: 'muted', rejudge: false };
    case 'interrupted':
      return { text: 'Chấm bị gián đoạn', tone: 'warning', rejudge: true };
    case 'error': {
      const detail = judge.error?.trim() ?? '';
      return {
        text: detail === '' ? 'Giám khảo lỗi' : `Giám khảo lỗi: ${detail}`,
        tone: 'danger',
        rejudge: true,
      };
    }
    case 'verdict':
      return verdictChip(judge);
  }
}

/** The chip for a judge's verdict. A verdict is named with its follow-up count, out of the maximum. */
function verdictChip(judge: WorkItemJudge): JudgeChip | null {
  if (judge.verdict === undefined) return null;
  const count = `${judge.followUps}/${JUDGE_FOLLOW_UP_MAX}`;
  switch (judge.verdict) {
    case 'pass':
      return { text: 'Giám khảo: đạt', tone: 'success', rejudge: false };
    case 'fail':
      return { text: `Chưa đạt (${count})`, tone: 'warning', rejudge: false };
    case 'need_evidence':
      return { text: `Cần bằng chứng (${count})`, tone: 'warning', rejudge: false };
  }
}

/**
 * The judge chip an item shows, or null when it shows none. The judge shows on a review item and on
 * a needs-input item the judge sent back. The 'Chấm lại' offer is made only on a review item.
 */
export function judgeChipFor(item: {
  readonly status: WorkItemStatus;
  readonly reason?: string | null;
  readonly judge?: WorkItemJudge | null;
}): JudgeChip | null {
  const judge = item.judge;
  if (!judge) return null;
  const sentBack =
    item.status === 'needs_input' && (item.reason ?? '').startsWith(JUDGE_UNPASSED_REASON_PREFIX);
  if (item.status !== 'review' && !sentBack) return null;
  const chip = judgeStateChip(judge);
  if (chip === null) return null;
  return { ...chip, rejudge: chip.rejudge && item.status === 'review' };
}

/**
 * The words of a conflict chip: the #n items and the main checkout an item overlaps, in that order,
 * joined by commas. Null when it overlaps nothing.
 */
export function conflictText(conflicts: WorkItemConflicts | null | undefined): string | null {
  if (!conflicts) return null;
  const names = conflicts.sequences.map((sequence) => `#${sequence}`);
  if (conflicts.main) names.push(MAIN_CHECKOUT_LABEL);
  return names.length === 0 ? null : `Xung đột với ${names.join(', ')}`;
}

/** Whether an item's assignee is a squad session the server reports as parked. */
export function isParkedAssignee(
  assignee: WorkItemAssignee,
  parkedSessionIds: readonly string[],
): boolean {
  return assignee.sessionId !== undefined && parkedSessionIds.includes(assignee.sessionId);
}

/**
 * What the drawer offers for an item's worktree: the clean-up button on a done item that still has
 * one, the removed note once the server has removed it, or nothing.
 */
export type WorktreeOffer = 'clean' | 'removed' | null;

export function worktreeOffer(
  item: Pick<WorkItem, 'status' | 'worktree' | 'worktreeRemoved'>,
): WorktreeOffer {
  if (item.worktreeRemoved === true) return 'removed';
  return item.status === 'done' && item.worktree !== undefined ? 'clean' : null;
}
