import { useEffect, useMemo, useState } from 'react';

import type { LedgerTokenUsage, LedgerTokenUsageRow } from '../../../../core/src/messages.js';
import { libraryStore } from '../library/libraryClient.js';
import { useLibraryState } from '../library/libraryStore.js';
import { ledgerStore } from './ledgerClient.js';

const KIND_LABELS: Record<LedgerTokenUsageRow['kind'], string> = {
  main: 'Phiên chính',
  subagent: 'Subagent',
  skill: 'Skill',
  plugin: 'Plugin',
};
const KINDS = Object.keys(KIND_LABELS) as LedgerTokenUsageRow['kind'][];
const ROW_LIMIT = 40;

function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/** Estimated Claude token usage per main session, subagent, skill and plugin (from local transcripts). */
export function LedgerTokenUsageSection({ usage }: { usage: LedgerTokenUsage | undefined }) {
  const [kind, setKind] = useState('');
  const rows = useMemo(
    () => (usage?.rows ?? []).filter((row) => !kind || row.kind === kind).slice(0, ROW_LIMIT),
    [usage, kind],
  );
  return (
    <section className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-semibold text-text">Usage token Claude (ước lượng)</h3>
        <label className="text-xs text-text-muted">
          Loại{' '}
          <select
            className="ml-1 rounded border border-border bg-panel px-2 py-1"
            value={kind}
            onChange={(event) => setKind(event.target.value)}
          >
            <option value="">Tất cả</option>
            {KINDS.map((name) => (
              <option key={name} value={name}>
                {KIND_LABELS[name]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="mt-1 text-xs text-text-muted">
        Quy đổi theo token input của Sonnet (ghi cache ×1,25, đọc cache ×0,1, output ×5; Opus ×5/3, Haiku ×1/3). Không phải
        cách Anthropic tính hạn mức. Skill/plugin tính phần nội dung skill nằm trong ngữ cảnh và chồng lên phiên chính/subagent,
        nên cộng các dòng sẽ vượt 100%.
      </p>
      {rows.length === 0 ? (
        <p className="mt-2 text-xs text-text-muted">Chưa có dữ liệu. Bấm "Làm mới thống kê".</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="text-text-muted">
                {['Loại', 'Tên', '% usage', 'Input', 'Ghi cache', 'Đọc cache', 'Output', 'Message', 'Model'].map((label) => (
                  <th key={label} className="border-b border-border px-2 py-1">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.kind}:${row.name}`}>
                  <td className="border-b border-border px-2 py-1">{KIND_LABELS[row.kind]}</td>
                  <td className="border-b border-border px-2 py-1">{row.name}</td>
                  <td className="border-b border-border px-2 py-1">{(row.share * 100).toFixed(1)}%</td>
                  <td className="border-b border-border px-2 py-1">{tokens(row.input)}</td>
                  <td className="border-b border-border px-2 py-1">{tokens(row.cacheWrite)}</td>
                  <td className="border-b border-border px-2 py-1">{tokens(row.cacheRead)}</td>
                  <td className="border-b border-border px-2 py-1">{tokens(row.output)}</td>
                  <td className="border-b border-border px-2 py-1">{row.messages}</td>
                  <td className="border-b border-border px-2 py-1">{row.models.slice(0, 2).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * Claude skills unused in the window and still loaded in full: one click narrows them to
 * `name-only` (Claude keeps only the name in context until the skill is called).
 */
export function LedgerNameOnlySection({ candidates, days }: { candidates: readonly string[]; days: number | null }) {
  const library = useLibraryState(libraryStore);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [done, setDone] = useState('');
  const saving = requestId !== null && library.pending[requestId] !== undefined;
  const result = requestId === null ? undefined : library.commandResults[requestId];
  const failure = requestId === null ? undefined : library.errors['command:setSkillMode'];

  useEffect(() => {
    if (requestId === null || !result?.ok) return;
    setDone(result.target || 'không có skill nào cần đổi');
    setRequestId(null);
    // The statistics still list the old candidates until the script runs again.
    ledgerStore.requestToolUsage(true);
  }, [requestId, result]);

  function apply(names: readonly string[]): void {
    setDone('');
    setRequestId(libraryStore.setSkillMode(names));
  }

  return (
    <section className="rounded-lg border border-border p-3">
      <h3 className="text-sm font-semibold text-text">
        Đề xuất chuyển name-only (Claude): {candidates.length}
      </h3>
      <p className="mt-1 text-xs text-text-muted">
        Skill trong ~/.claude/skills không được gọi trong {days ?? '?'} ngày mà vẫn nạp đầy đủ. Chuyển name-only: Claude chỉ giữ
        tên trong ngữ cảnh, vẫn gọi được khi cần. Ghi vào skillOverrides của ~/.claude/settings.json.
      </p>
      {candidates.length === 0 ? (
        <p className="mt-2 text-xs text-text-muted">Không có.</p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {candidates.map((name) => (
            <button
              key={name}
              type="button"
              className="company-btn company-btn-sm company-btn-ghost"
              disabled={saving}
              title={`Chuyển ${name} sang name-only`}
              onClick={() => apply([name])}
            >
              {name}
            </button>
          ))}
          <button
            type="button"
            className="company-btn company-btn-sm"
            disabled={saving}
            onClick={() => {
              if (window.confirm(`Chuyển ${candidates.length} skill sang name-only?`)) apply(candidates);
            }}
          >
            Chuyển tất cả
          </button>
        </div>
      )}
      {saving && (
        <p role="status" className="mt-2 text-xs text-text-muted">
          Đang ghi settings.json…
        </p>
      )}
      {done && (
        <p role="status" className="mt-2 text-xs text-status-success">
          Đã chuyển name-only: {done}
        </p>
      )}
      {failure && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {failure}
        </p>
      )}
    </section>
  );
}
