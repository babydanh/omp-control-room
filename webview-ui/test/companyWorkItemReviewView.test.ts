import { describe, expect, it } from 'vitest';

import type { WorkItemJudge } from '../../core/src/messages.js';
import {
  conflictText,
  isParkedAssignee,
  JUDGE_UNPASSED_REASON_PREFIX,
  judgeChipFor,
  worktreeOffer,
} from '../src/company/workItemReviewView.js';

function judge(fields: Pick<WorkItemJudge, 'status'> & Partial<WorkItemJudge>): WorkItemJudge {
  return { followUps: 0, ...fields };
}

/** The judge chip a review item shows for one judge state. */
function reviewChip(value: WorkItemJudge) {
  return judgeChipFor({ status: 'review', judge: value });
}

describe('judgeChipFor', () => {
  it('words each judge state the way the drawer shows it', () => {
    expect(reviewChip(judge({ status: 'running' }))).toMatchObject({
      text: 'Giám khảo đang chấm…',
      rejudge: false,
    });
    expect(reviewChip(judge({ status: 'waiting' }))).toMatchObject({
      text: 'Giám khảo chờ xung đột xong',
      rejudge: false,
    });
    expect(reviewChip(judge({ status: 'verdict', verdict: 'pass' }))).toMatchObject({
      text: 'Giám khảo: đạt',
      tone: 'success',
    });
    expect(reviewChip(judge({ status: 'verdict', verdict: 'fail', followUps: 1 }))).toMatchObject({
      text: 'Chưa đạt (1/2)',
      tone: 'warning',
    });
    expect(
      reviewChip(judge({ status: 'verdict', verdict: 'need_evidence', followUps: 2 })),
    ).toMatchObject({ text: 'Cần bằng chứng (2/2)', tone: 'warning' });
  });

  it('names an interrupted or failed judge and offers to judge again', () => {
    expect(reviewChip(judge({ status: 'interrupted' }))).toMatchObject({
      text: 'Chấm bị gián đoạn',
      rejudge: true,
    });
    expect(reviewChip(judge({ status: 'error', error: 'hết giờ' }))).toMatchObject({
      text: 'Giám khảo lỗi: hết giờ',
      tone: 'danger',
      rejudge: true,
    });
    expect(reviewChip(judge({ status: 'error', error: '   ' }))).toMatchObject({
      text: 'Giám khảo lỗi',
      rejudge: true,
    });
  });

  it('shows nothing for a verdict with no verdict to name', () => {
    expect(reviewChip(judge({ status: 'verdict' }))).toBeNull();
  });

  it('shows the judge on a review item and on a needs-input item the judge sent back', () => {
    const failed = judge({ status: 'verdict', verdict: 'fail', followUps: 2 });
    expect(
      judgeChipFor({
        status: 'needs_input',
        reason: `${JUDGE_UNPASSED_REASON_PREFIX} sau 2 lần gửi tiếp.`,
        judge: failed,
      }),
    ).toMatchObject({ text: 'Chưa đạt (2/2)', rejudge: false });
    expect(
      judgeChipFor({ status: 'needs_input', reason: 'Chờ bạn trả lời', judge: failed }),
    ).toBeNull();
    expect(judgeChipFor({ status: 'running', judge: failed })).toBeNull();
  });

  it('offers to judge again only on a review item', () => {
    const interrupted = judge({ status: 'interrupted' });
    expect(
      judgeChipFor({
        status: 'needs_input',
        reason: `${JUDGE_UNPASSED_REASON_PREFIX} sau 2 lần gửi tiếp.`,
        judge: interrupted,
      }),
    ).toMatchObject({ rejudge: false });
    expect(judgeChipFor({ status: 'review', judge: interrupted })).toMatchObject({ rejudge: true });
    expect(judgeChipFor({ status: 'review', judge: undefined })).toBeNull();
  });
});

describe('conflictText', () => {
  it('names the overlapping items and the main checkout, in that order', () => {
    expect(conflictText({ sequences: [3], main: false })).toBe('Xung đột với #3');
    expect(conflictText({ sequences: [3, 5], main: false })).toBe('Xung đột với #3, #5');
    expect(conflictText({ sequences: [], main: true })).toBe('Xung đột với checkout chính');
    expect(conflictText({ sequences: [3], main: true })).toBe('Xung đột với #3, checkout chính');
  });

  it('shows nothing when the item overlaps nothing', () => {
    expect(conflictText({ sequences: [], main: false })).toBeNull();
    expect(conflictText(undefined)).toBeNull();
    expect(conflictText(null)).toBeNull();
  });
});

describe('isParkedAssignee', () => {
  it('is true only when the assignee session is in the parked list', () => {
    expect(isParkedAssignee({ kind: 'session', sessionId: 's1' }, ['s1'])).toBe(true);
    expect(isParkedAssignee({ kind: 'session', sessionId: 's2' }, ['s1'])).toBe(false);
    expect(isParkedAssignee({ kind: 'herdr', paneId: 'p1' }, ['s1'])).toBe(false);
    expect(isParkedAssignee({ kind: 'auto' }, [])).toBe(false);
  });
});

describe('worktreeOffer', () => {
  const worktree = { path: 'D:/wt/app-a', branch: 'feat/a' };

  it('offers a clean-up only for a done item that still has its worktree', () => {
    expect(worktreeOffer({ status: 'done', worktree })).toBe('clean');
    expect(worktreeOffer({ status: 'done', worktree, worktreeRemoved: false })).toBe('clean');
    expect(worktreeOffer({ status: 'review', worktree })).toBeNull();
    expect(worktreeOffer({ status: 'done' })).toBeNull();
  });

  it('reports a removed worktree whatever the status', () => {
    expect(worktreeOffer({ status: 'done', worktreeRemoved: true })).toBe('removed');
  });
});
