import { describe, expect, it } from 'vitest';

import { isPinnedToBottom, PIN_THRESHOLD_PX } from '../src/company/scrollPin.js';

/** A 600px view of 1000px of content, scrolled so `distance` px remain below it. */
function viewAt(distance: number) {
  return { scrollHeight: 1000, clientHeight: 600, scrollTop: 400 - distance };
}

describe('isPinnedToBottom', () => {
  it('pins a view that shows its newest line', () => {
    expect(isPinnedToBottom(viewAt(0))).toBe(true);
  });

  it('keeps following while the user is within the threshold of the bottom', () => {
    expect(isPinnedToBottom(viewAt(PIN_THRESHOLD_PX - 1))).toBe(true);
  });

  it('lets go once the user is a threshold above the bottom', () => {
    expect(isPinnedToBottom(viewAt(PIN_THRESHOLD_PX))).toBe(false);
  });

  it('lets go when the user scrolls to the top', () => {
    expect(isPinnedToBottom(viewAt(400))).toBe(false);
  });

  it('pins content shorter than the view, which cannot scroll', () => {
    expect(isPinnedToBottom({ scrollHeight: 300, clientHeight: 600, scrollTop: 0 })).toBe(true);
  });

  it('pins again once the user scrolls back to the bottom', () => {
    expect(isPinnedToBottom(viewAt(400))).toBe(false);
    expect(isPinnedToBottom(viewAt(0))).toBe(true);
  });
});
