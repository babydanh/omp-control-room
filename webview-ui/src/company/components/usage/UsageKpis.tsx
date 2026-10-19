/**
 * UsageKpis: the five headline figures of the usage window, each in its own colour: requests in the
 * text colour, input tokens in the accent, cache reads in blue, output tokens in green, and the
 * estimated cost in amber. Each figure names what it counts beneath it.
 */

import type { UsageStatsTotals } from '../../../../../core/src/messages.js';
import { formatCount, formatPercent, formatTokens, formatUsd } from '../../usage/usageFormat.js';
import { cacheReadShare } from '../../usage/usageStats.js';

type KpiTone = 'neutral' | 'input' | 'cache' | 'output' | 'cost';

const KPI_TONE: Record<KpiTone, string> = {
  neutral: 'text-text',
  input: 'text-accent',
  cache: 'text-status-active',
  output: 'text-status-success',
  cost: 'text-caution',
};

interface Kpi {
  label: string;
  value: string;
  note?: string;
  tone: KpiTone;
}

function kpis(totals: UsageStatsTotals): Kpi[] {
  const share = cacheReadShare(totals);
  const unpricedOnly = totals.unpricedRequests > 0 && totals.totalCost === 0;
  return [
    {
      label: 'Yêu cầu',
      value: formatCount(totals.totalRequests),
      note: `${formatCount(totals.failedRequests)} lỗi · ${formatPercent(totals.errorRate)}`,
      tone: 'neutral',
    },
    { label: 'Token vào', value: formatTokens(totals.totalInputTokens), tone: 'input' },
    {
      label: 'Đọc bộ nhớ đệm',
      value: formatTokens(totals.totalCacheReadTokens),
      note:
        share === null
          ? 'Chưa có token để tính tỷ lệ'
          : `${formatPercent(share)} token đầu vào từ bộ nhớ đệm`,
      tone: 'cache',
    },
    { label: 'Token ra', value: formatTokens(totals.totalOutputTokens), tone: 'output' },
    {
      label: 'Chi phí',
      value: unpricedOnly ? 'Chưa có giá' : formatUsd(totals.totalCost),
      note:
        totals.unpricedRequests > 0
          ? `Ước tính · ${formatCount(totals.unpricedRequests)} yêu cầu chưa có giá`
          : 'Ước tính',
      tone: 'cost',
    },
  ];
}

export function UsageKpis({ totals }: { totals: UsageStatsTotals }) {
  const items = kpis(totals);
  return (
    <dl className="grid grid-cols-2 gap-2 md:grid-cols-5">
      {items.map((item, index) => (
        <div
          key={item.label}
          className={`flex min-w-0 flex-col gap-1 rounded-(--company-radius-md) bg-raised p-4${
            index === items.length - 1 ? ' col-span-2 md:col-span-1' : ''
          }`}
        >
          <dt className="truncate text-2xs uppercase tracking-wide text-text-muted">
            {item.label}
          </dt>
          <dd className={`text-2xl font-semibold tabular-nums ${KPI_TONE[item.tone]}`}>
            {item.value}
          </dd>
          {item.note !== undefined && <dd className="text-2xs text-text-muted">{item.note}</dd>}
        </div>
      ))}
    </dl>
  );
}
