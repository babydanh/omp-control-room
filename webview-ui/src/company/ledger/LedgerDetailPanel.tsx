/**
 * LedgerDetailPanel: what the selected branch, conflict, or session is, and the actions
 * the ledger allows on it: read a changed file's diff, send a message, open the board
 * session. Nothing here changes a checkout.
 */

import type {
  LedgerOverlapConflict,
  LedgerOverlapHunk,
  LedgerSession,
  LedgerView,
  LedgerWorktree,
} from '../../../../core/src/messages.js';
import { Icon } from '../components/Icon.js';
import { ledgerStore } from './ledgerClient.js';
import {
  aheadLabel,
  behindLabel,
  dirtyLabel,
  formatRelativeTime,
  presenceLabel,
  scanLabel,
  sessionTitle,
} from './ledgerFormat.js';
import { boardSessionFor, type BoardSessionIndex } from './ledgerMapping.js';
import { LedgerMessageForm, type LedgerMessageTarget } from './LedgerMessageForm.js';
import type { ResolvedSelection } from './ledgerSelection.js';
import type { LedgerDiffView, LedgerState } from './ledgerStore.js';

type ConflictSelection = Extract<ResolvedSelection, { kind: 'conflict' }>;

export interface LedgerDetailPanelProps {
  ledger: LedgerState;
  view: LedgerView;
  resolved: ResolvedSelection;
  boardSessions: BoardSessionIndex;
  onOpenBoardSession: (sessionId: string) => void;
  /** Shown as a close button in the header; a sheet that already has one omits it. */
  onClose?: () => void;
}

export function LedgerDetailPanel({
  ledger,
  view,
  resolved,
  boardSessions,
  onOpenBoardSession,
  onClose,
}: LedgerDetailPanelProps) {
  return (
    <section
      aria-label="Chi tiết"
      className="flex flex-col gap-2 rounded-(--company-radius-md) bg-panel p-2.5"
    >
      <header className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-sm text-text">{titleOf(resolved)}</h2>
        {onClose !== undefined && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng chi tiết"
            className="company-icon-btn touch-target"
          >
            <Icon name="close" />
          </button>
        )}
      </header>
      {resolved.kind === 'branch' && (
        <BranchDetail ledger={ledger} view={view} worktree={resolved.worktree} />
      )}
      {resolved.kind === 'conflict' && <ConflictDetail resolved={resolved} view={view} />}
      {resolved.kind === 'session' && (
        <SessionDetail
          ledger={ledger}
          view={view}
          session={resolved.session}
          boardKey={boardSessionFor(resolved.session.sessionId, boardSessions)}
          onOpenBoardSession={onOpenBoardSession}
        />
      )}
    </section>
  );
}

function titleOf(resolved: ResolvedSelection): string {
  if (resolved.kind === 'branch') return resolved.worktree.name;
  if (resolved.kind === 'conflict') return `${resolved.leftLabel} ↔ ${resolved.rightLabel}`;
  return sessionTitle(resolved.session);
}

function targetLabel(session: LedgerSession): string {
  return `${sessionTitle(session)}${session.live ? '' : ' (đã dừng)'}`;
}

