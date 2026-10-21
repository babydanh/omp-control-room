import { useEffect, useMemo, useRef, useState } from 'react';

import type { LedgerView } from '../../../../core/src/messages.js';
import { ledgerStore } from './ledgerClient.js';
import { LedgerCollisionPanel } from './LedgerCollisionPanel.js';
import { parseLedgerTimestamp } from './ledgerFormat.js';
import { type ActionKind, actionPlan, type BranchRow, buildInsights, type RepoInsight, type TodoItem } from './ledgerInsights.js';
import type { BoardSessionIndex } from './ledgerMapping.js';
import { boardSessionFor } from './ledgerMapping.js';
import type { LedgerSelection } from './ledgerSelection.js';
import type { LedgerState } from './ledgerStore.js';

const STATUS_GROUPS = [
  { status: 'collide', label: 'Sẽ đụng' },
  { status: 'rebase', label: 'Cần rebase' },
  { status: 'working', label: 'Đang làm' },
  { status: 'ready', label: 'Sẵn sàng gộp' },
  { status: 'merged', label: 'Đã gộp' },
] as const;

const STATUS_DOT: Readonly<Record<BranchRow['status'], string>> = {
  collide: 'bg-status-error', rebase: 'bg-status-permission', working: 'bg-status-active', ready: 'bg-status-success', merged: 'bg-text-muted', trunk: 'bg-status-success',
};
const ACTION_ICON: Readonly<Record<ActionKind, string>> = {
  resolve: '⚔', rebase: '↻', push: '⬆', merge: '⇢', train: '⇢', clean: '🧹', notify: '⚑',
};

export interface LedgerOverviewTabProps {
  view: LedgerView;
  ledger: LedgerState;
  boardSessions: BoardSessionIndex;
  onSelect: (selection: LedgerSelection) => void;
  onCompare: (repo: string, branch: string) => void;
}

export function LedgerOverviewTab({ view, ledger, boardSessions, onSelect, onCompare }: LedgerOverviewTabProps) {
  // Measured from the snapshot's own time, so a render stays pure and ages move with each poll.
  const insights = useMemo(() => buildInsights(view, parseLedgerTimestamp(view.generatedAt) ?? 0), [view]);
  const [query, setQuery] = useState('');
  const [tool, setTool] = useState('all');
  const [filters, setFilters] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [expandedTodos, setExpandedTodos] = useState<ReadonlySet<string>>(() => new Set());
  const [collapsedMerged, setCollapsedMerged] = useState<ReadonlySet<string>>(() => new Set());
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function move(event: KeyboardEvent): void {
      if (event.key !== 'j' && event.key !== 'k' && event.key !== 'Enter') return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) return;
      const rows = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('[data-ledger-branch-row="true"]') ?? []);
      const current = rows.findIndex((row) => row === document.activeElement);
      if (event.key === 'Enter') {
        const row = rows[current];
        row?.click();
        if (row !== undefined) event.preventDefault();
        return;
      }
      if (rows.length === 0) return;
      const next = current < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, current + (event.key === 'j' ? 1 : -1)));
      rows[next]?.focus();
      event.preventDefault();
    }
    window.addEventListener('keydown', move);
    return () => window.removeEventListener('keydown', move);
  }, []);

  function toggleFilter(repo: string, kind: string): void {
    setFilters((current) => {
      const next = new Map(current);
      if (next.get(repo) === kind) next.delete(repo);
      else next.set(repo, kind);
      return next;
    });
  }

  if (insights.length === 0) return <p className="text-sm text-text-muted">Chưa có repo nào được quét.</p>;

  return (
    <div ref={rootRef} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 rounded-(--company-radius-md) bg-panel p-2">
        <label className="flex min-w-48 flex-1 items-center gap-2 text-xs text-text-muted">
          Tìm <input aria-label="Tìm nhánh hoặc file" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Nhánh, file…" className="min-w-0 flex-1 rounded bg-well px-2 py-1 text-sm text-text" />
        </label>
        <label className="flex items-center gap-2 text-xs text-text-muted">Công cụ
          <select aria-label="Lọc theo công cụ" value={tool} onChange={(event) => setTool(event.target.value)} className="rounded bg-well px-2 py-1 text-sm text-text">
            <option value="all">Tất cả</option><option value="omp">omp</option><option value="claude">claude</option><option value="agy">agy</option>
          </select>
        </label>
        <span className="text-xs text-text-muted">Dùng j/k rồi Enter để mở nhánh</span>
      </div>
      {insights.map((insight) => <RepoOverview key={insight.repo} insight={insight} view={view} ledger={ledger} boardSessions={boardSessions} onSelect={onSelect} onCompare={onCompare} query={query} tool={tool} filter={filters.get(insight.repo) ?? null} onFilter={(kind) => toggleFilter(insight.repo, kind)} expandedTodos={expandedTodos} onToggleTodo={(id) => setExpandedTodos((current) => toggleSet(current, id))} mergedCollapsed={collapsedMerged.has(insight.repo)} onToggleMerged={() => setCollapsedMerged((current) => toggleSet(current, insight.repo))} />)}
    </div>
  );
}

