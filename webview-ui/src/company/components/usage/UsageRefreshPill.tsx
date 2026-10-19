/**
 * UsageRefreshPill: when the page next asks the server for fresh reports, counted down to the
 * second. The countdown follows the soonest of the three report schedules.
 */

import { formatCountdownClock } from '../../usage/usageFormat.js';
import { useNowMs } from './useNowMs.js';

interface UsageRefreshPillProps {
  nextDueAt: () => number;
}

export function UsageRefreshPill({ nextDueAt }: UsageRefreshPillProps) {
  const nowMs = useNowMs(1_000);
  const remainingMs = Math.max(0, nextDueAt() - nowMs);
  return (
    <span
      title="Trang tự làm mới số liệu khi đang hiện"
      className="inline-flex items-center gap-1.5 rounded-full bg-raised px-2.5 py-1 text-2xs tabular-nums text-text-secondary"
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-status-success" />
      Tự làm mới · {formatCountdownClock(remainingMs)}
    </span>
  );
}
