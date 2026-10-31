import { describe, expect, it } from 'vitest';

import { contextChip, contextOfNode } from '../src/company/projects/contextChip.js';

describe('contextChip', () => {
  it('says nothing when the session reports no context', () => {
    expect(contextChip(null)).toBeNull();
    expect(contextChip(Number.NaN)).toBeNull();
    expect(contextChip(Number.POSITIVE_INFINITY)).toBeNull();
    expect(contextChip(Number.NEGATIVE_INFINITY)).toBeNull();
  });

  it('shows the share rounded, calm under 70%, warning from 70%, error from 90%', () => {
    expect(contextChip(0.624)).toEqual({ text: 'ctx 62%', tone: 'calm' });
    expect(contextChip(0.7)).toEqual({ text: 'ctx 70%', tone: 'warn' });
    expect(contextChip(0.9)).toEqual({ text: 'ctx 90%', tone: 'error' });
  });

  it('clamps a share above the window to 100% and below zero to 0%', () => {
    expect(contextChip(1.4)?.text).toBe('ctx 100%');
    expect(contextChip(-0.2)?.text).toBe('ctx 0%');
  });
});

describe('contextOfNode', () => {
  const sessions = { board1: { contextSnapshot: { usedTokens: 50, windowTokens: 100 } } } as never;

  it('reads the board session behind a tree node, by its board id first and its own id second', () => {
    expect(contextOfNode({ boardSessionId: 'board1', sessionId: 'x' }, sessions)).toBe(0.5);
    expect(contextOfNode({ sessionId: 'board1' }, sessions)).toBe(0.5);
  });

  it('answers null for a node with no board session, such as a herdr pane', () => {
    expect(contextOfNode({ sessionId: 'pane-9' }, sessions)).toBeNull();
    expect(contextOfNode({}, sessions)).toBeNull();
  });

  it('does not borrow another session when the board session it names is not loaded yet', () => {
    expect(contextOfNode({ boardSessionId: 'later', sessionId: 'board1' }, sessions)).toBeNull();
  });
});
