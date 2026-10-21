import { useEffect, useMemo, useState } from 'react';

import type { LedgerToolUsageRow } from '../../../../core/src/messages.js';
import { ledgerStore } from './ledgerClient.js';
import { formatLedgerStamp } from './ledgerFormat.js';
import type { LedgerState } from './ledgerStore.js';

const CLIS = ['omp', 'claude', 'agy'] as const;
const KINDS = ['skill', 'mcp', 'tool'] as const;

export function LedgerToolUsageTab({ ledger }: { ledger: LedgerState }) {
  const usage = ledger.toolUsage;
  useEffect(() => {
    if (usage === null) {
      ledgerStore.requestToolUsage(false);
      return undefined;
    }
    if (!usage.running) return undefined;
    const timer = window.setTimeout(() => ledgerStore.requestToolUsage(false), 1000);
    return () => window.clearTimeout(timer);
  }, [usage]);
  const [cli, setCli] = useState('');
  const [kind, setKind] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const rows = useMemo(
    () =>
      (usage?.rows ?? [])
        .filter((row) => (!cli || row.cli === cli) && (!kind || row.kind === kind))
        .sort((a, b) => b.err - a.err || b.calls - a.calls || a.name.localeCompare(b.name)),
    [usage, cli, kind],
  );
  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-lg border border-border p-3">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-sm font-semibold text-text">Thống kê tool</h3>
          <button
            type="button"
            className="company-btn company-btn-sm company-btn-ghost"
            disabled={ledger.latest.toolUsage !== null}
            onClick={() => ledgerStore.requestToolUsage(true)}
          >
            Làm mới thống kê
          </button>
          {(ledger.latest.toolUsage !== null || usage?.running) && (
            <span role="status" className="text-xs text-text-muted">
              Đang làm mới…
            </span>
          )}
        </div>
        {usage?.reason && (
          <p role={usage.ok ? 'status' : 'alert'} className="mt-2 text-sm text-danger">
            {usage.reason}
          </p>
        )}
        {usage?.generatedAt && (
          <p className="mt-2 text-xs text-text-muted">
            Sinh lúc {formatLedgerStamp(usage.generatedAt)} · {usage.days} ngày
          </p>
        )}
        {usage && (
          <p className="mt-1 text-xs text-text-muted">
            Transcript: {CLIS.map((name) => `${name} ${usage.transcripts[name] ?? 0}`).join(' · ')}
          </p>
        )}
        <div className="mt-3 flex gap-2">
          <label className="text-xs text-text-muted">
            CLI{' '}
            <select
              className="ml-1 rounded border border-border bg-panel px-2 py-1"
              value={cli}
              onChange={(event) => setCli(event.target.value)}
            >
              <option value="">Tất cả</option>
              {CLIS.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-text-muted">
            Loại{' '}
            <select
              className="ml-1 rounded border border-border bg-panel px-2 py-1"
              value={kind}
              onChange={(event) => setKind(event.target.value)}
            >
              <option value="">Tất cả</option>
              {KINDS.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="text-text-muted">
                {['CLI / loại', 'Tên', 'Lượt gọi', 'Lỗi', '% lỗi', 'Phiên', 'Lần cuối'].map(
                  (label) => (
                    <th key={label} className="border-b border-border px-2 py-1">
                      {label}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <UsageRow
                  key={`${row.cli}:${row.kind}:${row.name}`}
                  row={row}
                  expanded={expanded === `${row.cli}:${row.kind}:${row.name}`}
                  onToggle={() =>
                    setExpanded(
                      expanded === `${row.cli}:${row.kind}:${row.name}`
                        ? null
                        : `${row.cli}:${row.kind}:${row.name}`,
                    )
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="rounded-lg border border-border p-3">
        <h3 className="text-sm font-semibold text-text">Skill đã cài mà không ai dùng</h3>
        <div className="mt-2 flex flex-col gap-2">
          {['omp', 'claude'].map((name) => {
            const skills = usage?.unusedSkills[name] ?? [];
            return (
              <details key={name} className="rounded bg-raised p-2">
                <summary className="cursor-pointer text-sm">
                  {name}: {skills.length}
                </summary>
                <p className="mt-2 break-words text-xs text-text-muted">
                  {skills.join(', ') || 'Không có'}
                </p>
              </details>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function UsageRow({
  row,
  expanded,
  onToggle,
}: {
  row: LedgerToolUsageRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  const resultCount = row.ok + row.err;
  return (
    <>
      <tr className="cursor-pointer hover:bg-raised" onClick={onToggle}>
        <td className="border-b border-border px-2 py-1">
          {row.cli} / {row.kind}
        </td>
        <td className="border-b border-border px-2 py-1">{row.name}</td>
        <td className="border-b border-border px-2 py-1">{row.calls}</td>
        <td className="border-b border-border px-2 py-1">{row.err}</td>
        <td className="border-b border-border px-2 py-1">
          {resultCount
            ? `${((row.err / resultCount) * 100).toFixed(1)}% (${row.err}/${resultCount})`
            : '—'}
        </td>
        <td className="border-b border-border px-2 py-1">{row.sessions}</td>
        <td className="border-b border-border px-2 py-1">{formatLedgerStamp(row.last)}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={7} className="bg-raised px-2 py-2">
            <strong>Lỗi thường gặp:</strong>{' '}
            {row.topErrors.length ? (
              <ul>
                {row.topErrors.map((item, index) => (
                  <li key={`${String(item[0])}-${index}`}>
                    {String(item[0])} ({String(item[1])})
                  </li>
                ))}
              </ul>
            ) : (
              <span> Không có lỗi ghi nhận.</span>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
