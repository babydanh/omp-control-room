/**
 * UsagePage: the usage page, opened from the board's "⋯" menu, the command palette, or `#usage`.
 * Three tabs read the company client's usage slots: an overview, the account limits with their
 * history, and the detailed tables. A failed refresh leaves each tab's last good data in view. The
 * page asks for its own reports (useUsageRefresh), counts down to the next one, and returns to the
 * board on Esc or from "‹ Bảng".
 */

import { useEffect } from 'react';

import type { CompanyClient } from '../../companyClient.js';
import { matchShortcut } from '../../shortcuts.js';
import { formatClock } from '../../usage/usageFormat.js';
import { USAGE_HISTORY_DAYS } from '../../usage/usageState.js';
import { useCompanyState } from '../../useCompanyState.js';
import { useUsageRefresh } from '../../useUsageRefresh.js';
import { closeUsagePage, selectUsageTab, useUsageTab } from '../../useUsageRoute.js';
import { Icon } from '../Icon.js';
import { UsageDetailsTab } from './UsageDetailsTab.js';
import { UsageLimitsTab } from './UsageLimitsTab.js';
import { UsageOverviewTab } from './UsageOverviewTab.js';
import { UsageRefreshPill } from './UsageRefreshPill.js';
import { UsageTabBar } from './UsageTabBar.js';
import { parseTime } from './usageTime.js';

export function UsagePage({ client }: { client: CompanyClient }) {
  const state = useCompanyState(client);
  const refresh = useUsageRefresh(client);
  const tab = useUsageTab();
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
      <header className="flex flex-col gap-3 bg-panel px-3 pb-3 pt-2.5 md:px-6">
        <div className="mx-auto flex w-full max-w-[90rem] flex-wrap items-center gap-x-3 gap-y-2">
          <button
            type="button"
            onClick={closeUsagePage}
            className="company-icon-btn touch-target gap-1 px-2 text-xs"
          >
            <Icon name="chevron-left" />
            Bảng
          </button>
          <span
            aria-hidden="true"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-(--company-radius-sm) bg-raised text-text-secondary"
          >
            <Icon name="bar-chart" />
          </span>
          <div className="min-w-[10rem] flex-1">
            <h1 className="truncate text-base font-semibold">Sử dụng token</h1>
            <p className="truncate text-2xs text-text-muted">
              Giới hạn tài khoản, token và chi phí của omp
            </p>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <UsageRefreshPill nextDueAt={refresh.nextDueAt} />
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
              aria-label={busy ? 'Đang làm mới' : 'Làm mới'}
              title={busy ? 'Đang làm mới…' : 'Làm mới'}
              className="company-icon-btn touch-target"
            >
              <span className={busy ? 'inline-flex animate-spin' : 'inline-flex'}>
                <Icon name="refresh" />
              </span>
            </button>
          </div>
        </div>
        <div className="mx-auto w-full max-w-[90rem]">
          <UsageTabBar
            tab={tab}
            onSelectTab={selectUsageTab}
            days={refresh.days}
            onSelectDays={refresh.selectDays}
          />
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[90rem] flex-col gap-4 px-3 py-4 md:px-6">
          {tab === 'overview' && <UsageOverviewTab stats={slots.stats} limits={slots.limits} />}
          {tab === 'limits' && <UsageLimitsTab limits={slots.limits} history={history} />}
          {tab === 'details' && (
            <UsageDetailsTab stats={slots.stats} history={history} days={refresh.days} />
          )}
        </div>
      </div>
    </div>
  );
}
