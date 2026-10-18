/**
 * UsageTab: what a session cost and what the company has spent so far. Provider
 * quota is per account and reads in the top bar's status pill, not here.
 */

import type { CompanyClient } from '../companyClient.js';
import { cacheHitRate, summarizeUsage, usageByModel, usageForSession } from '../usageView.js';
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
    </div>
  );
}
