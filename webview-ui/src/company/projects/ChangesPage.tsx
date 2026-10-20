import { useEffect, useMemo, useState } from 'react';

import type { ProjectDiffFile, ProjectTreeNode } from '../../../../core/src/messages.js';
import { CompanyButton } from '../components/CompanyButton.js';
import { numberDiffLines,type NumberedDiffLine } from './projectDiffLines.js';
import { type ProjectStore, useProjectState } from './projectStore.js';
import { highlightLine, type SyntaxKind } from './projectSyntax.js';

export interface ChangesPageProps {
  store: ProjectStore;
  checkoutId: string;
  onClose: () => void;
  initialTab?: 'diff' | 'merge';
}

const SYNTAX_CLASS: Readonly<Record<SyntaxKind, string>> = {
  plain: '',
  keyword: 'text-orchid',
  string: 'text-caution',
  comment: 'text-text-muted italic',
  number: 'text-accent-bright',
  type: 'text-status-active',
};
const LINE_CLASS: Readonly<Record<NumberedDiffLine['kind'], string>> = {
  addition: 'bg-status-success/15',
  deletion: 'bg-status-error/15',
  context: '',
  meta: 'bg-raised text-text-muted',
};
const MARK_CLASS: Readonly<Record<NumberedDiffLine['kind'], string>> = {
  addition: 'text-status-success',
  deletion: 'text-status-error',
  context: 'text-text-muted',
  meta: 'text-text-muted',
};
const FIELD_CLASS = 'rounded border border-border bg-well px-2 py-1 text-text';

