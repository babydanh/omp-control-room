import { describe, expect, it } from 'vitest';

import { composerInputHeight } from '../src/company/composerHeight.js';

// A 20px line with 10px of padding and border: two rows are 50px, twelve rows 250px.
const ROW = 20;
const CHROME = 10;

describe('composerInputHeight', () => {
  it('idles at two rows when the box was never dragged', () => {
    expect(composerInputHeight(0, ROW, CHROME, null)).toBe(50);
    expect(composerInputHeight(30, ROW, CHROME, null)).toBe(50);
  });

  it('grows past two rows as the text needs more', () => {
    expect(composerInputHeight(7 * ROW + CHROME, ROW, CHROME, null)).toBe(150);
  });

  it('stops at twelve rows, where the box scrolls', () => {
    expect(composerInputHeight(12 * ROW + CHROME, ROW, CHROME, null)).toBe(250);
    expect(composerInputHeight(30 * ROW + CHROME, ROW, CHROME, null)).toBe(250);
  });

  it('keeps a height the user dragged to as its floor', () => {
    expect(composerInputHeight(30, ROW, CHROME, 170)).toBe(170);
  });

  it('grows past a dragged height when the text needs more, up to twelve rows', () => {
    expect(composerInputHeight(9 * ROW + CHROME, ROW, CHROME, 110)).toBe(190);
    expect(composerInputHeight(30 * ROW + CHROME, ROW, CHROME, 110)).toBe(250);
  });

  it('never shorter than its text, even when dragged shorter', () => {
    expect(composerInputHeight(150, ROW, CHROME, 100)).toBe(150);
  });

  it('clamps a dragged height to the rows the box allows', () => {
    expect(composerInputHeight(30, ROW, CHROME, 40)).toBe(50);
    expect(composerInputHeight(30, ROW, CHROME, 900)).toBe(250);
  });

  it('treats a dragged height that is not a number as the idle height', () => {
    expect(composerInputHeight(30, ROW, CHROME, Number.NaN)).toBe(50);
  });

  it('rounds a fractional fit up to a whole pixel', () => {
    expect(composerInputHeight(150.2, ROW, CHROME, null)).toBe(151);
  });
});
