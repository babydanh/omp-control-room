import { describe, expect, it } from 'vitest';

import {
  composeDispatchPrompt,
  SAFE_READ_ONLY_BLOCK,
  SAFE_WORK_BLOCK,
} from '../src/company/workItems/dispatchPrompt.js';

describe('composeDispatchPrompt', () => {
  it('composes the text and the safe-work block, with no acceptance line', () => {
    expect(composeDispatchPrompt({ text: 'Sửa lỗi đăng nhập', readOnly: false })).toBe(
      `Sửa lỗi đăng nhập\n\n${SAFE_WORK_BLOCK}`,
    );
  });

  it('trims the text before composing', () => {
    expect(composeDispatchPrompt({ text: '  Sửa lỗi  ', readOnly: false })).toMatch(
      /^Sửa lỗi\n\n/,
    );
  });

  it('puts the acceptance line last, after the safe-work block', () => {
    const prompt = composeDispatchPrompt({
      text: 'Thêm trang cài đặt',
      acceptance: 'npm test xanh',
      readOnly: false,
    });
    expect(prompt.endsWith('Xong khi: npm test xanh')).toBe(true);
    expect(prompt.indexOf(SAFE_WORK_BLOCK)).toBeLessThan(prompt.indexOf('Xong khi:'));
  });

  it('adds no subagent line for the default worker', () => {
    const prompt = composeDispatchPrompt({ text: 'Việc', agent: 'task', readOnly: false });
    expect(prompt).not.toContain('subagent omp');
  });

  it('names the subagent when one other than the default is chosen', () => {
    const prompt = composeDispatchPrompt({ text: 'Việc', agent: 'scout', readOnly: false });
    expect(prompt).toContain('subagent omp `scout` (tool task, agent: scout)');
    expect(prompt.indexOf('subagent omp')).toBeLessThan(prompt.indexOf(SAFE_WORK_BLOCK));
  });

  it('uses the read-only block, and no edit block, for a read-only agent', () => {
    const prompt = composeDispatchPrompt({ text: 'Xem code', agent: 'scout', readOnly: true });
    expect(prompt).toContain('tool task, agent: scout');
    expect(prompt).toContain(SAFE_READ_ONLY_BLOCK);
    expect(prompt).not.toContain(SAFE_WORK_BLOCK);
  });
});
