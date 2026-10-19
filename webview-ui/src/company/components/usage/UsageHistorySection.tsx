/**
 * UsageHistorySection: how each account's limit share moved over the chosen window, one chart per
 * account and limit. The window toggle asks the server for that window's history.
 */

import type { UsageHistoryMessage } from '../../../../../core/src/messages.js';
import { buildHistorySeries } from '../../usage/usageHistory.js';
import {
  USAGE_HISTORY_DAYS,
  type UsageHistoryDays,
  type UsageSlot,
} from '../../usage/usageState.js';
import { UsageHistoryChart } from './UsageHistoryChart.js';
import { UsageSection } from './UsageSection.js';
import { parseTime, WHEN_FORMAT } from './usageTime.js';

const DAY_LABELS: Record<UsageHistoryDays, string> = {
  1: '1 ngày',
  7: '7 ngày',
  30: '30 ngày',
};

interface UsageHistorySectionProps {
  slot: UsageSlot<UsageHistoryMessage>;
  days: UsageHistoryDays;
  onSelectDays: (days: UsageHistoryDays) => void;
}

export function UsageHistorySection({ slot, days, onSelectDays }: UsageHistorySectionProps) {
  const data = slot.data;
  const controls = (
    <div role="group" aria-label="Khoảng thời gian" className="flex flex-wrap gap-1">
      {USAGE_HISTORY_DAYS.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={option === days}
          onClick={() => onSelectDays(option)}
          className="company-toggle touch-target text-xs"
        >
          {DAY_LABELS[option]}
        </button>
      ))}
    </div>
  );
  return (
    <UsageSection
      title="Lịch sử giới hạn"
      hasData={data !== null}
      loading={slot.loading}
      errorMessage={slot.errorMessage}
      controls={controls}
    >
      {data !== null && <HistoryBody data={data} />}
    </UsageSection>
  );
}

function HistoryBody({ data }: { data: UsageHistoryMessage }) {
  const sinceMs = parseTime(data.sinceAt);
  const endMs = parseTime(data.generatedAt);
  if (sinceMs === null || endMs === null) {
    return <p className="text-xs text-text-muted">Không đọc được khoảng thời gian của lịch sử.</p>;
  }
  const series = buildHistorySeries(data.entries, sinceMs);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-2xs tabular-nums text-text-muted">
        Từ {WHEN_FORMAT.format(sinceMs)} đến {WHEN_FORMAT.format(endMs)}
      </p>
      {series.length === 0 ? (
        <p className="text-xs text-text-muted">Chưa có mẫu nào trong khoảng này.</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {series.map((item) => (
            <UsageHistoryChart key={item.key} series={item} sinceMs={sinceMs} endMs={endMs} />
          ))}
        </div>
      )}
    </div>
  );
}