export function ChangesPage({ store, checkoutId: initialCheckout, onClose, initialTab = 'diff' }: ChangesPageProps) {
  const state = useProjectState(store);
  const [tab, setTab] = useState<'diff' | 'merge'>(initialTab);
  const [scope, setScope] = useState<'uncommitted' | 'branch' | 'commit'>('uncommitted');
  const [sha, setSha] = useState('');
  const [selectedPath, setSelectedPath] = useState('');
  const [commentLine, setCommentLine] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [receiver, setReceiver] = useState('');
  const [branchB, setBranchB] = useState('');
  const [picked, setPicked] = useState(initialCheckout);
  useEffect(() => setPicked(initialCheckout), [initialCheckout]);

  const nodes = state.nodes;
  const checkouts = nodes.filter((node) => node.kind === 'checkout' && node.path !== undefined);
  // Opened from the nav with nothing picked: start on a checkout whose lines changed, else any dirty one.
  const changed = checkouts.find((node) => (node.additions ?? 0) + (node.deletions ?? 0) > 0) ?? checkouts.find((node) => node.dirty);
  const checkoutId = picked !== '' ? picked : (changed ?? checkouts[0])?.path ?? '';

  useEffect(() => { store.requestTree(); }, [store]);
  useEffect(() => {
    if (checkoutId === '' || (scope === 'commit' && !sha.trim())) return;
    store.requestDiff({ checkout: checkoutId, scope, sha: scope === 'commit' ? sha.trim() : '' });
  }, [checkoutId, scope, sha, store]);

  const checkout = nodes.find((node) => node.id === checkoutId || node.path === checkoutId);
  const repoId = checkout?.parentId;
  const branches = nodes.filter((node) => node.kind === 'checkout' && node.parentId === repoId && node.id !== checkout?.id && node.branch);
  const sessions = nodes.filter((node) => node.kind === 'session' && node.parentId === checkout?.id && node.sessionId && !['ended', 'stopped', 'closed', 'exited'].includes((node.state ?? '').toLowerCase()));
  const activeDiff = state.diff?.checkout === checkoutId && state.diff.scope === scope &&
    (scope !== 'commit' || state.diff.sha.toLowerCase().startsWith(sha.trim().toLowerCase()))
    ? state.diff : null;
  const selected = activeDiff?.files.find((file) => file.path === selectedPath) ?? activeDiff?.files[0];
  const lines = useMemo(() => selected?.hunks.flatMap((hunk) => numberDiffLines(`${hunk.header}\n${hunk.content}`)) ?? [], [selected]);
  const sending = Object.values(state.pending).some((request) => request.type === 'projectDiffRequest' && request.checkout === checkoutId && request.scope === scope);
  const repoName = (node: ProjectTreeNode) => nodes.find((candidate) => candidate.id === node.parentId)?.name ?? '';

  useEffect(() => {
    const fallback = sessions.find((session) => session.state === 'running')?.sessionId ?? sessions[0]?.sessionId ?? '';
    if (!sessions.some((session) => session.sessionId === receiver)) setReceiver(fallback);
  }, [receiver, sessions]);
  useEffect(() => { setSelectedPath(activeDiff?.files[0]?.path ?? ''); }, [activeDiff]);

  const submitComment = () => {
    if (selected === undefined || commentLine === null || comment.trim() === '' || receiver === '') return;
    const lineIndex = lines.findIndex((line) => line.newLine === commentLine || line.oldLine === commentLine);
    const snippet = lines.slice(Math.max(0, lineIndex - 3), lineIndex + 4)
      .filter((line) => line.kind !== 'meta')
      .map((line) => `${line.newLine ?? line.oldLine ?? ''} ${line.text}`)
      .join('\n')
      .slice(0, 1200);
    store.sendComment({ checkout: checkoutId, file: selected.path, line: commentLine, snippet, content: comment.trim().slice(0, 4000), receivingSessionId: receiver });
    setComment('');
    setCommentLine(null);
  };

  const tabClass = (active: boolean) => `rounded px-3 py-1.5 text-sm ${active ? 'bg-selected text-text' : 'text-text-secondary hover:bg-hover'}`;

  return <main className="company-ui flex h-full min-h-0 flex-col gap-3 bg-panel p-4 text-text" aria-label="Thay đổi">
    <header className="flex items-center justify-between gap-3 border-b border-hairline pb-3">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold">Thay đổi</h1>
        <select aria-label="Worktree" className={`mt-1 max-w-full text-xs ${FIELD_CLASS}`} value={checkout?.path ?? ''} onChange={(event) => { setPicked(event.target.value); setSelectedPath(''); setCommentLine(null); }}>
          {checkouts.length === 0 && <option value="">Đang tải worktree…</option>}
          {checkouts.map((node) => (
            <option key={node.id} value={node.path}>{`${node.dirty ? '● ' : ''}${repoName(node)} · ${node.branch ?? node.name}${node.dirty ? ` (+${node.additions ?? 0} −${node.deletions ?? 0})` : ''}`}</option>
          ))}
        </select>
      </div>
      <CompanyButton size="sm" onClick={onClose}>Đóng</CompanyButton>
    </header>
    <nav className="flex gap-2" aria-label="Chế độ xem">
      <button className={tabClass(tab === 'diff')} onClick={() => setTab('diff')}>Diff</button>
      <button className={tabClass(tab === 'merge')} onClick={() => setTab('merge')}>Thử gộp</button>
    </nav>
    {tab === 'diff' ? <>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm text-text-secondary">Phạm vi <select className={FIELD_CLASS} value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}><option value="uncommitted">Chưa commit</option><option value="branch">Cả nhánh so với main</option><option value="commit">Theo commit</option></select></label>
        {scope === 'commit' && <input aria-label="SHA commit" className={`min-w-48 font-mono text-sm ${FIELD_CLASS}`} value={sha} onChange={(event) => setSha(event.target.value)} placeholder="SHA commit" />}
        {sending && <span className="text-xs text-text-muted">Đang tải…</span>}
        {activeDiff?.truncated && <span role="status" className="text-xs text-warning">Đã cắt bớt: {activeDiff.reason ?? 'diff vượt giới hạn.'}</span>}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(220px,30%)_1fr] overflow-hidden rounded border border-hairline">
        <aside className="min-h-0 overflow-auto border-r border-hairline bg-well" aria-label="Tệp đã thay đổi">
          {activeDiff?.files.map((file) => <FileRow key={file.path} file={file} selected={file.path === (selected?.path ?? selectedPath)} onClick={() => { setSelectedPath(file.path); setCommentLine(null); }} />)}
          {activeDiff?.files.length === 0 && <p className="p-4 text-sm text-text-muted">Không có thay đổi.</p>}
        </aside>
        <section className="min-h-0 overflow-auto bg-bg-dark font-mono text-xs leading-5" aria-label="Diff">
          {selected === undefined ? <p className="p-4 text-text-muted">Chọn tệp để xem diff.</p> : <>
            <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-hairline bg-panel px-3 py-2 font-sans text-sm">
              <span className="min-w-0 truncate">{selected.oldPath ? `${selected.oldPath} → ` : ''}{selected.path}</span>
              <span className="text-status-success">+{selected.additions}</span>
              <span className="text-status-error">−{selected.deletions}</span>
              {selected.author && <span className="truncate text-text-muted">{selected.author}</span>}
            </div>
            {selected.status === 'binary'
              ? <p className="p-3 text-text-muted">Tệp nhị phân</p>
              : lines.map((line, index) => <DiffLine key={`${index}-${line.oldLine}-${line.newLine}`} line={line} filePath={selected.path} onComment={setCommentLine} />)}
          </>}
        </section>
      </div>
      {commentLine !== null && selected && <form className="flex flex-wrap items-end gap-2 border-t border-hairline pt-3" onSubmit={(event) => { event.preventDefault(); submitComment(); }}>
        <label className="text-xs text-text-secondary">Gửi tới phiên<select className={`mt-1 block text-sm ${FIELD_CLASS}`} value={receiver} onChange={(event) => setReceiver(event.target.value)}>{sessions.map((session) => <option key={session.sessionId} value={session.sessionId}>{session.title || session.sessionId}</option>)}</select></label>
        <label className="min-w-64 flex-1 text-xs text-text-secondary">Nhận xét dòng {commentLine}<input autoFocus className={`mt-1 block w-full text-sm ${FIELD_CLASS}`} value={comment} maxLength={4000} onChange={(event) => setComment(event.target.value)} /></label>
        <CompanyButton type="submit" size="sm" variant="accent" disabled={!receiver || !comment.trim()}>Gửi</CompanyButton>
        <CompanyButton type="button" size="sm" onClick={() => setCommentLine(null)}>Huỷ</CompanyButton>
      </form>}
    </> : <MergePanel store={store} checkout={checkout} branches={branches} branchB={branchB} setBranchB={setBranchB} nodes={nodes} />}
  </main>;
}

