/**
 * UsageLimitsSection: every account's limit windows, grouped by provider, and the capacity rows
 * that say how many accounts still have room in each window. The server's English diagnostic
 * message stays out of view; the status words here stand in for it.
 */

import type { UsageLimitsMessage } from '../../../../../core/src/messages.js';
import { formatClock } from '../../usage/usageFormat.js';
import { type CapacityLine, capacityLines, groupSnapshots } from '../../usage/usageLimits.js';
import type { UsageSlot } from '../../usage/usageState.js';
import { UsageLimitCard } from './UsageLimitCard.js';
import { UsageSection } from './UsageSection.js';
import { parseTime } from './usageTime.js';

const LIMITS_STATUS_LABELS: Record<UsageLimitsMessage['status'], string> = {
  available: 'Đã đọc được giới hạn',
  unsupported: 'Máy này chưa hỗ trợ đọc giới hạn',
  unauthenticated: 'Chưa đăng nhập tài khoản nào',
  error: 'Không đọc được giới hạn',
};

export function UsageLimitsSection({ slot }: { slot: UsageSlot<UsageLimitsMessage> }) {
  const data = slot.data;
  return (
    <UsageSection
      title="Tài khoản và giới hạn"
      hasData={data !== null}
      loading={slot.loading}
      errorMessage={slot.errorMessage}
    >
      {data !== null && <LimitsBody data={data} />}
    </UsageSection>
  );
}

function LimitsBody({ data }: { data: UsageLimitsMessage }) {
  const groups = groupSnapshots(data.snapshots);
  const capacity = capacityLines(data.capacity);
  const generatedAt = parseTime(data.generatedAt);
  return (
    <div className="flex flex-col gap-5">
      <p className="text-2xs text-text-muted">
        {LIMITS_STATUS_LABELS[data.status]}
        {data.cached ? ' · từ bộ nhớ đệm' : ''}
        {generatedAt !== null ? ` · cập nhật lúc ${formatClock(generatedAt)}` : ''}
      </p>
      {groups.length === 0 && (
        <p className="text-xs text-text-muted">Chưa có tài khoản nào được báo cáo.</p>
      )}
      {groups.map((group) => (
        <div key={group.provider} className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-text-secondary">{group.provider}</h3>
          <div className="grid gap-3 lg:grid-cols-2">
            {group.accounts.map((account) => (
              <UsageLimitCard key={account.key} snapshot={account.snapshot} />
            ))}
          </div>
        </div>
      ))}
      {capacity.length > 0 && <CapacityBlock lines={capacity} />}
    </div>
  );
}

function CapacityBlock({ lines }: { lines: readonly CapacityLine[] }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold text-text-secondary">Sức chứa theo cửa sổ</h3>
      <div className="grid gap-3 lg:grid-cols-2">
        {lines.map((line) => {
          const meter =
            line.usedFraction === null ? null : Math.min(Math.max(line.usedFraction, 0), 1);
          return (
            <div
              key={line.key}
              className="flex min-w-0 flex-col gap-1.5 rounded-(--company-radius-md) bg-raised p-3"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-2xs">
                <span className="min-w-0 truncate text-text">
                  {line.provider} · {line.title}
                </span>
                <span className="shrink-0 text-text-muted">{line.durationText}</span>
              </div>
              {meter !== null && (
                <div
                  role="progressbar"
                  aria-label={`${line.provider} ${line.title}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(meter * 100)}
                  className="h-1.5 w-full overflow-hidden rounded-full bg-well"
                >
                  <div
                    className="h-full rounded-full bg-status-active"
                    style={{ width: `${meter * 100}%` }}
                  />
                </div>
              )}
              <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-2xs">
                <span className="text-text-secondary">{line.usedText}</span>
                <span className="tabular-nums text-text">{line.usedPercentText}</span>
              </div>
              <span className="text-2xs text-text-muted">{line.remainingText}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