function BranchDetail({
  ledger,
  view,
  worktree,
}: {
  ledger: LedgerState;
  view: LedgerView;
  worktree: LedgerWorktree;
}) {
  const sessions = view.sessions.filter((session) =>
    worktree.sessionIds.includes(session.sessionId),
  );
  const diff = ledger.diff !== null && ledger.diff.worktree === worktree.path ? ledger.diff : null;
  const targets: LedgerMessageTarget[] = sessions.map((session) => ({
    sessionId: session.sessionId,
    label: targetLabel(session),
  }));
  const hiddenDirty = worktree.dirtyCount - worktree.dirtyFiles.length;

  return (
    <>
      <p className="truncate font-mono text-2xs text-text-muted" title={worktree.path}>
        {worktree.path}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-2xs">
        <dt className="text-text-muted">Nhánh</dt>
        <dd className="truncate text-text">
          {worktree.branch ?? 'chưa có nhánh'} · {worktree.head.slice(0, 8)}
        </dd>
        <dt className="text-text-muted">So với main</dt>
        <dd className="text-text">
          {worktree.isMain
            ? 'checkout chính'
            : `${aheadLabel(worktree.ahead)} · ${behindLabel(worktree.behind)}`}
          {worktree.merged && ' · đã gộp'}
          {!worktree.hasUpstream && ' · chưa có upstream'}
        </dd>
        <dt className="text-text-muted">Thay đổi</dt>
        <dd className="text-text">{dirtyLabel(worktree.dirtyCount)}</dd>
        <dt className="text-text-muted">Commit cuối</dt>
        <dd className="text-text">
          {worktree.lastCommitSubject || '—'} ·{' '}
          {formatRelativeTime(worktree.lastCommitAt, view.generatedAt)}
        </dd>
      </dl>
      {worktree.gitError !== undefined && (
        <p role="alert" className="text-2xs text-danger">
          {worktree.gitError}
        </p>
      )}
      {worktree.dirtyFiles.length > 0 && (
        <section className="flex flex-col gap-1">
          <h3 className="text-2xs text-text-muted">Tệp đã sửa · bấm để xem thay đổi</h3>
          <ul className="flex flex-col gap-0.5">
            {worktree.dirtyFiles.map((file) => {
              const picked = diff !== null && diff.path === file.path;
              return (
                <li key={file.path}>
                  <button
                    type="button"
                    aria-pressed={picked}
                    onClick={() => ledgerStore.requestFileDiff(worktree.path, file.path)}
                    className={`flex w-full items-center gap-2 rounded-(--company-radius-sm) px-1 py-0.5 text-left text-xs text-text hover:bg-hover ${picked ? 'bg-selected' : ''}`}
                  >
                    <span className="w-6 shrink-0 font-mono text-2xs text-text-muted">
                      {file.status}
                    </span>
                    <span className="truncate">{file.path}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {hiddenDirty > 0 && (
            <p className="text-2xs text-text-muted">… còn {hiddenDirty} tệp khác.</p>
          )}
          {diff !== null && <DiffView diff={diff} />}
        </section>
      )}
      <section className="flex flex-col gap-1">
        <h3 className="text-2xs text-text-muted">Phiên làm việc ({sessions.length})</h3>
        {sessions.length === 0 ? (
          <p className="text-2xs text-text-muted">Chưa có phiên nào trên nhánh này.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {sessions.map((session) => (
              <li key={session.sessionId} className="text-xs text-text">
                {sessionTitle(session)}{' '}
                <span className="text-2xs text-text-muted">{presenceLabel(session)}</span>
                {session.lastIntent !== null && (
                  <span className="block truncate text-2xs text-text-muted">
                    {session.lastIntent}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <LedgerMessageForm key={worktree.path} targets={targets} sends={ledger.sends} />
    </>
  );
}

function DiffView({ diff }: { diff: LedgerDiffView }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="truncate font-mono text-2xs text-text-muted" title={diff.path}>
        {diff.path}
      </p>
      {diff.status === 'loading' && (
        <p role="status" className="text-2xs text-text-muted">
          Đang tải thay đổi…
        </p>
      )}
      {diff.status === 'failed' && (
        <p role="alert" className="text-2xs text-danger">
          {diff.reason ?? 'Không đọc được thay đổi.'}
        </p>
      )}
      {diff.status === 'done' && diff.diff.trim() === '' && (
        <p className="text-2xs text-text-muted">Không có thay đổi so với HEAD.</p>
      )}
      {diff.status === 'done' && diff.diff.trim() !== '' && (
        <pre className="max-h-64 overflow-auto whitespace-pre rounded-(--company-radius-sm) bg-well p-2 font-mono text-2xs text-text">
          {diff.diff}
        </pre>
      )}
      {diff.status === 'done' && diff.truncated && (
        <p className="text-2xs text-warning">Diff bị cắt ngắn.</p>
      )}
    </div>
  );
}

function ConflictDetail({ resolved, view }: { resolved: ConflictSelection; view: LedgerView }) {
  const { scan, leftLabel, rightLabel, conflicts, auto } = resolved;
  const complete = scan.complete;
  return (
    <>
      <p className="text-2xs text-text-muted">
        {scanLabel(scan)}
        {scan.startedAt !== null &&
          ` · quét lúc ${formatRelativeTime(scan.startedAt, view.generatedAt)}`}
      </p>
      {!complete && (
        <p role="status" className="text-2xs text-warning">
          Quét chưa hoàn tất: danh sách có thể chưa đầy đủ, không được coi là sạch.
        </p>
      )}
      {scan.error !== null && (
        <p role="alert" className="text-2xs text-danger">
          {scan.error}
        </p>
      )}
      {conflicts.length === 0 ? (
        <p className="text-2xs text-text-muted">
          {complete ? 'Không có tệp xung đột.' : 'Chưa thấy tệp xung đột trong phần đã quét.'}
        </p>
      ) : (
        conflicts.map((conflict) => (
          <ConflictFile
            key={conflict.file}
            conflict={conflict}
            leftLabel={leftLabel}
            rightLabel={rightLabel}
          />
        ))
      )}
      {auto.length > 0 && (
        <p className="text-2xs text-text-muted">Tự gộp được: {auto.join(', ')}</p>
      )}
      {scan.pending.length > 0 && (
        <p className="text-2xs text-text-muted">Đang chờ quét: {scan.pending.join(', ')}</p>
      )}
    </>
  );
}

function ConflictFile({
  conflict,
  leftLabel,
  rightLabel,
}: {
  conflict: LedgerOverlapConflict;
  leftLabel: string;
  rightLabel: string;
}) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="truncate font-mono text-xs text-text" title={conflict.file}>
        {conflict.file}
      </h3>
      {conflict.hunks.map((hunk) => (
        <HunkView key={hunk.line} hunk={hunk} leftLabel={leftLabel} rightLabel={rightLabel} />
      ))}
    </section>
  );
}

function HunkView({
  hunk,
  leftLabel,
  rightLabel,
}: {
  hunk: LedgerOverlapHunk;
  leftLabel: string;
  rightLabel: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-2xs text-text-muted">
        Dòng {hunk.line}
        {hunk.symbol === '' ? '' : ` · ${hunk.symbol}`}
      </p>
      <HunkSide label={leftLabel} lines={hunk.ours} />
      <HunkSide label={rightLabel} lines={hunk.theirs} />
    </div>
  );
}

function HunkSide({ label, lines }: { label: string; lines: string[] }) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-2xs text-text-secondary">{label}</p>
      <pre className="overflow-x-auto whitespace-pre rounded-(--company-radius-sm) bg-well p-1 font-mono text-2xs text-text">
        {lines.join('\n')}
      </pre>
    </div>
  );
}

function SessionDetail({
  ledger,
  view,
  session,
  boardKey,
  onOpenBoardSession,
}: {
  ledger: LedgerState;
  view: LedgerView;
  session: LedgerSession;
  boardKey: string | null;
  onOpenBoardSession: (sessionId: string) => void;
}) {
  return (
    <>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-2xs">
        <dt className="text-text-muted">Trạng thái</dt>
        <dd className="text-text">
          {presenceLabel(session)} · {session.state}
        </dd>
        <dt className="text-text-muted">Repo</dt>
        <dd className="truncate text-text">
          {session.repo ?? 'không rõ'}
          {session.branch !== null && ` · ${session.branch}`}
        </dd>
        <dt className="text-text-muted">Thư mục</dt>
        <dd className="truncate font-mono text-text" title={session.cwd}>
          {session.cwd}
        </dd>
        <dt className="text-text-muted">Gọi công cụ</dt>
        <dd className="text-text">
          {session.calls5m} lần / 5 phút · {session.calls30m} lần / 30 phút
        </dd>
        <dt className="text-text-muted">Gọi gần nhất</dt>
        <dd className="text-text">{formatRelativeTime(session.lastCallAt, view.generatedAt)}</dd>
        <dt className="text-text-muted">Việc gần nhất</dt>
        <dd className="text-text">{session.lastIntent ?? '—'}</dd>
      </dl>
      {session.spamming && (
        <p
          role="status"
          className="rounded-(--company-radius-sm) bg-danger/14 p-1.5 text-2xs text-danger"
        >
          Phiên này đang spam: {session.spamReason ?? 'vượt ngưỡng gọi.'}
        </p>
      )}
      {boardKey !== null && (
        <button
          type="button"
          onClick={() => onOpenBoardSession(boardKey)}
          className="company-btn company-btn-md company-btn-ghost touch-target self-start"
        >
          <Icon name="external" /> Mở trong ngăn kéo
        </button>
      )}
      <LedgerMessageForm
        key={session.sessionId}
        targets={[{ sessionId: session.sessionId, label: targetLabel(session) }]}
        sends={ledger.sends}
      />
    </>
  );
}
