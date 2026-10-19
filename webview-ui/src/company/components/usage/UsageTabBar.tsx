/**
 * UsageTabBar: the page's three tabs, and the history window the tabs that show history use. Each
 * button's pressed state names it, so the current tab reads without colour.
 */

import { HISTORY_DAY_LABELS } from '../../usage/usageLabels.js';
import { USAGE_TABS, type UsageTab } from '../../usage/usageRoute.js';
import { USAGE_HISTORY_DAYS, type UsageHistoryDays } from '../../usage/usageState.js';

const TAB_LABELS: Record<UsageTab, string> = {
  overview: 'Tổng quan',
  limits: 'Giới hạn',
  details: 'Chi tiết',
};

interface UsageTabBarProps {
  tab: UsageTab;
  onSelectTab: (tab: UsageTab) => void;
  days: UsageHistoryDays;
  onSelectDays: (days: UsageHistoryDays) => void;
}

export function UsageTabBar({ tab, onSelectTab, days, onSelectDays }: UsageTabBarProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div
        role="group"
        aria-label="Trang sử dụng"
        className="inline-flex rounded-(--company-radius-md) bg-well p-0.5"
      >
        {USAGE_TABS.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={option === tab}
            onClick={() => onSelectTab(option)}
            className="touch-target rounded-(--company-radius-sm) px-3 py-1.5 text-xs text-text-muted hover:text-text aria-pressed:bg-raised aria-pressed:text-text"
          >
            {TAB_LABELS[option]}
          </button>
        ))}
      </div>
      {tab !== 'overview' && (
        <div role="group" aria-label="Khoảng thời gian" className="flex flex-wrap gap-1">
          {USAGE_HISTORY_DAYS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={option === days}
              onClick={() => onSelectDays(option)}
              className="company-toggle touch-target text-xs"
            >
              {HISTORY_DAY_LABELS[option]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
