/**
 * UsageAccountCard: one account's limits. The header names the account and its provider and carries
 * a status chip; each limit is a row, and a row that reports a share opens its history beneath it.
 * The footer says when the report was taken.
 */

import { useState } from 'react';

import type {
  QuotaSnapshot,
  QuotaWindow,
  UsageHistoryEntry,
} from '../../../../../core/src/messages.js';
import { formatClock } from '../../usage/usageFormat.js';
import { buildHistorySeries } from '../../usage/usageHistory.js';
import { windowName } from '../../usage/usageLabels.js';
import { accountTitle, entryRecordsWindow, snapshotStatusLabel } from '../../usage/usageLimits.js';
import { UsageLimitRow } from './UsageLimitRow.js';
import { UsageSparkline } from './UsageSparkline.js';
import { parseTime } from './usageTime.js';

/** The history a card draws from: the entries with their span, or the reason there are none. */
export type HistoryPanel =
  { entries: readonly UsageHistoryEntry[]; sinceMs: number; endMs: number } | { note: string };

const STATUS_TONE: Record<QuotaSnapshot['status'], string> = {
  available: 'text-status-success',
  stale: 'text-caution',
  unsupported: 'text-text-muted',
  unauthenticated: 'text-text-muted',
  error: 'text-danger',
};

interface UsageAccountCardProps {
  snapshot: QuotaSnapshot;
  history: HistoryPanel;
}

export function UsageAccountCard({ snapshot, history }: UsageAccountCardProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const fetchedAt = parseTime(snapshot.fetchedAt);
  return (
    <article className="flex min-w-0 flex-col gap-3 rounded-(--company-radius-md) bg-raised p-4">
      <header className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden="true"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-(--company-radius-sm) bg-well text-xs font-semibold uppercase text-text-secondary"
        >
          {snapshot.provider.charAt(0)}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium text-text">{accountTitle(snapshot)}</h3>
          <p className="truncate text-2xs text-text-muted">{snapshot.provider}</p>
        </div>
        <span
          className={`shrink-0 rounded-full bg-well px-2 py-0.5 text-2xs ${STATUS_TONE[snapshot.status]}`}
        >
          {snapshotStatusLabel(snapshot.status)}
        </span>
      </header>
      {snapshot.note ? <p className="text-2xs text-text-muted">{snapshot.note}</p> : null}
      {snapshot.windows.length > 0 && (
        <div className="flex flex-col gap-1">
          {snapshot.windows.map((quotaWindow) => (
            <UsageLimitRow
              key={quotaWindow.id}
              quotaWindow={quotaWindow}
              expanded={openId === quotaWindow.id}
              onToggle={() => setOpenId(openId === quotaWindow.id ? null : quotaWindow.id)}
              detail={
                <HistoryDetail quotaWindow={quotaWindow} snapshot={snapshot} history={history} />
              }
            />
          ))}
        </div>
      )}
      {fetchedAt !== null && (
        <p className="text-2xs text-text-muted">Lấy lúc {formatClock(fetchedAt)}</p>
      )}
    </article>
  );
}

interface HistoryDetailProps {
  quotaWindow: QuotaWindow;
  snapshot: QuotaSnapshot;
  history: HistoryPanel;
}

/** One limit's history over the chosen window, drawn only while its row is open. */
function HistoryDetail({ quotaWindow, snapshot, history }: HistoryDetailProps) {
  if ('note' in history) return <p className="text-2xs text-text-muted">{history.note}</p>;
  const [series] = buildHistorySeries(
    history.entries.filter((entry) => entryRecordsWindow(entry, snapshot, quotaWindow.id)),
    history.sinceMs,
  );
  if (series === undefined) {
    return (
      <p className="text-2xs text-text-muted">
        Chưa có mẫu nào cho giới hạn này trong khoảng đã chọn.
      </p>
    );
  }
  return (
    <UsageSparkline
      series={series}
      label={windowName(quotaWindow)}
      sinceMs={history.sinceMs}
      endMs={history.endMs}
    />
  );
}
