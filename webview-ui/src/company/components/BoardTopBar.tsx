/**
 * BoardTopBar: where the board is pointed and how healthy the company is.
 *
 * Every number is read from a server message; a value the server has not sent
 * yet reads as unknown, never as zero.
 */

import type { CompanyModelCatalogEntry } from '../../../../core/src/company.js';
import type { CompanyViewState } from '../companyState.js';
import { quotaRows } from '../usageView.js';

export type BoardPane = 'sessions' | 'files';

export interface BoardTopBarProps {
  state: CompanyViewState;
  pane: BoardPane | null;
  onTogglePane: (pane: BoardPane) => void;
}

const PANE_LABELS: Record<BoardPane, string> = { sessions: 'Phiên', files: 'Tệp' };

function CatalogStatus({ entries }: { entries: readonly CompanyModelCatalogEntry[] }) {
  if (entries.length === 0) return <span>danh mục mô hình: chưa tải</span>;
  const usable = entries.filter((entry) => entry.credentialsConfigured).length;
  return (
    <span>
      mô hình: {usable}/{entries.length} dùng được
    </span>
  );
}

function QuotaStatus({ state }: { state: CompanyViewState }) {
  const windows = quotaRows(Object.values(state.quotas)).flatMap((row) =>
    row.windows.map(
      (window) =>
        `${row.provider} ${window.label}: ${window.remaining ?? '?'} ${window.reportedUnit}`,
    ),
  );
  if (windows.length === 0) return null;
  return <span title="Còn lại theo tài khoản nhà cung cấp">{windows.join(' · ')}</span>;
}

export function BoardTopBar({ state, pane, onTogglePane }: BoardTopBarProps) {
  const diagnostics = state.diagnostics;
  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b-2 border-border px-3 py-2">
      <h1 className="text-base text-text">OMP Board</h1>
      <span className="text-2xs text-text" data-testid="board-workspace">
        {state.settings?.workspacePath ?? 'đang chờ máy chủ…'}
      </span>
      <span className="flex flex-wrap gap-3 text-2xs text-text-muted">
        <span>bản sửa {state.revision ?? '-'}</span>
        <CatalogStatus entries={state.modelCatalog} />
        {diagnostics && (
          <span>
            omp đang chạy {diagnostics.liveRunners}/{diagnostics.modelLeases} · xếp hàng{' '}
            {diagnostics.queuedTasks} · giữ lại {diagnostics.retainedSessions}
          </span>
        )}
        <QuotaStatus state={state} />
      </span>
      <nav className="ml-auto flex gap-1" aria-label="Ngăn bên phải">
        {(['sessions', 'files'] as const).map((entry) => (
          <button
            key={entry}
            type="button"
            onClick={() => onTogglePane(entry)}
            aria-pressed={pane === entry}
            className={
              pane === entry
                ? 'cursor-pointer border-2 border-accent px-2 text-2xs text-text'
                : 'cursor-pointer border-2 border-border px-2 text-2xs text-text-muted hover:border-accent'
            }
          >
            {PANE_LABELS[entry]}
          </button>
        ))}
      </nav>
    </header>
  );
}