function RepoOverview({ insight, view, ledger, boardSessions, onSelect, onCompare, query, tool, filter, onFilter, expandedTodos, onToggleTodo, mergedCollapsed, onToggleMerged }: {
  insight: RepoInsight; view: LedgerView; ledger: LedgerState; boardSessions: BoardSessionIndex; onSelect: (selection: LedgerSelection) => void; onCompare: (repo: string, branch: string) => void; query: string; tool: string; filter: string | null; onFilter: (kind: string) => void; expandedTodos: ReadonlySet<string>; onToggleTodo: (id: string) => void; mergedCollapsed: boolean; onToggleMerged: () => void;
}) {
  const searchable = query.trim().toLocaleLowerCase();
  const rows = insight.rows.filter((row) => {
    const sessions = row.sessionIds.map((id) => view.sessions.find((session) => session.sessionId === id)).filter((session) => session !== undefined);
    const matchesTool = tool === 'all' || sessions.some((session) => session.agentKind.toLowerCase() === tool);
    const matchesQuery = searchable === '' || `${row.name} ${row.branch ?? ''} ${row.path}`.toLocaleLowerCase().includes(searchable) || insight.matrix.rows.some((item) => item.file.toLocaleLowerCase().includes(searchable) && item.cells[row.path] !== undefined);
    const matchesFilter = filter === null || (filter === 'collide' ? row.collideFiles > 0 : filter === 'rebase' ? row.behind > 0 : filter === 'unpushed' ? row.unpushed > 0 : filter === 'dirty' ? row.dirty > 0 : row.cleanable);
    return matchesTool && matchesQuery && matchesFilter;
  });
  const todos = insight.todos.filter((todo) => searchable === '' || `${todo.title} ${todo.detail} ${todo.branches.join(' ')} ${todo.files.join(' ')}`.toLocaleLowerCase().includes(searchable));
  const sc = insight.chips;
  return <section aria-label={`Tổng quan ${insight.name}`} className="flex flex-col gap-3 rounded-(--company-radius-md) bg-panel p-3">
    <header className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-base font-semibold text-text">{insight.name}</h2>
      <div className="flex flex-wrap gap-1.5">
        <Chip label={`⚔ ${sc.collide}`} active={filter === 'collide'} onClick={() => onFilter('collide')} />
        <Chip label={`↻ ${sc.rebase}`} active={filter === 'rebase'} onClick={() => onFilter('rebase')} />
        <Chip label={`⬆ ${sc.unpushed}`} active={filter === 'unpushed'} onClick={() => onFilter('unpushed')} />
        <Chip label={`✎ ${sc.dirty}`} active={filter === 'dirty'} onClick={() => onFilter('dirty')} />
        <Chip label={`🧹 ${sc.cleanable}`} active={filter === 'cleanable'} onClick={() => onFilter('cleanable')} />
      </div>
    </header>
    {!insight.scanComplete && <p role="status" className="rounded bg-raised px-2 py-1 text-sm text-warning">Chưa quét xong: chưa biết có đụng không.</p>}
    {todos.length > 0 && <section aria-label="Việc nên làm" className="flex flex-col gap-1.5"><h3 className="text-sm font-semibold text-text">Việc nên làm</h3>{todos.map((todo) => <TodoRow key={todo.id} todo={todo} insight={insight} ledger={ledger} view={view} expanded={expandedTodos.has(todo.id)} onToggle={() => onToggleTodo(todo.id)} />)}</section>}
    <section aria-label="Nhánh" className="flex flex-col gap-1"><h3 className="text-sm font-semibold text-text">Nhánh</h3>
      {STATUS_GROUPS.map((group) => {
        const grouped = rows.filter((row) => row.status === group.status);
        if (grouped.length === 0) return null;
        const folded = group.status === 'merged' && mergedCollapsed;
        return <div key={group.status}><button type="button" onClick={group.status === 'merged' ? onToggleMerged : undefined} className="py-1 text-xs font-medium text-text-muted">{group.label} · {grouped.length}{group.status === 'merged' ? ` ${folded ? '›' : '⌄'}` : ''}</button>{!folded && grouped.map((row) => <BranchLine key={row.path} row={row} view={view} boardSessions={boardSessions} onSelect={onSelect} onCompare={onCompare} />)}</div>;
      })}
      {rows.length === 0 && <p className="text-sm text-text-muted">Không có nhánh khớp bộ lọc.</p>}
    </section>
    {insight.mergeOrder.length > 0 && <section aria-label="Gợi ý thứ tự gộp"><h3 className="mb-1 text-sm font-semibold text-text">Gợi ý thứ tự gộp</h3><ol className="list-inside list-decimal text-sm text-text-secondary">{insight.mergeOrder.map((step) => <li key={step.path}><span className="font-medium text-text">{step.label}</span> — {step.reason}</li>)}</ol></section>}
    {insight.liveEdits.length > 0 && <section aria-label="Đang sửa cùng file"><h3 className="mb-1 text-sm font-semibold text-text">Đang sửa cùng file</h3><ul className="flex flex-col gap-1 text-sm text-text-secondary">{insight.liveEdits.map((item) => <li key={item.file}><span className="font-mono text-text">{item.file}</span> · {item.checkouts.map((checkout) => checkout.label).join(' · ')}</li>)}</ul></section>}
    {insight.mergeBlocks.length > 0 && <section aria-label="Merge-lane bị chặn" className="rounded border border-hairline bg-raised p-2"><h3 className="text-sm font-semibold text-status-error">Merge-lane bị chặn</h3>{insight.mergeBlocks.map((block) => <p key={`${block.branch}-${block.at}`} className="text-sm text-text-secondary">{block.branch} · {block.files.join(', ')} <span className="text-xs text-text-muted">{block.briefPath}</span></p>)}</section>}
    <LedgerCollisionPanel insight={insight} view={view} ledger={ledger} />
  </section>;
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return <button type="button" aria-pressed={active} onClick={onClick} className={`rounded-full px-2 py-1 text-xs ${active ? 'bg-selected text-text' : 'bg-well text-text-secondary hover:bg-hover'}`}>{label}</button>;
}

