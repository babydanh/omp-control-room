/**
 * workItemNextStep: the one thing a work item asks of the user now, in a few words.
 *
 * The drawer leads with it: who acts next (the agent, the judge, or you), and the buttons that do
 * what it asks. Everything else (the item's text, its history) folds away below.
 */

import type { WorkItem } from '../../../core/src/messages.js';

export type NextStepAction = 'rejudge' | 'finish' | 'followUp' | 'reassign' | 'cleanWorktree' | 'remove';

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
  finish: 'Đánh dấu xong',
  followUp: 'Gửi tiếp',
  reassign: 'Giao lại',
  cleanWorktree: 'Dọn worktree',
  remove: 'Xoá',
};

const DETAIL_MAX = 160;

function short(text: string | undefined): string | undefined {
  const line = (text ?? '').replace(/\s+/g, ' ').trim().replace(/^Giám khảo chưa thấy đạt:\s*/i, '');
  if (line === '') return undefined;
  return line.length <= DETAIL_MAX ? line : `${line.slice(0, DETAIL_MAX - 1)}…`;
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
      return { tone: 'act', title: 'Agent đã xong: bạn xem kết quả', actions: ['finish', 'followUp', 'reassign'] };
    case 'needs_input':
      // A sent-back item can be judged again or accepted; reassigning it is refused by the server.
      if (judge?.status === 'verdict') {
        return { tone: 'act', title: 'Giám khảo chưa cho đạt', detail: short(item.reason), actions: ['rejudge', 'finish'] };
      }
      return { tone: 'act', title: 'Agent đang hỏi bạn', detail: short(item.reason), actions: ['finish'] };
    case 'failed':
      return { tone: 'error', title: 'Lỗi', detail: short(item.reason), actions: ['reassign', 'followUp', 'remove'] };
    case 'done':
      return { tone: 'done', title: 'Xong', actions: canClean ? ['cleanWorktree', 'remove'] : ['remove'] };
  }
}