/** One diff line: tinted green/red for added/removed, line numbers you click to comment, code coloured by syntax. */
function DiffLine({ line, filePath, onComment }: { line: NumberedDiffLine; filePath: string; onComment: (line: number | null) => void }) {
  const tokens = useMemo(() => line.kind === 'meta' ? [{ text: line.text, kind: 'plain' as const }] : highlightLine(line.text, filePath), [line, filePath]);
  const numberClass = 'w-9 text-right text-text-muted hover:text-text disabled:invisible';
  return <div className={`flex whitespace-pre ${LINE_CLASS[line.kind]}`}>
    <span className="flex shrink-0 gap-1 border-r border-hairline pr-2">
      <button disabled={line.oldLine === null} className={numberClass} onClick={() => onComment(line.oldLine)}>{line.oldLine ?? ''}</button>
      <button disabled={line.newLine === null} className={numberClass} onClick={() => onComment(line.newLine)}>{line.newLine ?? ''}</button>
    </span>
    <span className={`w-5 shrink-0 select-none text-center ${MARK_CLASS[line.kind]}`}>{line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '−' : ''}</span>
    <span className="pr-3 text-text">{tokens.map((token, index) => <span key={index} className={SYNTAX_CLASS[token.kind]}>{token.text}</span>)}</span>
  </div>;
}