function TodoRow({ todo, insight, ledger, view, expanded, onToggle }: { todo: TodoItem; insight: RepoInsight; ledger: LedgerState; view: LedgerView; expanded: boolean; onToggle: () => void }) {
  const [requestIds, setRequestIds] = useState<readonly string[]>([]);
  const [copied, setCopied] = useState<number | null>(null);
  const plan = actionPlan(todo, insight);
  const liveIds = (branch: string): string[] =>
    // A todo names its branches as the rows label them: the branch, or the checkout's name when detached.
    (insight.rows.find((row) => (row.branch ?? row.name) === branch)?.sessionIds ?? [])
      .filter((id) => view.sessions.some((session) => session.sessionId === id && session.live));
  // Rebase, push and clean are per branch: each branch's own agent gets its own line.
  const perBranch = todo.kind === 'rebase' || todo.kind === 'push' || todo.kind === 'clean';
  const targetIds = [...new Set(todo.branches.flatMap(liveIds))];
  const sendRecords = ledger.sends.filter((send) => requestIds.includes(send.requestId));
  const active = targetIds.length > 0;
  async function act(): Promise<void> {
    if (!active) {
      await navigator.clipboard.writeText(plan.command);
      setCopied(todo.branches.length);
      return;
    }
    if (!perBranch) {
      setRequestIds(targetIds.map((id) => ledgerStore.sendMessage(id, plan.message)));
      return;
    }
    const sent: string[] = [];
    const unattended: string[] = [];
    for (const branch of todo.branches) {
      const ids = liveIds(branch);
      const own = actionPlan({ ...todo, branches: [branch] }, insight);
      if (ids.length === 0) unattended.push(own.command);
      for (const id of ids) sent.push(ledgerStore.sendMessage(id, own.message));
    }
    setRequestIds(sent);
    if (unattended.length > 0) {
      await navigator.clipboard.writeText(unattended.join('\n'));
      setCopied(unattended.length);
    }
  }
  const sendStatus = sendRecords.some((item) => item.status === 'sending') ? 'Đang gửi…' : sendRecords.some((item) => item.status === 'refused') ? 'Bị từ chối' : sendRecords.some((item) => item.status === 'delivered') ? 'Đã giao' : null;
  const copyStatus = copied === null ? null : `Đã chép lệnh cho ${copied} nhánh không có agent`;
  const status = [sendStatus, copyStatus].filter((part) => part !== null).join(' · ') || null;
  return <article className="grid grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-2 rounded bg-well px-2 py-1.5">
    <span aria-hidden="true" className="text-base">{ACTION_ICON[todo.kind]}</span><div className="min-w-0"><p className="truncate text-sm font-medium text-text">{todo.title}</p><p className="truncate text-xs text-text-secondary">{todo.detail}</p>{status !== null && <p role="status" className="text-xs text-text-muted">{status}</p>}{expanded && <p className="break-words text-xs text-text-muted">{todo.branches.join(', ')}{todo.files.length > 0 ? ` · ${todo.files.join(', ')}` : ''}</p>}</div>
    <div className="flex items-center gap-1"><button type="button" onClick={onToggle} className="company-btn company-btn-sm company-btn-ghost">Chi tiết</button><button type="button" onClick={() => void act()} className="company-btn company-btn-sm company-btn-primary">{active ? 'Giao agent' : 'Chép lệnh'}</button></div>
  </article>;
}

