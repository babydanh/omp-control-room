/**
 * workItemNextStep: the one thing a work item asks of the user now, in a few words.
 *
 * The drawer leads with it: who acts next (the agent, the judge, or you), and the buttons that do
 * what it asks. Everything else (the item's text, its history) folds away below.
 */

import type { WorkItem } from '../../../core/src/messages.js';

export type NextStepAction = 'rejudge' | 'finish' | 'followUp' | 'answer' | 'reassign' | 'cleanWorktree' | 'remove';

export interface NextStep {
  /** wait: someone else acts; act: you act; done / error: finished. */
  readonly tone: 'wait' | 'act' | 'done' | 'error';
  readonly title: string;
  /** One short line of why, when there is one. */
  readonly detail?: string;
  /** The buttons, the first one leading. */
  readonly actions: readonly NextStepAction[];
}

export const NEXT_STEP_LABEL: Record<NextStepAction, string> = {
  rejudge: 'Chấm lại',
  finish: 'Chấp nhận kết quả',
  followUp: 'Yêu cầu bổ sung',
  answer: 'Trả lời agent',
  reassign: 'Giao người khác',
  cleanWorktree: 'Dọn worktree',
  remove: 'Xoá',
};

const DETAIL_MAX = 160;

/** The first line that says something, without markdown marks, clipped to `max` characters. */
export function summaryLine(text: string | undefined, max = DETAIL_MAX): string | undefined {
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.replace(/[*`#>|]/g, '').replace(/^\s*[-•]\s*/, '').replace(/\s+/g, ' ').trim();
    if (line.length < 3 || /^-+$/.test(line)) continue;
    return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
  }
  return undefined;
}

function short(text: string | undefined): string | undefined {
  return summaryLine((text ?? '').replace(/^Giám khảo chưa thấy đạt:\s*/i, '').replace(/\s+/g, ' '));
}

/** What the user sends when they ask the agent to fill in what the judge found missing. */
export function followUpDraftFor(item: Pick<WorkItem, 'reason'>): string {
  const missing = short(item.reason);
  return missing === undefined ? '' : `Bổ sung vào báo cáo: ${missing}`;
}

type StepItem = Pick<WorkItem, 'status' | 'reason' | 'judge'>;

/** `waitText` says what a queued item waits for, when known; `canClean` is true when its worktree can be removed. */
export function nextStepFor(item: StepItem, waitText: string | null, canClean: boolean): NextStep {
  const judge = item.judge;
  switch (item.status) {
    case 'queued':
      return { tone: 'wait', title: 'Đang xếp hàng', ...(waitText === null ? {} : { detail: waitText }), actions: [] };
    case 'running':
      return { tone: 'wait', title: 'Agent đang làm', actions: [] };
    case 'review':
      if (judge?.status === 'running' || judge?.status === 'waiting') return { tone: 'wait', title: 'Giám khảo đang chấm', actions: [] };
      if (judge?.status === 'interrupted' || judge?.status === 'error') {
        return { tone: 'act', title: 'Chấm bị gián đoạn', detail: 'Bấm Chấm lại để giám khảo đọc lại kết quả.', actions: ['rejudge', 'finish'] };
      }
      return { tone: 'act', title: 'Agent đã xong, bạn xem kết quả', actions: ['finish', 'followUp', 'reassign'] };
    case 'needs_input':
      // The judge sent it back: you accept the result as it is, or have the agent add what is missing.
      if (judge?.status === 'verdict') {
        return { tone: 'act', title: 'Giám khảo thấy còn thiếu', detail: short(item.reason), actions: ['followUp', 'finish'] };
      }
      return { tone: 'act', title: 'Agent đang hỏi bạn', detail: short(item.reason), actions: ['answer', 'finish'] };
    case 'failed':
      return { tone: 'error', title: 'Lỗi', detail: short(item.reason), actions: ['reassign', 'remove'] };
    case 'done':
      return { tone: 'done', title: 'Xong', actions: canClean ? ['cleanWorktree', 'remove'] : ['remove'] };
  }
}
