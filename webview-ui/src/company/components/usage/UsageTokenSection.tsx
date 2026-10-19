/**
 * UsageTokenSection: the token and cost picture for the stats window the server covers: totals,
 * the hourly series, the cost split, model performance, and the breakdown tables.
 */

import type { UsageStatsMessage, UsageStatsTotals } from '../../../../../core/src/messages.js';
import type { UsageSlot } from '../../usage/usageState.js';
import { UsageCostBreakdown } from './UsageCostBreakdown.js';
import { UsageSection } from './UsageSection.js';
import { ModelPerformanceTable, UsageTables } from './UsageTables.js';
import { parseTime, WHEN_FORMAT } from './usageTime.js';
import { UsageTimeChart } from './UsageTimeChart.js';
import { UsageTotals } from './UsageTotals.js';

export function UsageTokenSection({ slot }: { slot: UsageSlot<UsageStatsMessage> }) {
  const data = slot.data;
  return (
    <UsageSection
      title="Token và chi phí"
      hasData={data !== null}
      loading={slot.loading}
      errorMessage={slot.errorMessage}
    >
      {data !== null && <TokenBody data={data} />}
    </UsageSection>
  );
}

function TokenBody({ data }: { data: UsageStatsMessage }) {
  return (
    <div className="flex flex-col gap-6">
      <CoverageNote totals={data.overall} />
      <UsageTotals totals={data.overall} />
      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold text-text-secondary">Token theo giờ</h3>
        <UsageTimeChart points={data.timeSeries} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <UsageCostBreakdown points={data.costSeries} totals={data.overall} />
        <ModelPerformanceTable points={data.modelPerformanceSeries} />
      </div>
      <UsageTables data={data} />
    </div>
  );
}

function CoverageNote({ totals }: { totals: UsageStatsTotals }) {
  const first = parseTime(totals.firstAt);
  const last = parseTime(totals.lastAt);
  if (first === null || last === null) {
    return <p className="text-2xs text-text-muted">Chưa có yêu cầu nào trong dữ liệu đã đọc.</p>;
  }
  return (
    <p className="text-2xs tabular-nums text-text-muted">
      Dữ liệu phủ từ {WHEN_FORMAT.format(first)} đến {WHEN_FORMAT.format(last)}.
    </p>
  );
}
