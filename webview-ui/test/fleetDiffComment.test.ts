import { describe, expect, it } from 'vitest';

import { createFleetDiffCommentSelector } from '../src/company/fleet/fleetDiffComment.js';

describe('selectFleetDiffComment', () => {
  it('maps a selected unified-diff range to its file and new-side line number', () => {
    const text = [
      '### Thay doi chua commit',
      'diff --git a/src/a.ts b/src/a.ts',
      'index 123..456 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,3 @@',
      ' context',
      '-old',
      '+new',
      ' context2',
    ].join('\n');
    const selector = createFleetDiffCommentSelector(text);

    expect(selector.select(6, 8)).toEqual({
      file: 'src/a.ts',
      line: 1,
      snippet: ' context\n-old\n+new',
    });
  });

  it('rejects metadata and selections spanning different files, and bounds the excerpt', () => {
    const text = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -0,0 +1,1 @@',
      '+first',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -0,0 +1,1 @@',
      '+second',
    ].join('\n');
    const selector = createFleetDiffCommentSelector(text);

    expect(selector.select(0)).toBeNull();
    expect(selector.select(4, 9)).toBeNull();
    const oversizedDiff = ['### File mới: large.ts', '+++ content begins with plus', '+'.repeat(1_300)].join('\n');
    const oversizedSelector = createFleetDiffCommentSelector(oversizedDiff);
    expect(oversizedSelector.select(1)).toEqual({
      file: 'large.ts',
      line: 1,
      snippet: '+++ content begins with plus',
    });
    expect(oversizedSelector.select(2)?.snippet).toHaveLength(1_200);
  });
});
