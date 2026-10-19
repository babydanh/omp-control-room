/**
 * UsageDetailsTab: the full breakdown behind the overview. Cost by kind and the remaining figures
 * come first, then the tables by model, folder, agent type, and model performance. The per-client
 * burn over the history window follows when the server reports clients.
 */

import type {
  UsageHistoryMessage,
  UsageStatsMessage,
  UsageStatsTotals,
} from '../../../../../core/src/messages.js';
import { formatPercent, formatTokens } from '../../usage/usageFormat.js';
import { HISTORY_DAY_LABELS } from '../../usage/usageLabels.js';
import type { UsageHistoryDays, UsageSlot } from '../../usage/usageState.js';
import { cacheRateLabel } from '../../usage/usageStats.js';
import { UsageCard } from './UsageCard.js';
import { UsageClientSection } from './UsageClientSection.js';
import { UsageCostBreakdown } from './UsageCostBreakdown.js';
import { milliText, speedText } from './usageMetrics.js';
import { UsageSection } from './UsageSection.js';
import { ModelPerformanceTable, UsageTables } from './UsageTables.js';

interface UsageDetailsTabProps {
  stats: UsageSlot<UsageStatsMessage>;
  history: UsageSlot<UsageHistoryMessage>;
  days: UsageHistoryDays;
}

export function UsageDetailsTab({ stats, history, days }: UsageDetailsTabProps) {
  const data = stats.data;
  const clients = history.data?.clients ?? [];
  return (
    <div className="flex flex-col gap-4">
      <UsageSection
        hasData={data !== null}
        loading={stats.loading}
        errorMessage={stats.errorMessage}
      >
        {data !== null && (
          <div className="grid gap-4 lg:grid-cols-2">
            <UsageCard title="Chi phí theo loại">
              <UsageCostBreakdown points={data.costSeries} totals={data.overall} />
            </UsageCard>
            <UsageCard title="Chỉ số khác">
              <ExtraFigures totals={data.overall} />
            </UsageCard>
            <UsageTables data={data} />
            <ModelPerformanceTable points={data.modelPerformanceSeries} />
          </div>
        )}
      </UsageSection>
      {history.errorMessage !== null && (
        <p role="alert" className="text-2xs text-danger">
          {history.errorMessage}
        </p>
      )}
      {clients.length > 0 && (
        <UsageCard title="Theo máy khách" aside={`${HISTORY_DAY_LABELS[days]} gần nhất`}>
          <UsageClientSection clients={clients} />
        </UsageCard>
      )}
    </div>
  );
}

function ExtraFigures({ totals }: { totals: UsageStatsTotals }) {
  const figures = [
    { label: 'Ghi bộ nhớ đệm', value: formatTokens(totals.totalCacheWriteTokens) },
    { label: 'Trúng bộ nhớ đệm', value: cacheRateLabel(totals) },
    {
      label: 'Tiết kiệm nhờ bộ nhớ đệm',
      // cacheSavings arrives unchanged from OMP and is read as a fraction of input cost.
      value: `${formatPercent(totals.cacheSavings)} chi phí đầu vào`,
    },
    { label: 'Tới token đầu tiên', value: milliText(totals.avgTtft ?? null) },
    { label: 'Tốc độ trung bình', value: speedText(totals.avgTokensPerSecond ?? null) },
  ];
  return (
    <dl className="grid gap-3 sm:grid-cols-2">
      {figures.map((figure) => (
        <div key={figure.label} className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-2xs text-text-muted">{figure.label}</dt>
          <dd className="text-xs tabular-nums text-text">{figure.value}</dd>
        </div>
      ))}
    </dl>
  );
}
