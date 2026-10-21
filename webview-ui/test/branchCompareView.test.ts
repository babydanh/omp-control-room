import { describe, expect, it } from 'vitest';

import { chooseMergeFirst, chooseNewerSide, classifyComparedFiles, composeRebaseMessage } from '../src/company/projects/branchCompareView.js';

describe('branchCompareView', () => {
  it('selects the side with the later commit date', () => {
    expect(chooseNewerSide(
      { lastCommitAt: '2026-10-20T10:00:00Z' },
      { lastCommitAt: '2026-10-21T10:00:00Z' },
    )).toBe('b');
  });

  it('classifies common and side-only files', () => {
    expect(classifyComparedFiles([
      { path: 'both.ts', inA: true, inB: true, conflict: true },
      { path: 'a.ts', inA: true, inB: false, conflict: false },
      { path: 'b.ts', inA: false, inB: true, conflict: false },
    ])).toEqual({ both: ['both.ts'], onlyA: ['a.ts'], onlyB: ['b.ts'] });
  });

  it('chooses the side with fewer unique commits to merge first', () => {
    expect(chooseMergeFirst(2, 5, 'feature-a', 'feature-b')).toBe('feature-a');
    expect(chooseMergeFirst(5, 2, 'feature-a', 'feature-b')).toBe('feature-b');
  });

  it('composes a Vietnamese rebase assignment and copyable command', () => {
    expect(composeRebaseMessage({ file: 'src/a.ts', line: 12, checkout: 'V:/repo/a', branch: 'feature-b' }))
      .toContain('git -C V:/repo/a rebase feature-b');
    expect(composeRebaseMessage({ file: 'src/a.ts', line: 12, checkout: 'V:/repo/a', branch: 'feature-b' }))
      .toContain('src/a.ts:12');
  });
});
