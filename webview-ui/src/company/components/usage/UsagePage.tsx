/**
 * UsagePage: the usage page, opened from the board's "⋯" menu, the command palette, or `#usage`.
 * Three sections read the company client's usage slots: accounts and limits, limit history, and
 * tokens and cost. A failed refresh leaves each section's last good data in view. The page asks
 * for its own reports (useUsageRefresh) and returns to the board on Esc or from "Bảng".
 */

import { useEffect } from 'react';

import type { CompanyClient } from '../../companyClient.js';
import { matchShortcut } from '../../shortcuts.js';
import { formatClock } from '../../usage/usageFormat.js';
import { USAGE_HISTORY_DAYS } from '../../usage/usageState.js';
import { useCompanyState } from '../../useCompanyState.js';
import { useUsageRefresh } from '../../useUsageRefresh.js';
import { closeUsagePage } from '../../useUsageRoute.js';
import { Icon } from '../Icon.js';
import { UsageClientSection } from './UsageClientSection.js';
import { UsageHistorySection } from './UsageHistorySection.js';
import { UsageLimitsSection } from './UsageLimitsSection.js';
import { parseTime } from './usageTime.js';
import { UsageTokenSection } from './UsageTokenSection.js';

export function UsagePage({ client }: { client: CompanyClient }) {
  const state = useCompanyState(client);
  const refresh = useUsageRefresh(client);
  const slots = state.usageSlots;
  const history = slots.history[refresh.days];
  const busy =
    slots.limits.loading ||
    slots.stats.loading ||
    USAGE_HISTORY_DAYS.some((days) => slots.history[days].loading);

  const stamps = [
    slots.limits.data?.generatedAt,
    history.data?.generatedAt,
    slots.stats.data?.generatedAt,
  ]
    .map(parseTime)
    .filter((ms): ms is number => ms !== null);
  const updatedAt = stamps.length > 0 ? Math.max(...stamps) : null;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (matchShortcut('board.escape', event)) closeUsagePage();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="company-ui flex h-full min-h-0 w-full flex-col overflow-hidden bg-bg text-text">
      <header className="flex flex-wrap items-center gap-2 border-b border-hairline px-3 py-2 md:px-6">
        <button
          type="button"
          onClick={closeUsagePage}
          className="company-icon-btn touch-target gap-1 px-2 text-xs"
        >
          <Icon name="chevron-left" />
          Bảng
        </button>
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold">Sử dụng token</h1>
        {updatedAt !== null && (
          <span className="text-2xs tabular-nums text-text-muted">
            Cập nhật lúc {formatClock(updatedAt)}
          </span>
        )}
        <button
          type="button"
          onClick={refresh.refreshAll}
          disabled={busy}
          aria-busy={busy}
          className="company-btn company-btn-md touch-target gap-1.5"
        >
          <Icon name="refresh" />
          {busy ? 'Đang làm mới…' : 'Làm mới'}
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-3 py-4 md:px-6">
          <UsageLimitsSection slot={slots.limits} />
          <UsageHistorySection
            slot={history}
            days={refresh.days}
            onSelectDays={refresh.selectDays}
          />
          {history.data !== null && <UsageClientSection clients={history.data.clients} />}
          <UsageTokenSection slot={slots.stats} />
        </div>
      </div>
    </div>
  );
}