function BranchLine({ row, view, boardSessions, onSelect, onCompare }: { row: BranchRow; view: LedgerView; boardSessions: BoardSessionIndex; onSelect: (selection: LedgerSelection) => void; onCompare: (repo: string, branch: string) => void }) {
  const sessions = row.sessionIds.map((id) => view.sessions.find((item) => item.sessionId === id && item.live)).filter((item) => item !== undefined);
  const max = Math.max(1, row.behind, row.ahead);
  const behindWidth = `${Math.min(50, row.behind / max * 50)}%`;
  const aheadWidth = `${Math.min(50, row.ahead / max * 50)}%`;
  return <div className="flex items-center gap-1">
    <button type="button" data-ledger-branch-row="true" onClick={() => onSelect({ kind: 'branch', repo: row.repo, path: row.path })} className="grid min-w-0 flex-1 grid-cols-[8px_minmax(100px,1fr)_minmax(100px,180px)_auto_minmax(80px,1fr)] items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent">
      <span className={`h-2 w-2 rounded-full ${STATUS_DOT[row.status]}`} /><span className="truncate text-sm font-medium text-text" title={row.name}>{row.name}</span>
      <span className="flex items-center gap-1 text-xs text-text-muted"><span>{row.behind}</span><span className="relative h-2 flex-1 overflow-hidden rounded bg-well"><span className="absolute inset-y-0 right-1/2 bg-status-error" style={{ width: behindWidth }} /><span className="absolute inset-y-0 left-1/2 bg-status-active" style={{ width: aheadWidth }} /><span className="absolute inset-y-0 left-1/2 w-px bg-text-muted" /></span><span>{row.ahead}</span></span>
      <span className="flex gap-2 whitespace-nowrap text-xs">{row.collideFiles > 0 && <span className="text-status-error" title={`${row.collideFiles} file sẽ đụng`}>⚔ {row.collideFiles}</span>}{row.unpushed > 0 && <span className="text-warning" title={`${row.unpushed} commit chưa đẩy`}>⬆ {row.unpushed}</span>}{row.dirty > 0 && <span className="text-text-secondary" title={`${row.dirty} file sửa chưa commit`}>✎ {row.dirty}</span>}</span>
      <span className="flex justify-end gap-1 overflow-hidden">{sessions.map((session) => { const key = boardSessionFor(session.sessionId, boardSessions); return <span key={session.sessionId} className="truncate rounded-full bg-raised px-2 py-0.5 text-xs text-text-secondary" title={`${session.agentName}${key === null ? '' : ` · ${boardSessions[key]?.label ?? ''}`}`}>{session.agentName || session.agentKind}</span>; })}</span>
    </button>
    <button type="button" aria-label={`So sánh nhánh ${row.name}`} title="So sánh nhánh" onClick={() => onCompare(row.repo, row.branch ?? row.name)} className="shrink-0 rounded px-2 py-1 text-sm text-text-secondary hover:bg-hover">⇄</button>
  </div>;
}

function toggleSet(current: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}