function FileRow({ file, selected, onClick }: { file: ProjectDiffFile; selected: boolean; onClick: () => void }) {
  const name = file.path.split('/').pop() ?? file.path;
  const folder = file.path.slice(0, file.path.length - name.length);
  return <button onClick={onClick} title={file.path} className={`block w-full border-b border-hairline px-3 py-2 text-left ${selected ? 'bg-selected' : 'hover:bg-hover'}`}>
    <span className="block truncate text-sm text-text">{name}</span>
    {folder !== '' && <span className="block truncate text-2xs text-text-muted">{folder}</span>}
    <span className="text-xs text-text-secondary">
      <span className="text-status-success">+{file.additions}</span> <span className="text-status-error">−{file.deletions}</span>
      {file.status !== 'modified' && ` · ${file.status}`}
      {file.author && ` · ${file.author}`}
    </span>
  </button>;
}

function MergePanel({ store, checkout, branches, branchB, setBranchB, nodes }: { store: ProjectStore; checkout?: ProjectTreeNode; branches: ProjectTreeNode[]; branchB: string; setBranchB: (branch: string) => void; nodes: readonly ProjectTreeNode[] }) {
  const [branchA, setBranchA] = useState(checkout?.branch ?? '');
  const [requestId, setRequestId] = useState<string | null>(null);
  useEffect(() => setBranchA(checkout?.branch ?? ''), [checkout?.branch]);
  // A result belongs to the pair it was asked for; another pair starts blank.
  useEffect(() => setRequestId(null), [branchA, branchB]);
  const state = useProjectState(store);
  // Matched by request id: the server may spell the repo path differently from the tree.
  const answer = requestId === null ? undefined : state.results[requestId];
  const result = answer?.type === 'projectMergePreviewResult' ? answer : undefined;
  const running = requestId !== null && state.pending[requestId] !== undefined;
  const repo = nodes.find((node) => node.id === checkout?.parentId);
  return <section className="flex flex-col gap-3 rounded border border-hairline bg-well p-4">
    <p className="text-sm text-text-secondary">Chỉ xét phần đã commit; thay đổi chưa commit không được tính.</p>
    <div className="flex flex-wrap items-center gap-2">
      <label className="text-sm text-text-secondary">Nhánh hiện tại<select className={`ml-2 ${FIELD_CLASS}`} value={branchA} onChange={(event) => setBranchA(event.target.value)}><option value="">Chọn nhánh</option>{[checkout, ...branches].filter((node): node is ProjectTreeNode => node !== undefined && Boolean(node.branch)).map((node) => <option key={node.id} value={node.branch ?? ''}>{node.branch}</option>)}</select></label>
      <span aria-hidden="true" className="text-text-muted">→</span>
      <label className="text-sm text-text-secondary">Nhánh kia<select className={`ml-2 ${FIELD_CLASS}`} value={branchB} onChange={(event) => setBranchB(event.target.value)}><option value="">Chọn nhánh</option>{branches.map((node) => <option key={node.id} value={node.branch ?? ''}>{node.branch}</option>)}</select></label>
      <CompanyButton size="sm" variant="accent" disabled={running || !repo?.path || !branchA || !branchB || branchA === branchB} onClick={() => { if (repo?.path) setRequestId(store.previewMerge({ repo: repo.path, branchA, branchB })); }}>{running ? 'Đang thử…' : 'Thử gộp'}</CompanyButton>
    </div>
    {result !== undefined && (
      <div role="status" className="text-sm">
        {result.reason !== undefined && result.reason !== '' && result.conflicts.length === 0 && !result.clean
          ? <p className="text-status-error">{result.reason}</p>
          : <p className={result.clean ? 'text-status-success' : 'text-status-error'}>{result.clean ? 'Không có xung đột' : `Có xung đột ở ${result.conflicts.length} tệp`}</p>}
        {result.conflicts.map((file) => <p key={file} className="font-mono text-xs">{file}</p>)}
      </div>
    )}
  </section>;
}
