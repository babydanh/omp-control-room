/**
 * UsageCostBreakdown: spend split into input, output and cache parts, under the reported total.
 * When requests carry no price the page names that count rather than showing $0,00 as a cost.
 */

import type { UsageStatsCostPoint, UsageStatsTotals } from '../../../../../core/src/messages.js';
import { formatUsd } from '../../usage/usageFormat.js';
import { costBreakdown, costLabel } from '../../usage/usageStats.js';

/** A gap between the parts and the total below this is float noise, not unattributed spend. */
const NOISE_USD = 1e-9;

export function UsageCostBreakdown({
  points,
  totals,
}: {
  points: readonly UsageStatsCostPoint[];
  totals: UsageStatsTotals;
}) {
  const breakdown = costBreakdown(points);
  const parts = [
    { label: 'Token vào', value: breakdown.input },
    { label: 'Token ra', value: breakdown.output },
    { label: 'Đọc bộ nhớ đệm', value: breakdown.cacheRead },
    { label: 'Ghi bộ nhớ đệm', value: breakdown.cacheWrite },
  ];
  const unattributed = breakdown.total - parts.reduce((sum, part) => sum + part.value, 0);
  const rows =
    unattributed > NOISE_USD
      ? [...parts, { label: 'Chưa tách theo loại', value: unattributed }]
      : parts;
  // With no priced cost at all, the parts would only read as $0,00; the label says why instead.
  const showRows = !(totals.unpricedRequests > 0 && totals.totalCost === 0);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs tabular-nums text-text">{costLabel(totals)}</p>
      {showRows && (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => {
            const share =
              breakdown.total > 0 ? Math.min((row.value / breakdown.total) * 100, 100) : 0;
            return (
              <li key={row.label} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-2 text-2xs">
                  <span className="text-text-secondary">{row.label}</span>
                  <span className="tabular-nums text-text">{formatUsd(row.value)}</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-well">
                  <div className="h-full rounded-full bg-accent" style={{ width: `${share}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
