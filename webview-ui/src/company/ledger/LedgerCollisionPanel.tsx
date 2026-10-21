import { useState } from 'react';

import type { LedgerView } from '../../../../core/src/messages.js';
import { ledgerStore } from './ledgerClient.js';
import { LedgerFileHistory } from './LedgerFileHistory.js';
import { actionPlan, type CollisionHunk, type RepoInsight } from './ledgerInsights.js';
import type { LedgerState } from './ledgerStore.js';

export function LedgerCollisionPanel({ insight, view, ledger }: { insight: RepoInsight; view: LedgerView; ledger: LedgerState }) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  if (insight.matrix.rows.length === 0) return null;
  const selected = insight.matrix.rows.find((row) => row.file === selectedFile) ?? null;
  return <section aria-label="Ma trận chạm nhau" className="flex flex-col gap-2 border-t border-hairline pt-3">
    <header className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="text-sm font-semibold text-text">Chạm nhau</h3><p className="text-xs text-text-muted">⚔ đụng thật · ≈ tự gộp được</p></header>
    <div className="overflow-x-auto"><table className="border-separate border-spacing-1 text-left"><thead><tr><th className="sticky left-0 bg-panel pr-2 text-xs text-text-muted">File</th>{insight.matrix.columns.map((column) => <th key={column.path} className="h-28 min-w-8 align-bottom text-xs font-medium text-text-muted"><span className="[writing-mode:vertical-rl] rotate-180">{column.label}</span></th>)}</tr></thead><tbody>{insight.matrix.rows.map((row) => <tr key={row.file}>
      <th scope="row" className="sticky left-0 bg-panel pr-2 text-left"><button type="button" onClick={() => setSelectedFile(row.file)} aria-pressed={selectedFile === row.file} className="max-w-64 truncate font-mono text-xs text-text hover:text-accent">{row.file}</button></th>
      {insight.matrix.columns.map((column) => { const touch = row.cells[column.path]; return <td key={column.path} className={`h-7 min-w-8 rounded text-center text-sm ${touch === 'conflict' ? 'bg-status-error text-text' : touch === 'auto' ? 'bg-raised text-warning' : 'bg-well text-text-muted'}`}>{touch === 'conflict' ? '⚔' : touch === 'auto' ? '≈' : ''}</td>; })}
    </tr>)}</tbody></table></div>
    {selected !== null && <SelectedFile insight={insight} view={view} ledger={ledger} file={selected.file} hunks={selected.hunks} />}
  </section>;
}

function SelectedFile({ insight, view, ledger, file, hunks }: { insight: RepoInsight; view: LedgerView; ledger: LedgerState; file: string; hunks: readonly CollisionHunk[] }) {
  const [requestIds, setRequestIds] = useState<readonly string[]>([]);
  const related = insight.todos.find((todo) => (todo.kind === 'resolve' || todo.kind === 'notify') && (todo.files.includes(file) || todo.files.includes(file.replace(/\\/g, '/'))));
  // A hunk names its two sides by checkout path.
  const conflictPaths = [...new Set(hunks.flatMap((hunk) => [hunk.a, hunk.b]))].map(pathKey);
  const sessions = [...new Set(insight.rows.filter((item) => conflictPaths.includes(pathKey(item.path))).flatMap((item) => item.sessionIds))].filter((id) => view.sessions.some((session) => session.sessionId === id && session.live));
  const repoRoot = insight.repo.replace(/[\\/]+$/, '');
  const path = `${repoRoot}\\${file.replace(/[\\/]/g, '\\')}`;
  async function assign(): Promise<void> {
    if (related === undefined) return;
    const plan = actionPlan(related, insight);
    if (sessions.length === 0) {
      await navigator.clipboard.writeText(plan.command);
      return;
    }
    setRequestIds(sessions.map((sessionId) => ledgerStore.sendMessage(sessionId, plan.message)));
  }
  return <article className="flex flex-col gap-2 rounded bg-well p-2">
    <h4 className="break-all font-mono text-sm font-medium text-text">{file}</h4>
    {hunks.length > 0 ? <div className="flex flex-col gap-2">{hunks.map((hunk, index) => <Hunk key={`${hunk.a}-${hunk.b}-${hunk.line}-${index}`} hunk={hunk} />)}</div> : <p className="text-sm text-text-secondary">Các nhánh sửa file ở những vị trí khác nhau; Git có thể tự gộp.</p>}
    <h4 className="text-sm font-semibold text-text">Gợi ý xử lý</h4>
    <ol className="list-inside list-decimal text-sm text-text-secondary"><li>{insight.mergeOrder.find((step) => conflictPaths.includes(pathKey(step.path)))?.reason ?? insight.mergeOrder[0]?.reason ?? 'Rebase nhánh theo thứ tự gộp gợi ý ở trên.'}</li><li>Giữ ý định của cả hai bên khi xử lý xung đột (AGENTS §6).</li><li>Chạy test liên quan rồi gộp qua merge-lane.</li></ol>
    {related !== undefined && <div className="flex flex-wrap items-center gap-2"><button type="button" onClick={() => void assign()} className="company-btn company-btn-sm company-btn-primary">{sessions.length > 0 ? 'Giao agent xử lý' : 'Chép lệnh xử lý'}</button>{sessions.length > 0 && <SendStatus ledger={ledger} requestIds={requestIds} />}</div>}
    <LedgerFileHistory ledger={ledger} absolutePath={path} />
  </article>;
}

function Hunk({ hunk }: { hunk: CollisionHunk }) {
  return <div className="rounded border border-hairline p-2"><p className="mb-1 text-xs text-text-muted">Dòng {hunk.line}{hunk.symbol === null ? '' : ` · ${hunk.symbol}`}</p><div className="grid gap-2 sm:grid-cols-2"><HunkSide label={`ours · ${hunk.aLabel}`} value={hunk.ours} /><HunkSide label={`theirs · ${hunk.bLabel}`} value={hunk.theirs} /></div></div>;
}

function HunkSide({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><h5 className="mb-1 truncate text-xs font-medium text-text-muted">{label}</h5><pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-raised p-2 font-mono text-xs text-text">{value.split('\n').map((line, index) => <span key={index} className={`block ${line.startsWith('+') ? 'text-status-success' : line.startsWith('-') ? 'text-status-error' : 'text-text'}`}>{line || ' '}</span>)}</pre></div>;
}

function SendStatus({ ledger, requestIds }: { ledger: LedgerState; requestIds: readonly string[] }) {
  const records = ledger.sends.filter((item) => requestIds.includes(item.requestId));
  if (records.length === 0) return null;
  const message = records.some((item) => item.status === 'sending') ? 'Đang gửi…' : records.some((item) => item.status === 'refused') ? records.find((item) => item.status === 'refused')?.reason ?? 'Bị từ chối' : 'Đã giao';
  return <span role="status" className="text-xs text-text-muted">{message}</span>;
}

/** A checkout path compared separator- and case-blind. */
function pathKey(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
