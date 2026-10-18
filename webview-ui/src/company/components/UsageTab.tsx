/**
 * UsageTab: what a session cost, what the company has spent, and the provider
 * quota windows. Provider quota is per account, not per session, so it is
 * labelled as such.
 */

import type { CompanyClient } from '../companyClient.js';
import { quotaStatusLabel } from '../statusLabels.js';
import {
  cacheHitRate,
  quotaRows,
  summarizeUsage,
  usageByModel,
  usageForSession,
} from '../usageView.js';
import { useCompanyState } from '../useCompanyState.js';

export function UsageTab({ client, sessionId }: { client: CompanyClient; sessionId: string }) {
  const state = useCompanyState(client);
  const records = Object.values(state.usage);
  const sessionRecords = records.filter((record) => record.sessionId === sessionId);
  const totals = usageForSession(records, sessionId);
  const hit = cacheHitRate(sessionRecords);
  const company = summarizeUsage(records);

  return (
    <div className="flex flex-col gap-3 p-2 text-2xs">
      <section aria-label="Phiên này">
        <h4 className="mb-1 text-xs font-semibold text-text-muted">Phiên này</h4>
        <p className="text-text">
          vào {totals.input} · ra {totals.output} · đọc bộ nhớ đệm {totals.cacheRead} · ghi bộ nhớ
          đệm {totals.cacheWrite}
        </p>
        <p className="text-text-muted">
          chi phí {totals.costUsd === null ? 'không có' : `$${totals.costUsd.toFixed(4)}`} &middot;{' '}
          trúng bộ nhớ đệm{' '}
          {hit.rate === null
            ? 'không có (không có dữ liệu nào để chia)'
            : `${Math.round(hit.rate * 100)}% trong ${hit.denominator} token`}
        </p>
        {usageByModel(sessionRecords).map((row) => (
          <p key={`${row.provider}/${row.model}`} className="text-text-muted">
            {row.provider}/{row.model}: {row.totals.input} vào / {row.totals.output} ra
            {row.totals.costUsd === null
              ? ' · chi phí không có'
              : ` · $${row.totals.costUsd.toFixed(4)}`}
          </p>
        ))}
      </section>

      <section aria-label="Tổng công ty">
        <h4 className="mb-1 text-xs font-semibold text-text-muted">
          Công ty tính đến giờ ({records.length} bản ghi đã nhận)
        </h4>
        <p className="text-text">
          vào {company.input} · ra {company.output} · đọc bộ nhớ đệm {company.cacheRead}
        </p>
      </section>

      <section aria-label="Hạn mức nhà cung cấp">
        <h4 className="mb-1 text-xs font-semibold text-text-muted">
          Hạn mức nhà cung cấp (theo tài khoản, không phải theo phiên)
        </h4>
        {quotaRows(Object.values(state.quotas)).map((row) => (
          <p key={row.provider} className="text-text-muted">
            {row.provider} / {row.accountLabel} · {quotaStatusLabel(row.status)}
            {row.windows.map(
              (window) =>
                ` — ${window.label}: ${window.remaining ?? '?'} ${window.reportedUnit} còn lại`,
            )}
          </p>
        ))}
      </section>
    </div>
  );
}
