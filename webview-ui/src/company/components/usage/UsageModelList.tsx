/**
 * UsageModelList: the models of the usage window ranked by cost, each with its provider, requests,
 * and tokens in (↑) and out (↓). The list scrolls inside its card, so a long list cannot stretch the
 * page.
 */

import type { UsageStatsModelRow } from '../../../../../core/src/messages.js';
import { formatCount, formatTokens } from '../../usage/usageFormat.js';
import { costLabel, sortRows } from '../../usage/usageStats.js';

export function UsageModelList({ rows }: { rows: readonly UsageStatsModelRow[] }) {
  if (rows.length === 0) {
    return <p className="text-xs text-text-muted">Chưa có mô hình nào trong dữ liệu đã đọc.</p>;
  }
  const ordered = sortRows(rows, 'cost', 'desc', (row) => row.totals.totalCost);
  return (
    <ul className="flex max-h-[26rem] flex-col gap-0.5 overflow-y-auto">
      {ordered.map((row) => (
        <li
          key={`${row.provider}/${row.model}`}
          className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 rounded-(--company-radius-sm) px-2 py-1.5 hover:bg-hover"
        >
          <span className="min-w-0 truncate text-xs text-text">{row.model}</span>
          <span className="text-right text-xs tabular-nums text-text">{costLabel(row.totals)}</span>
          <span className="min-w-0 truncate text-2xs text-text-muted">
            {row.provider} · {formatCount(row.totals.totalRequests)} yêu cầu
          </span>
          <span className="whitespace-nowrap text-right text-2xs tabular-nums">
            <span className="text-accent">↑ {formatTokens(row.totals.totalInputTokens)}</span>{' '}
            <span className="text-status-success">
              ↓ {formatTokens(row.totals.totalOutputTokens)}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
