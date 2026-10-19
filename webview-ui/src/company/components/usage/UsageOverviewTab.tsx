/**
 * UsageOverviewTab: the summary of the usage window. Five figures on top; the hourly chart beside
 * the models list; below, the limit windows nearest their cap across all accounts.
 */

import type {
  UsageLimitsMessage,
  UsageStatsMessage,
  UsageStatsTotals,
} from '../../../../../core/src/messages.js';
import type { UsageSlot } from '../../usage/usageState.js';
import { UsageCard } from './UsageCard.js';
import { UsageKpis } from './UsageKpis.js';
import { UsageModelList } from './UsageModelList.js';
import { UsageNearLimit } from './UsageNearLimit.js';
import { UsageSection } from './UsageSection.js';
import { parseTime, WHEN_FORMAT } from './usageTime.js';
import { UsageTimeChart } from './UsageTimeChart.js';

interface UsageOverviewTabProps {
  stats: UsageSlot<UsageStatsMessage>;
  limits: UsageSlot<UsageLimitsMessage>;
}

export function UsageOverviewTab({ stats, limits }: UsageOverviewTabProps) {
  const data = stats.data;
  return (
    <div className="flex flex-col gap-4">
      <UsageSection
        hasData={data !== null}
        loading={stats.loading}
        errorMessage={stats.errorMessage}
      >
        {data !== null && (
          <div className="flex flex-col gap-4">
            <CoverageNote totals={data.overall} />
            <UsageKpis totals={data.overall} />
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
              <UsageCard title="Token theo giờ">
                <UsageTimeChart points={data.timeSeries} />
              </UsageCard>
              <UsageCard title="Theo mô hình">
                <UsageModelList rows={data.byModel} />
              </UsageCard>
            </div>
          </div>
        )}
      </UsageSection>
      <UsageSection
        hasData={limits.data !== null}
        loading={limits.loading}
        errorMessage={limits.errorMessage}
      >
        {limits.data !== null && (
          <UsageCard title="Giới hạn sắp chạm" aside="Cao nhất trên mọi tài khoản">
            <UsageNearLimit snapshots={limits.data.snapshots} />
          </UsageCard>
        )}
      </UsageSection>
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
