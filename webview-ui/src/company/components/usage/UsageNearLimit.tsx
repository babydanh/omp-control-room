/**
 * UsageNearLimit: the limit windows nearest their cap across every account, most used first, one
 * row each: the window and its account, the bar, the share, and the time until it resets.
 */

import type { QuotaSnapshot } from '../../../../../core/src/messages.js';
import { formatPercent } from '../../usage/usageFormat.js';
import { windowName } from '../../usage/usageLabels.js';
import { nearLimitWindows, usageBarTone } from '../../usage/usageLimits.js';
import { UsageMeter } from './UsageMeter.js';
import { UsageResetIn } from './UsageResetIn.js';
import { TONE_TEXT } from './usageToneStyle.js';

const NEAR_LIMIT_COUNT = 4;

export function UsageNearLimit({ snapshots }: { snapshots: readonly QuotaSnapshot[] }) {
  const items = nearLimitWindows(snapshots, NEAR_LIMIT_COUNT);
  if (items.length === 0) {
    return <p className="text-xs text-text-muted">Chưa có giới hạn nào có mức dùng.</p>;
  }
  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => {
        const tone = usageBarTone(item.usedFraction, item.quotaWindow.status === 'exhausted');
        return (
          <li
            key={item.key}
            className="grid min-w-0 items-center gap-x-3 gap-y-1 md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)_3.5rem_7rem]"
          >
            <div className="min-w-0">
              <p className="truncate text-xs text-text">{windowName(item.quotaWindow)}</p>
              <p className="truncate text-2xs text-text-muted">
                {item.provider} · {item.accountTitle}
              </p>
            </div>
            <UsageMeter fraction={item.usedFraction} tone={tone} />
            <span className={`text-right text-xs tabular-nums ${TONE_TEXT[tone]}`}>
              {formatPercent(item.usedFraction)}
            </span>
            <UsageResetIn
              resetAt={item.quotaWindow.resetAt}
              className="text-right text-2xs text-text-muted"
            />
          </li>
        );
      })}
    </ul>
  );
}
