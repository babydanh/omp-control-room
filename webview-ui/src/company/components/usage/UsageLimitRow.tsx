/**
 * UsageLimitRow: one limit window as a row. Its name and scope come first, then the time left until
 * it resets, then the share used as a bar with its counts. A window that reports a share opens its
 * history when the row is pressed; a balance-only window shows its counts and no bar.
 */

import type { ReactNode } from 'react';

import type { QuotaWindow } from '../../../../../core/src/messages.js';
import { formatPercent } from '../../usage/usageFormat.js';
import { windowSpanName } from '../../usage/usageLabels.js';
import {
  usageBarTone,
  windowCountsText,
  windowScopeLabel,
  windowShare,
} from '../../usage/usageLimits.js';
import { Icon } from '../Icon.js';
import { UsageMeter } from './UsageMeter.js';
import { UsageResetIn } from './UsageResetIn.js';
import { TONE_TEXT } from './usageToneStyle.js';

const ROW_CLASS =
  'flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-(--company-radius-sm) px-2 py-1.5 text-left';

interface UsageLimitRowProps {
  quotaWindow: QuotaWindow;
  expanded: boolean;
  onToggle: () => void;
  /** The history under the row, shown only while the row is open. */
  detail: ReactNode;
}

export function UsageLimitRow({ quotaWindow, expanded, onToggle, detail }: UsageLimitRowProps) {
  const share = windowShare(quotaWindow);
  const bar =
    share === null
      ? null
      : { fraction: share, tone: usageBarTone(share, quotaWindow.status === 'exhausted') };
  const counts = windowCountsText(quotaWindow);
  const body = (
    <>
      <span className="flex min-w-0 flex-1 basis-40 items-center gap-1.5">
        <span className="truncate text-xs text-text">{windowSpanName(quotaWindow)}</span>
        <span className="shrink-0 rounded-full bg-well px-1.5 text-2xs text-text-muted">
          {windowScopeLabel(quotaWindow)}
        </span>
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5 text-2xs text-text-muted">
        <UsageResetIn resetAt={quotaWindow.resetAt} />
        {bar !== null && <Icon name={expanded ? 'chevron-up' : 'chevron-down'} />}
      </span>
      <span className="flex w-full items-center gap-2">
        {bar === null ? (
          <span className="text-2xs tabular-nums text-text-muted">
            {counts || 'Chưa có số liệu'}
          </span>
        ) : (
          <>
            <span className="shrink-0 text-2xs tabular-nums text-text-muted">{counts}</span>
            <span className="min-w-0 flex-1">
              <UsageMeter fraction={bar.fraction} tone={bar.tone} />
            </span>
            <span
              className={`w-12 shrink-0 text-right text-2xs tabular-nums ${TONE_TEXT[bar.tone]}`}
            >
              {formatPercent(bar.fraction)}
            </span>
          </>
        )}
      </span>
    </>
  );

  if (bar === null) return <div className={ROW_CLASS}>{body}</div>;
  return (
    <div className="flex min-w-0 flex-col">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className={`${ROW_CLASS} hover:bg-hover`}
      >
        {body}
      </button>
      {expanded && <div className="px-2 pb-2">{detail}</div>}
    </div>
  );
}
