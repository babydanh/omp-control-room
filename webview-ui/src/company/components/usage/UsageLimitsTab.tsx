/**
 * UsageLimitsTab: every account's limits as a grid of cards, under a toolbar that filters and sorts
 * them. Accounts with no limit windows sit apart at the end, and each window's capacity across
 * accounts sits beneath the grid. A limit row opens its history inside its card.
 */

import { useState } from 'react';

import type { UsageHistoryMessage, UsageLimitsMessage } from '../../../../../core/src/messages.js';
import { formatClock } from '../../usage/usageFormat.js';
import {
  accountEntries,
  type AccountEntry,
  type AccountSort,
  accountTitle,
  arrangeAccounts,
  type CapacityLine,
  capacityLines,
  providerNames,
  snapshotStatusLabel,
  usageBarTone,
} from '../../usage/usageLimits.js';
import type { UsageSlot } from '../../usage/usageState.js';
import { type HistoryPanel, UsageAccountCard } from './UsageAccountCard.js';
import { UsageCard } from './UsageCard.js';
import { UsageMeter } from './UsageMeter.js';
import { UsageSection } from './UsageSection.js';
import { parseTime } from './usageTime.js';
import { useNowMs } from './useNowMs.js';

const LIMITS_STATUS_LABELS: Record<UsageLimitsMessage['status'], string> = {
  available: 'Đã đọc được giới hạn',
  unsupported: 'Máy này chưa hỗ trợ đọc giới hạn',
  unauthenticated: 'Chưa đăng nhập tài khoản nào',
  error: 'Không đọc được giới hạn',
};

const SORT_LABELS: Record<AccountSort, string> = {
  reset: 'Sắp đặt lại trước',
  usage: 'Dùng nhiều nhất',
};

const SORT_OPTIONS: readonly AccountSort[] = ['reset', 'usage'];

interface UsageLimitsTabProps {
  limits: UsageSlot<UsageLimitsMessage>;
  history: UsageSlot<UsageHistoryMessage>;
}

export function UsageLimitsTab({ limits, history }: UsageLimitsTabProps) {
  const data = limits.data;
  return (
    <UsageSection
      hasData={data !== null}
      loading={limits.loading}
      errorMessage={limits.errorMessage}
    >
      {data !== null && <LimitsBody data={data} history={historyPanel(history)} />}
    </UsageSection>
  );
}

/** The history the cards draw from: the entries and their span, or the reason there are none. */
function historyPanel(slot: UsageSlot<UsageHistoryMessage>): HistoryPanel {
  const data = slot.data;
  if (data === null) {
    return { note: slot.loading ? 'Đang tải lịch sử…' : (slot.errorMessage ?? 'Chưa có lịch sử.') };
  }
  const sinceMs = parseTime(data.sinceAt);
  const endMs = parseTime(data.generatedAt);
  if (sinceMs === null || endMs === null) {
    return { note: 'Không đọc được khoảng thời gian của lịch sử.' };
  }
  return { entries: data.entries, sinceMs, endMs };
}

function LimitsBody({ data, history }: { data: UsageLimitsMessage; history: HistoryPanel }) {
  const [provider, setProvider] = useState('');
  const [sort, setSort] = useState<AccountSort>('reset');
  const [hideEmpty, setHideEmpty] = useState(true);
  const nowMs = useNowMs(30_000);

  const providers = providerNames(data.snapshots);
  const selectedProvider = providers.includes(provider) ? provider : null;
  const arranged = arrangeAccounts(accountEntries(data.snapshots), {
    provider: selectedProvider,
    hideEmpty,
    sort,
    nowMs,
  });
  const capacity = capacityLines(data.capacity);
  const generatedAt = parseTime(data.generatedAt);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-2xs tabular-nums text-text-muted">
        {LIMITS_STATUS_LABELS[data.status]}
        {data.cached ? ' · từ bộ nhớ đệm' : ''}
        {generatedAt !== null ? ` · cập nhật lúc ${formatClock(generatedAt)}` : ''}
      </p>
      {data.snapshots.length === 0 ? (
        <p className="text-xs text-text-muted">Chưa có tài khoản nào được báo cáo.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {providers.length > 1 && (
              <select
                aria-label="Nhà cung cấp"
                value={selectedProvider ?? ''}
                onChange={(event) => setProvider(event.target.value)}
                className="touch-target rounded-(--company-radius-sm) bg-raised px-2 text-xs text-text"
              >
                <option value="">Tất cả nhà cung cấp</option>
                {providers.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            )}
            <div role="group" aria-label="Sắp xếp" className="flex flex-wrap gap-1">
              {SORT_OPTIONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={sort === option}
                  onClick={() => setSort(option)}
                  className="company-toggle touch-target text-xs"
                >
                  {SORT_LABELS[option]}
                </button>
              ))}
            </div>
            <button
              type="button"
              aria-pressed={hideEmpty}
              onClick={() => setHideEmpty((current) => !current)}
              className="company-toggle touch-target text-xs"
            >
              Ẩn tài khoản trống
            </button>
          </div>
          {arranged.shown.length === 0 ? (
            <p className="text-xs text-text-muted">Không có tài khoản nào khớp bộ lọc.</p>
          ) : (
            <div className="grid gap-3 min-[1100px]:grid-cols-2">
              {arranged.shown.map((entry) => (
                <UsageAccountCard key={entry.key} snapshot={entry.snapshot} history={history} />
              ))}
            </div>
          )}
          {arranged.hidden.length > 0 && <HiddenAccounts entries={arranged.hidden} />}
        </>
      )}
      {capacity.length > 0 && <CapacityCard lines={capacity} />}
    </div>
  );
}

/** The accounts the grid leaves out: they have no limit windows, so only their notes show. */
function HiddenAccounts({ entries }: { entries: readonly AccountEntry[] }) {
  return (
    <section aria-label="Tài khoản không có giới hạn" className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-text-secondary">
        Tài khoản không có giới hạn ({entries.length})
      </h3>
      <ul className="flex flex-col gap-1 text-2xs text-text-muted">
        {entries.map((entry) => (
          <li key={entry.key} className="truncate">
            {entry.snapshot.provider} · {accountTitle(entry.snapshot)} ·{' '}
            {entry.snapshot.note ?? snapshotStatusLabel(entry.snapshot.status)}
          </li>
        ))}
      </ul>
    </section>
  );
}

function CapacityCard({ lines }: { lines: readonly CapacityLine[] }) {
  return (
    <UsageCard title="Sức chứa theo cửa sổ" aside="Số tài khoản còn chỗ trong mỗi cửa sổ">
      <ul className="flex flex-col gap-3">
        {lines.map((line) => (
          <li
            key={line.key}
            className="grid min-w-0 items-center gap-x-3 gap-y-1 md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)_3.5rem]"
          >
            <div className="min-w-0">
              <p className="truncate text-xs text-text">{line.title}</p>
              <p className="truncate text-2xs text-text-muted">{line.provider}</p>
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <p className="text-2xs tabular-nums text-text-muted">
                {line.usedText} · {line.remainingText}
              </p>
              {line.usedFraction !== null && (
                <UsageMeter fraction={line.usedFraction} tone={usageBarTone(line.usedFraction)} />
              )}
            </div>
            <span className="text-right text-xs tabular-nums text-text">
              {line.usedPercentText}
            </span>
          </li>
        ))}
      </ul>
    </UsageCard>
  );
}
