import { describe, expect, it } from 'vitest';

import { composerInputHeight } from '../src/company/composerHeight.js';

// A 20px line with 10px of padding and border: one row is 30px, eight rows 170px.
const ROW = 20;
const CHROME = 10;

describe('composerInputHeight', () => {
  it('never shrinks below one row, even with nothing to fit', () => {
    expect(composerInputHeight(0, ROW, CHROME)).toBe(30);
  });

  it('keeps one row when the text fits on one row', () => {
    expect(composerInputHeight(30, ROW, CHROME)).toBe(30);
  });

  it('grows a row for each line of text', () => {
    expect(composerInputHeight(3 * ROW + CHROME, ROW, CHROME)).toBe(70);
  });

  it('stops at the maximum number of rows, where the box scrolls', () => {
    expect(composerInputHeight(8 * ROW + CHROME, ROW, CHROME)).toBe(170);
    expect(composerInputHeight(20 * ROW + CHROME, ROW, CHROME)).toBe(170);
  });

  it('rounds a fractional fit up to a whole pixel', () => {
    expect(composerInputHeight(70.2, ROW, CHROME)).toBe(71);
  });
});
