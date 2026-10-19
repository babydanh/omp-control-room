/**
 * UsageClientSection: what each client (its host name, or its install id when no host is known)
 * used over the history window. Shown only when the server reports clients.
 */

import { useId } from 'react';

import type { UsageClientBurn } from '../../../../../core/src/messages.js';
import { formatCount, formatTokens, formatUsd } from '../../usage/usageFormat.js';

/** The Vietnamese label for each client metric the server reports. */
const METRIC_LABELS: Record<string, string> = {
  requests: 'Yêu cầu',
  inputTokens: 'Token vào',
  outputTokens: 'Token ra',
  cacheReadTokens: 'Đọc bộ nhớ đệm',
  cacheWriteTokens: 'Ghi bộ nhớ đệm',
  costUsd: 'Chi phí',
};

/** Money for the cost, a count for requests, and compact tokens for the rest. */
function metricText(key: string, value: number): string {
  if (key === 'costUsd') return formatUsd(value);
  if (key === 'requests') return formatCount(value);
  return formatTokens(value);
}

export function UsageClientSection({ clients }: { clients: readonly UsageClientBurn[] }) {
  const headingId = useId();
  if (clients.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-sm font-semibold text-text">
        Mức dùng theo máy khách
      </h2>
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {clients.map((client) => (
          <article
            key={client.name}
            className="flex min-w-0 flex-col gap-2 rounded-(--company-radius-md) bg-raised p-3"
          >
            <h3 className="truncate text-sm text-text">{client.name}</h3>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-2xs">
              {client.metrics.map((metric) => (
                <div key={metric.key} className="flex min-w-0 items-baseline justify-between gap-2">
                  <dt className="truncate text-text-muted">
                    {METRIC_LABELS[metric.key] ?? metric.key}
                  </dt>
                  <dd className="shrink-0 tabular-nums text-text">
                    {metricText(metric.key, metric.value)}
                  </dd>
                </div>
              ))}
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}
