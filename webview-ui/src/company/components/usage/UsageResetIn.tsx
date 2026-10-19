/**
 * UsageResetIn: the time left until a window resets, ticking while the page is open. It renders
 * nothing when the reset time cannot be read, so no countdown is invented.
 */

import { formatResetIn } from '../../usage/usageFormat.js';
import { parseTime } from './usageTime.js';
import { useNowMs } from './useNowMs.js';

interface UsageResetInProps {
  resetAt: string | undefined;
  className?: string;
}

export function UsageResetIn({ resetAt, className = '' }: UsageResetInProps) {
  const nowMs = useNowMs(1_000);
  const resetMs = parseTime(resetAt);
  if (resetMs === null) return null;
  return <span className={`tabular-nums ${className}`}>{formatResetIn(resetMs, nowMs)}</span>;
}
