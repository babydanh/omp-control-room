import { describe, expect, it } from 'vitest';

import { nextStepFor } from '../src/company/workItemNextStep.js';

describe('nextStepFor', () => {
  it('asks you to judge again when the judge sent the item back, without its boilerplate prefix', () => {
    const step = nextStepFor({ status: 'needs_input', reason: 'Giám khảo chưa thấy đạt: thiếu bản đồ route', judge: { status: 'verdict', verdict: 'fail', followUps: 2 } }, '', false);
    expect(step).toEqual({ tone: 'act', title: 'Giám khảo chưa cho đạt', detail: 'thiếu bản đồ route', actions: ['rejudge', 'finish', 'reassign'] });
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
});
