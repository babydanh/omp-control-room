/**
 * UsageLimitCard: one account's limit windows. The title is the account's label, the status word
 * says how its last read went, and a note stands in for a state with no windows to show.
 */

import type { QuotaSnapshot } from '../../../../../core/src/messages.js';
import { formatClock } from '../../usage/usageFormat.js';
import { snapshotStatusLabel } from '../../usage/usageLimits.js';
import { parseTime } from './usageTime.js';
import { UsageWindowBar } from './UsageWindowBar.js';

export function UsageLimitCard({ snapshot }: { snapshot: QuotaSnapshot }) {
  const title = snapshot.accountLabel ?? snapshot.accountId ?? snapshot.provider;
  const fetchedAt = parseTime(snapshot.fetchedAt);
  return (
    <article className="flex min-w-0 flex-col gap-3 rounded-(--company-radius-md) bg-raised p-3">
      <header className="flex items-baseline justify-between gap-2">
        <h4 className="min-w-0 truncate text-sm font-medium text-text">{title}</h4>
        <span className="shrink-0 text-2xs text-text-secondary">
          {snapshotStatusLabel(snapshot.status)}
        </span>
      </header>
      {snapshot.note ? <p className="text-2xs text-text-muted">{snapshot.note}</p> : null}
      {snapshot.windows.map((quotaWindow) => (
        <UsageWindowBar key={quotaWindow.id} quotaWindow={quotaWindow} />
      ))}
      {fetchedAt !== null && (
        <p className="text-2xs text-text-muted">Lấy lúc {formatClock(fetchedAt)}</p>
      )}
    </article>
  );
}
