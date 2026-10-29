import type { LedgerOpenSpecChange, LedgerOpenSpecFileName } from '../../../../core/src/messages.js';
import type { LedgerOpenSpecFileView } from '../ledger/ledgerStore.js';

export interface OpenSpecPageProps {
  readonly changes: readonly LedgerOpenSpecChange[] | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly file: LedgerOpenSpecFileView | null;
  readonly onRefresh: () => void;
  readonly onOpenFile: (change: LedgerOpenSpecChange, file: LedgerOpenSpecFileName) => void;
  readonly onCloseFile: () => void;
}

const OPEN_SPEC_FILES: readonly { readonly file: LedgerOpenSpecFileName; readonly label: string }[] = [
  { file: 'proposal.md', label: 'Mở proposal' },
  { file: 'tasks.md', label: 'Mở tasks' },
  { file: 'handoff.md', label: 'Mở handoff' },
];

function hasOpenSpecFile(change: LedgerOpenSpecChange, file: LedgerOpenSpecFileName): boolean {
  switch (file) {
    case 'proposal.md':
      return change.hasProposal;
    case 'tasks.md':
      return change.hasTasks;
    case 'handoff.md':
      return change.hasHandoff;
  }
}

export function OpenSpecPage({
  changes,
  loading,
  error,
  file,
  onRefresh,
  onOpenFile,
  onCloseFile,
}: OpenSpecPageProps) {
  return (
    <main className="company-shell-page flex min-h-0 flex-1 flex-col overflow-hidden" aria-label="OpenSpec">
      <header className="flex items-center justify-between gap-3 border-b border-hairline px-4 py-3">
        <div className="min-w-0">
          <h1 className="text-base font-semibold text-text">OpenSpec</h1>
          <p className="text-xs text-text-muted">Changes và tiến độ theo từng repo, worktree, nhánh đang theo dõi.</p>
        </div>
        <button type="button" onClick={onRefresh} disabled={loading} className="company-btn company-btn-md company-btn-ghost touch-target shrink-0 disabled:opacity-50">
          {loading ? 'Đang làm mới…' : 'Làm mới'}
        </button>
      </header>
      {error !== null && <p role="alert" className="border-b border-hairline px-4 py-2 text-xs text-danger">{error}</p>}
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
        {loading && changes === null && (
          <p className="text-sm text-text-muted">Đang đọc OpenSpec của các worktree…</p>
        )}
        {error === null && !loading && (changes === null || changes.length === 0) && (
          <p className="text-sm text-text-muted">Không tìm thấy OpenSpec changes trong các worktree đang theo dõi.</p>
        )}
        {changes !== null && changes.length > 0 && (
          <ul aria-label="Danh sách OpenSpec changes" className="space-y-2">
            {changes.map((change) => (
              <li key={`${change.worktree}/${change.id}`} className="space-y-3 rounded border border-hairline bg-panel px-3 py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="break-words text-sm font-semibold text-text">{change.id}</h2>
                    <p className="text-xs text-text-secondary">
                      {change.repoName} · {change.worktreeName} · {change.branch ?? 'Chưa rõ nhánh'}
                    </p>
                    <p className="break-all font-mono text-[11px] text-text-muted" title={change.worktree}>{change.worktree}</p>
                  </div>
                  <span className="shrink-0 rounded border border-hairline px-2 py-1 text-xs text-text-secondary">
                    {change.progressPercent === null ? 'Tiến độ —' : `Tiến độ ${change.progressPercent}%`}
                    {change.totalTasks > 0 ? ` · ${change.completedTasks}/${change.totalTasks} tasks` : ''}
                  </span>
                </div>
                <p className="text-xs leading-relaxed text-text-secondary">{change.summary}</p>
                <div className="flex flex-wrap gap-2">
                  {OPEN_SPEC_FILES.filter(({ file: fileName }) => hasOpenSpecFile(change, fileName)).map(({ file: fileName, label }) => (
                    <button
                      key={fileName}
                      type="button"
                      onClick={() => onOpenFile(change, fileName)}
                      className="company-btn company-btn-sm company-btn-ghost touch-target"
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
        {file !== null && (
          <section aria-label={`Tệp ${file.changeId}/${file.file}`} className="overflow-hidden rounded border border-hairline bg-panel">
            <header className="flex items-center justify-between gap-3 border-b border-hairline px-3 py-2">
              <h2 className="min-w-0 truncate font-mono text-xs text-text" title={`${file.worktree}/openspec/changes/${file.changeId}/${file.file}`}>
                {file.worktree} · {file.changeId}/{file.file}
              </h2>
              <button type="button" onClick={onCloseFile} className="company-btn company-btn-sm company-btn-ghost touch-target shrink-0">Đóng</button>
            </header>
            {file.status === 'loading' && <p className="p-3 text-xs text-text-muted">Đang mở tệp…</p>}
            {file.status === 'failed' && (
              <p role="alert" className="p-3 text-xs text-danger">{file.reason ?? 'Không đọc được tệp OpenSpec.'}</p>
            )}
            {file.status === 'done' && (
              <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs text-text-secondary">{file.content}</pre>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
