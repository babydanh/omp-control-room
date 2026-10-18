/**
 * composerHeight: how tall the composer's text box is for the text it holds.
 *
 * The box idles at COMPOSER_MIN_ROWS rows and grows with its text, up to
 * COMPOSER_MAX_ROWS rows, where it scrolls. A height the user dragged the box to is
 * a floor it keeps, and the text can still grow it up to the maximum. The box never
 * gets shorter than its text, so a drag cannot hide words the box could show.
 * Pure, so the clamp is tested without a DOM; the composer measures the box and
 * passes the numbers in.
 */

import { COMPOSER_MAX_ROWS, COMPOSER_MIN_ROWS } from './constants.js';

/**
 * The box's border-box height in pixels.
 *
 * @param fitPx the border-box height that fits all the text, as measured
 * @param rowPx the height of one line of text
 * @param chromePx the box's padding and border: the space around its text rows
 * @param savedPx the height the user dragged the box to, or null when they have not
 */
export function composerInputHeight(
  fitPx: number,
  rowPx: number,
  chromePx: number,
  savedPx: number | null,
): number {
  const shortest = COMPOSER_MIN_ROWS * rowPx + chromePx;
  const tallest = COMPOSER_MAX_ROWS * rowPx + chromePx;
  const kept = savedPx === null ? shortest : clamp(savedPx, shortest, tallest);
  return Math.min(tallest, Math.max(kept, Math.ceil(fitPx)));
}

/** A value clamped to a range; a value that is not a number takes the bottom of the range. */
function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, Number.isFinite(value) ? value : low));
}
