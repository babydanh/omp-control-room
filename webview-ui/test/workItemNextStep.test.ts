import { describe, expect, it } from 'vitest';

import { followUpDraftFor, nextStepFor, retryAssignee, summaryLine } from '../src/company/workItemNextStep.js';

describe('nextStepFor', () => {
  it('offers to ask for what the judge found missing, or to accept, when the judge sent the item back', () => {
    const item = { status: 'needs_input', reason: 'Giám khảo chưa thấy đạt: thiếu bản đồ route', judge: { status: 'verdict', verdict: 'fail', followUps: 2 } } as const;
    expect(nextStepFor(item, '', false)).toEqual({ tone: 'act', title: 'Giám khảo thấy còn thiếu', detail: 'thiếu bản đồ route', actions: ['followUp', 'finish'] });
    expect(followUpDraftFor(item)).toBe('Bổ sung vào báo cáo: thiếu bản đồ route');
  });

  it('reads the first line that says something, without markdown marks', () => {
    expect(summaryLine('\n**Kết luận:** Backend không cần code mới\n## Bảng')).toBe('Kết luận: Backend không cần code mới');
    expect(summaryLine('|---|---|\n- mục đầu', 6)).toBe('mục đ…');
  });

  it('asks you to answer, not to add to a report, when the agent itself asks a question', () => {
    expect(nextStepFor({ status: 'needs_input', reason: 'Dùng nhánh nào?' }, '', false)).toMatchObject({ title: 'Agent đang hỏi bạn', actions: ['answer', 'finish'] });
  });

  it('says who acts while you wait: the queue, the agent, the judge', () => {
    expect(nextStepFor({ status: 'queued' }, 'Chờ claude-be-1 rảnh', false)).toMatchObject({ tone: 'wait', detail: 'Chờ claude-be-1 rảnh', actions: [] });
    expect(nextStepFor({ status: 'running' }, '', false).actions).toEqual([]);
    expect(nextStepFor({ status: 'review', judge: { status: 'running', followUps: 0 } }, '', false)).toMatchObject({ tone: 'wait', title: 'Giám khảo đang chấm' });
  });

  it('offers to judge again an interrupted judge, and the worktree clean-up on a done item', () => {
    expect(nextStepFor({ status: 'review', judge: { status: 'interrupted', followUps: 0 } }, '', false).actions[0]).toBe('rejudge');
    expect(nextStepFor({ status: 'done' }, '', true).actions).toEqual(['cleanWorktree', 'remove']);
  });

  it('offers a failed item one button that tries it again, or removing it', () => {
    expect(nextStepFor({ status: 'failed', reason: 'All 4 live runners are in use.' }, '', false)).toEqual({
      tone: 'error',
      title: 'Lỗi',
      detail: 'All 4 live runners are in use.',
      actions: ['retry', 'remove'],
    });
  });
});

describe('retryAssignee', () => {
  it('runs a Claude Code or agy item the same way again', () => {
    expect(retryAssignee({ assignee: { kind: 'claude' }, squadRunId: 'p1' })).toEqual({ kind: 'claude' });
    expect(retryAssignee({ assignee: { kind: 'agy' } })).toEqual({ kind: 'agy' });
  });

  it('opens a fresh omp session for a squad item, and lets any free agent take another item', () => {
    expect(retryAssignee({ assignee: { kind: 'session', sessionId: 'dead' }, squadRunId: 'p1' })).toEqual({ kind: 'new-session' });
    expect(retryAssignee({ assignee: { kind: 'herdr', paneId: 'w1:p1' } })).toEqual({ kind: 'auto' });
  });
});
