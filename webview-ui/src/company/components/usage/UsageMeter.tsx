/**
 * UsageMeter: a thin bar for the share of a limit used, in the colour of its band. The bar is
 * decorative: the share is also written beside it, so colour is never the only reading.
 */

import type { UsageBarTone } from '../../usage/usageLimits.js';

const FILL: Record<UsageBarTone, string> = {
  ok: 'bg-status-success',
  warn: 'bg-caution',
  danger: 'bg-danger',
};

interface UsageMeterProps {
  fraction: number;
  tone: UsageBarTone;
}

export function UsageMeter({ fraction, tone }: UsageMeterProps) {
  const width = Math.min(Math.max(fraction, 0), 1) * 100;
  return (
    <span aria-hidden="true" className="block h-1.5 w-full overflow-hidden rounded-full bg-well">
      <span className={`block h-full rounded-full ${FILL[tone]}`} style={{ width: `${width}%` }} />
    </span>
  );
}
