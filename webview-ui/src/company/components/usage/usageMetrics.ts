/**
 * usageMetrics: latency and generation speed as the usage page shows them. A missing sample
 * reads as a dash, never as zero.
 */

import { formatCount, MISSING_TEXT } from '../../usage/usageFormat.js';

/** A time to first token in ms, rounded to a whole millisecond. */
export function milliText(ms: number | null): string {
  return ms === null || !Number.isFinite(ms) ? MISSING_TEXT : `${formatCount(Math.round(ms))} ms`;
}

/** A generation speed in tokens per second, rounded to a whole token. */
export function speedText(tokensPerSecond: number | null): string {
  if (tokensPerSecond === null || !Number.isFinite(tokensPerSecond)) return MISSING_TEXT;
  return `${formatCount(Math.round(tokensPerSecond))} tok/s`;
}
