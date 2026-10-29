import { describe, expect, it } from 'vitest';

import type { GitGuardWorktree } from '../../core/src/messages.js';
import { classifyWorktreeShelf } from '../src/company/fleet/worktreeShelf.js';

const base: GitGuardWorktree = {
  path: '/repo/worktrees/feature',
  branch: 'feature',
  head: 'abc',
  unpushed: 0,
  unpushedSubjects: [],
  backedUp: false,
  dirty: 0,
  ignored: 0,
  dirtyKnown: true,
  dirtyOldestMinutes: null,
  op: null,
  mergedToMain: true,
  idleDays: 8,
  idleMinutes: 120,
  prunable: false,
};

describe('worktree shelf', () => {
  it('keeps a worktree with an open session or active task in doing', () => {
    expect(classifyWorktreeShelf(base, { activePaths: ['/repo/worktrees/feature/src'] })).toBe(
      'doing',
    );
    expect(classifyWorktreeShelf(base, { activeBranches: ['feature'] })).toBe('doing');
    expect(classifyWorktreeShelf(base, { activeTaskSlugs: ['feature'] })).toBe('doing');
    expect(
      classifyWorktreeShelf(base, { activePaths: ['/repo/worktrees'], repoPath: '/repo' }),
    ).toBe('doing');
  });

  it('separates sleeping worktrees from safe trash candidates', () => {
    expect(classifyWorktreeShelf({ ...base, idleMinutes: 20, idleDays: 0 }, {})).toBe('sleeping');
    expect(classifyWorktreeShelf({ ...base, dirty: 1 }, {})).toBe('sleeping');
    expect(classifyWorktreeShelf({ ...base, ignored: 1 }, {})).toBe('sleeping');
    expect(classifyWorktreeShelf({ ...base, dirtyKnown: false }, {})).toBe('sleeping');
    expect(classifyWorktreeShelf({ ...base, dirtyKnown: undefined }, {})).toBe('sleeping');
    expect(classifyWorktreeShelf(base, {})).toBe('trash');
    expect(classifyWorktreeShelf({ ...base, prunable: true, dirty: 1 }, {})).toBe('trash');
  });

  it('does not label an unmerged or unpushed worktree as trash', () => {
    expect(classifyWorktreeShelf({ ...base, mergedToMain: false }, {})).toBe('sleeping');
    expect(classifyWorktreeShelf({ ...base, unpushed: 1 }, {})).toBe('sleeping');
  });
});
