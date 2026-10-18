/**
 * composerHeight: how tall the composer's text box is for the text it holds.
 *
 * The box is one row when it is empty, grows a row for each line of text, and
 * stops at COMPOSER_MAX_ROWS rows, where it scrolls. Pure, so the clamp is tested
 * without a DOM; the composer measures the box and passes the numbers in.
 */

import { COMPOSER_MAX_ROWS } from './constants.js';

/**
 * The box's border-box height in pixels.
 *
 * @param fitPx the border-box height that fits all the text, as measured
 * @param rowPx the height of one line of text
 * @param chromePx the box's padding and border: the space around its text rows
 */
export function composerInputHeight(fitPx: number, rowPx: number, chromePx: number): number {
  const shortest = rowPx + chromePx;
  const tallest = COMPOSER_MAX_ROWS * rowPx + chromePx;
  return Math.min(tallest, Math.max(shortest, Math.ceil(fitPx)));
}
