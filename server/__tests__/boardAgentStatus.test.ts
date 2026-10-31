import { describe, expect, it } from 'vitest';

import { boardAgentStatus } from '../src/projects/projectTree.js';

const agent = (over: { isWaiting?: boolean; permissionSent?: boolean; tools?: string[] } = {}) => ({
  isWaiting: over.isWaiting ?? false,
  permissionSent: over.permissionSent ?? false,
  activeToolNames: new Map((over.tools ?? []).map((name, i) => [`t${i}`, name])),
});

describe('boardAgentStatus', () => {
  it('is permission while a permission prompt waits for the user', () => {
    expect(boardAgentStatus(agent({ permissionSent: true, tools: ['Bash'] }))).toBe('permission');
  });

  it('is waiting_input while Claude is asking a question with AskUserQuestion', () => {
    expect(boardAgentStatus(agent({ tools: ['AskUserQuestion'] }))).toBe('waiting_input');
  });

  it('keeps the old answers otherwise: waiting at rest, running at work', () => {
    expect(boardAgentStatus(agent({ isWaiting: true }))).toBe('waiting');
    expect(boardAgentStatus(agent({ tools: ['Read'] }))).toBe('running');
  });
});
