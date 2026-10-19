/**
 * UsageWindowBar: one limit window as a meter, its share in figures and words, and when it
 * resets. The colour follows the tone and the words repeat it, so the state never rests on colour
 * alone.
 */

import { useEffect, useState } from 'react';

import type { QuotaWindow } from '../../../../../core/src/messages.js';
import {
  formatCount,
  formatCountdown,
  formatPercent,
  MISSING_TEXT,
} from '../../usage/usageFormat.js';
import { windowScopeLabel, type WindowTone, windowTone } from '../../usage/usageLimits.js';
import { parseTime } from './usageTime.js';

const METER_FILL: Record<WindowTone, string> = {
  ok: 'bg-status-success',
  warn: 'bg-caution',
  danger: 'bg-danger',
  unknown: 'bg-idle',
};

const TONE_TEXT: Record<WindowTone, string> = {
  ok: 'text-status-success',
  warn: 'text-caution',
  danger: 'text-danger',
  unknown: 'text-idle',
};

/** The tone in words, for readers who cannot tell the colours apart. */
const TONE_WORD: Record<WindowTone, string> = {
  ok: '',
  warn: 'gần giới hạn',
  danger: 'đã chạm giới hạn',
  unknown: 'chưa rõ mức dùng',
};

/** The window's counts in its own unit, as far as the server reports them. */
function countsText(quotaWindow: QuotaWindow): string {
  const unit = quotaWindow.reportedUnit;
  if (quotaWindow.used !== undefined && quotaWindow.limit !== undefined) {
    return `${formatCount(quotaWindow.used)} / ${formatCount(quotaWindow.limit)} ${unit}`;
  }
  if (quotaWindow.used !== undefined) return `đã dùng ${formatCount(quotaWindow.used)} ${unit}`;
  if (quotaWindow.remaining !== undefined) {
    return `còn ${formatCount(quotaWindow.remaining)} ${unit}`;
  }
  return '';
}

export function UsageWindowBar({ quotaWindow }: { quotaWindow: QuotaWindow }) {
  const tone = windowTone(quotaWindow);
  const fraction = quotaWindow.usedFraction;
  const known = fraction !== undefined && Number.isFinite(fraction);
  const meter = fraction !== undefined && known ? Math.min(Math.max(fraction, 0), 1) : null;
  const share = fraction !== undefined && known ? formatPercent(fraction) : MISSING_TEXT;
  const resetAt = parseTime(quotaWindow.resetAt);
  const title = quotaWindow.windowLabel
    ? `${quotaWindow.label} · ${quotaWindow.windowLabel}`
    : quotaWindow.label;
  const word = TONE_WORD[tone];
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-2xs">
        <span className="min-w-0 truncate text-text">{title}</span>
        <span className="shrink-0 text-text-muted">{windowScopeLabel(quotaWindow)}</span>
      </div>
      {meter !== null && (
        <div
          role="progressbar"
          aria-label={title}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(meter * 100)}
          className="h-1.5 w-full overflow-hidden rounded-full bg-well"
        >
          <div
            className={`h-full rounded-full ${METER_FILL[tone]}`}
            style={{ width: `${meter * 100}%` }}
          />
        </div>
      )}
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-2xs">
        <span className="text-text-secondary">{countsText(quotaWindow)}</span>
        <span className={`tabular-nums ${TONE_TEXT[tone]}`}>
          {share}
          {word === '' ? '' : ` · ${word}`}
        </span>
      </div>
      {resetAt !== null && <ResetCountdown resetAtMs={resetAt} />}
    </div>
  );
}

/** Time left until a window resets, redrawn each second from the page clock; nothing is fetched. */
function ResetCountdown({ resetAtMs }: { resetAtMs: number }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span className="text-2xs tabular-nums text-text-muted">
      {formatCountdown(resetAtMs, nowMs)}
    </span>
  );
}
