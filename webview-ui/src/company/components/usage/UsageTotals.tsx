/**
 * UsageTotals: the overall request, token, cache and cost figures as a grid of tiles. The cost
 * and cache-rate tiles span two columns, since their labels name what they count.
 */

import type { UsageStatsTotals } from '../../../../../core/src/messages.js';
import { formatCount, formatPercent, formatTokens } from '../../usage/usageFormat.js';
import { cacheRateLabel, costLabel } from '../../usage/usageStats.js';
import { milliText, speedText } from './usageMetrics.js';

interface Tile {
  label: string;
  value: string;
  hint?: string;
  wide?: boolean;
}

export function UsageTotals({ totals }: { totals: UsageStatsTotals }) {
  const tiles: Tile[] = [
    {
      label: 'Yêu cầu',
      value: formatCount(totals.totalRequests),
      hint: `${formatCount(totals.failedRequests)} lỗi · ${formatPercent(totals.errorRate)}`,
    },
    { label: 'Token vào', value: formatTokens(totals.totalInputTokens) },
    { label: 'Token ra', value: formatTokens(totals.totalOutputTokens) },
    { label: 'Đọc bộ nhớ đệm', value: formatTokens(totals.totalCacheReadTokens) },
    { label: 'Ghi bộ nhớ đệm', value: formatTokens(totals.totalCacheWriteTokens) },
    { label: 'Trúng bộ nhớ đệm', value: cacheRateLabel(totals), wide: true },
    { label: 'Chi phí', value: costLabel(totals), wide: true },
    // omp reports this as a share of the uncached prompt cost (0-1, negative when cache writes cost more).
    {
      label: 'Tiết kiệm nhờ bộ nhớ đệm',
      value: `${formatPercent(totals.cacheSavings)} chi phí đầu vào`,
    },
    { label: 'Tới token đầu tiên', value: milliText(totals.avgTtft ?? null) },
    { label: 'Tốc độ trung bình', value: speedText(totals.avgTokensPerSecond ?? null) },
  ];

  return (
    <dl className="grid grid-cols-2 gap-2 md:grid-cols-4">
      {tiles.map((tile) => (
        <div
          key={tile.label}
          className={`flex min-w-0 flex-col gap-0.5 rounded-(--company-radius-sm) bg-raised p-2.5${
            tile.wide ? ' col-span-2' : ''
          }`}
        >
          <dt className="text-2xs text-text-muted">{tile.label}</dt>
          <dd className="text-sm tabular-nums text-text">{tile.value}</dd>
          {tile.hint !== undefined && <dd className="text-2xs text-text-secondary">{tile.hint}</dd>}
        </div>
      ))}
    </dl>
  );
}
