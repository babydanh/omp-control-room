/**
 * scrollPin: whether a scrolling view should keep following its newest line.
 *
 * A log, a screen or a command list opens at its newest line and stays there
 * while new lines arrive. It stops following once the user scrolls up past the
 * threshold, and follows again when they scroll back down to the bottom.
 *
 * Pure and DOM-free: the hook reads an element's metrics and asks here.
 */

/** Pixels from the bottom that still count as "at the bottom". */
export const PIN_THRESHOLD_PX = 24;

/** The three numbers a scroll container reports about its position. */
export interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

/** True when the view shows its newest line, or is within the threshold of it. */
export function isPinnedToBottom(metrics: ScrollMetrics): boolean {
  const distance = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
  return distance < PIN_THRESHOLD_PX;
}
