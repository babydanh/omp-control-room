/**
 * UsageClientSection: what each client (its host name, or its install id when no host is known)
 * used over the history window, as one table with a column per metric. A client that reported no
 * value for a metric shows a dash, never a zero.
 */

import type { UsageClientBurn } from '../../../../../core/src/messages.js';
import { formatCount, formatTokens, formatUsd, MISSING_TEXT } from '../../usage/usageFormat.js';

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
  const keys = [
    ...new Set(clients.flatMap((client) => client.metrics.map((metric) => metric.key))),
  ];
  return (
    <div className="max-h-[26rem] overflow-auto rounded-(--company-radius-sm)">
      <table className="w-full min-w-[28rem] border-collapse text-xs">
        <caption className="sr-only">Mức dùng theo máy khách</caption>
        <thead>
          <tr>
            <th
              scope="col"
              className="sticky top-0 z-[1] bg-raised px-3 py-2 text-left font-normal text-text-muted"
            >
              Máy khách
            </th>
            {keys.map((key) => (
              <th
                key={key}
                scope="col"
                className="sticky top-0 z-[1] bg-raised px-3 py-2 text-right font-normal text-text-muted"
              >
                {METRIC_LABELS[key] ?? key}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {clients.map((client) => (
            <tr key={client.name} className="even:bg-panel hover:bg-hover">
              <th
                scope="row"
                className="whitespace-nowrap px-3 py-2 text-left font-normal text-text"
              >
                {client.name}
              </th>
              {keys.map((key) => {
                const metric = client.metrics.find((candidate) => candidate.key === key);
                return (
                  <td key={key} className="px-3 py-2 text-right tabular-nums text-text">
                    {metric === undefined ? MISSING_TEXT : metricText(key, metric.value)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
