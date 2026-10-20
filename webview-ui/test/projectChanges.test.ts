import { describe, expect, it } from 'vitest';

import { numberDiffLines } from '../src/company/projects/projectDiffLines.js';

describe('numberDiffLines', () => {
  it('numbers additions, deletions, context, and successive hunks', () => {
    expect(numberDiffLines('@@ -2,2 +2,3 @@\n keep\n-old\n+new\n+extra\n@@ -9 +10 @@\n tail')).toEqual([
      { kind: 'meta', oldLine: null, newLine: null, text: '@@ -2,2 +2,3 @@' },
      { kind: 'context', oldLine: 2, newLine: 2, text: 'keep' },
      { kind: 'deletion', oldLine: 3, newLine: null, text: 'old' },
      { kind: 'addition', oldLine: null, newLine: 3, text: 'new' },
      { kind: 'addition', oldLine: null, newLine: 4, text: 'extra' },
      { kind: 'meta', oldLine: null, newLine: null, text: '@@ -9 +10 @@' },
      { kind: 'context', oldLine: 9, newLine: 10, text: 'tail' },
    ]);
  });
});
