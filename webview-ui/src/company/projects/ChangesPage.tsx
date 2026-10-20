import { useEffect, useMemo, useState } from 'react';

import type { ProjectDiffFile, ProjectMergePreviewResultMessage, ProjectTreeNode } from '../../../../core/src/messages.js';
import { numberDiffLines } from './projectDiffLines.js';
import { type ProjectStore, useProjectState } from './projectStore.js';

export interface ChangesPageProps {
  store: ProjectStore;
  checkoutId: string;
  onClose: () => void;
  initialTab?: 'diff' | 'merge';
}

export function ChangesPage({ store, checkoutId, onClose, initialTab = 'diff' }: ChangesPageProps) {
  const state = useProjectState(store);
  const [tab, setTab] = useState<'diff' | 'merge'>(initialTab);
  const [scope, setScope] = useState<'uncommitted' | 'branch' | 'commit'>('uncommitted');
  const [sha, setSha] = useState('');
  const [selectedPath, setSelectedPath] = useState('');
  const [commentLine, setCommentLine] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [receiver, setReceiver] = useState('');
  const [branchB, setBranchB] = useState('');

  useEffect(() => { store.requestTree(); }, [store]);
  useEffect(() => { if (scope !== 'commit' || sha.trim()) store.requestDiff({ checkout: checkoutId, scope, sha: scope === 'commit' ? sha.trim() : '' }); }, [checkoutId, scope, sha, store]);

  const nodes = state.nodes;
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

  return <main className="company-ui flex h-full min-h-0 flex-col gap-3 bg-panel p-4 text-primary" aria-label="Thay đổi">
    <header className="flex items-center justify-between border-b border-border/60 pb-3">
      <div><h1 className="text-lg font-semibold">Thay đổi</h1><p className="text-xs text-secondary">{checkout?.name ?? checkoutId}</p></div>
      <button className="rounded border border-border px-3 py-1 text-sm hover:bg-panel-hover" onClick={onClose}>Đóng</button>
    </header>
    <nav className="flex gap-2" aria-label="Chế độ xem">
      <button className={`rounded px-3 py-1.5 text-sm ${tab === 'diff' ? 'bg-panel-hover text-primary' : 'text-secondary'}`} onClick={() => setTab('diff')}>Diff</button>
      <button className={`rounded px-3 py-1.5 text-sm ${tab === 'merge' ? 'bg-panel-hover text-primary' : 'text-secondary'}`} onClick={() => setTab('merge')}>Thử gộp</button>
    </nav>
    {tab === 'diff' ? <>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm">Phạm vi <select className="rounded border border-border bg-panel px-2 py-1" value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}><option value="uncommitted">Chưa commit</option><option value="branch">Cả nhánh so với main</option><option value="commit">Theo commit</option></select></label>
        {scope === 'commit' && <input aria-label="SHA commit" className="min-w-48 rounded border border-border bg-panel px-2 py-1 font-mono text-sm" value={sha} onChange={(event) => setSha(event.target.value)} placeholder="SHA commit" />}
        {sending && <span className="text-xs text-secondary">Đang tải…</span>}
        {activeDiff?.truncated && <span role="status" className="text-xs text-warning">Đã cắt bớt: {activeDiff.reason ?? 'diff vượt giới hạn.'}</span>}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(220px,30%)_1fr] overflow-hidden rounded border border-border/60">
        <aside className="min-h-0 overflow-auto border-r border-border/60" aria-label="Tệp đã thay đổi">
          {activeDiff?.files.map((file) => <FileRow key={file.path} file={file} selected={file.path === (selected?.path ?? selectedPath)} onClick={() => { setSelectedPath(file.path); setCommentLine(null); }} />)}
          {activeDiff?.files.length === 0 && <p className="p-4 text-sm text-secondary">Không có thay đổi.</p>}
        </aside>
        <section className="min-h-0 overflow-auto font-mono text-xs" aria-label="Diff">
          {selected === undefined ? <p className="p-4 text-secondary">Chọn tệp để xem diff.</p> : <>
            <div className="sticky top-0 border-b border-border/60 bg-panel px-3 py-2 font-sans text-sm">{selected.oldPath ? `${selected.oldPath} → ` : ''}{selected.path}<span className="ml-3 text-success">+{selected.additions}</span><span className="ml-2 text-danger">−{selected.deletions}</span><span className="ml-2 text-secondary">{selected.author}</span></div>
            {selected.status === 'binary' ? <p className="p-3 text-secondary">Tệp nhị phân</p> : lines.map((line, index) => <div key={`${index}-${line.oldLine}-${line.newLine}`} className={`flex whitespace-pre ${line.kind === 'addition' ? 'bg-success/10 text-success' : line.kind === 'deletion' ? 'bg-danger/10 text-danger' : line.kind === 'meta' ? 'bg-panel-hover text-secondary' : ''}`}>
              <span className="flex w-20 shrink-0 justify-end gap-2 border-r border-border/40 pr-2 text-secondary"><button disabled={line.newLine === null} className="w-8 text-right hover:text-primary disabled:invisible" onClick={() => setCommentLine(line.newLine)}>{line.newLine ?? ''}</button><button disabled={line.oldLine === null} className="w-8 text-right hover:text-primary disabled:invisible" onClick={() => setCommentLine(line.oldLine)}>{line.oldLine ?? ''}</button></span><span className="px-2">{line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '−' : ''}{line.text}</span>
            </div>)}
          </>}
        </section>
      </div>
      {commentLine !== null && selected && <form className="flex flex-wrap items-end gap-2 border-t border-border/60 pt-3" onSubmit={(event) => { event.preventDefault(); submitComment(); }}>
        <label className="text-xs">Gửi tới phiên<select className="mt-1 block rounded border border-border bg-panel px-2 py-1 text-sm" value={receiver} onChange={(event) => setReceiver(event.target.value)}>{sessions.map((session) => <option key={session.sessionId} value={session.sessionId}>{session.title || session.sessionId}</option>)}</select></label>
        <label className="min-w-64 flex-1 text-xs">Nhận xét dòng {commentLine}<input autoFocus className="mt-1 block w-full rounded border border-border bg-panel px-2 py-1 text-sm" value={comment} maxLength={4000} onChange={(event) => setComment(event.target.value)} /></label>
        <button disabled={!receiver || !comment.trim()} className="rounded bg-accent px-3 py-1.5 text-sm text-on-accent disabled:opacity-50">Gửi</button>
        <button type="button" className="rounded border border-border px-3 py-1.5 text-sm" onClick={() => setCommentLine(null)}>Huỷ</button>
      </form>}
    </> : <MergePanel store={store} checkout={checkout} branches={branches} branchB={branchB} setBranchB={setBranchB} nodes={nodes} />}
  </main>;
}

function FileRow({ file, selected, onClick }: { file: ProjectDiffFile; selected: boolean; onClick: () => void }) {
  return <button onClick={onClick} className={`block w-full border-b border-border/40 px-3 py-2 text-left ${selected ? 'bg-panel-hover' : 'hover:bg-panel-hover/60'}`}><span className="block truncate text-sm">{file.path}</span><span className="text-xs text-secondary">{file.status} · <span className="text-success">+{file.additions}</span> / <span className="text-danger">−{file.deletions}</span>{file.author && ` · ${file.author}`}</span></button>;
}

function MergePanel({ store, checkout, branches, branchB, setBranchB, nodes }: { store: ProjectStore; checkout?: ProjectTreeNode; branches: ProjectTreeNode[]; branchB: string; setBranchB: (branch: string) => void; nodes: readonly ProjectTreeNode[] }) {
  const [branchA, setBranchA] = useState(checkout?.branch ?? '');
  useEffect(() => setBranchA(checkout?.branch ?? ''), [checkout?.branch]);
  const result = Object.values(useProjectState(store).results)
    .filter((entry): entry is ProjectMergePreviewResultMessage => entry.type === 'projectMergePreviewResult')
    .find((entry) => entry.repo === nodes.find((node) => node.id === checkout?.parentId)?.path && entry.branchA === branchA && entry.branchB === branchB);
  const repo = nodes.find((node) => node.id === checkout?.parentId);
  return <section className="flex flex-col gap-3 rounded border border-border/60 p-4">
    <p className="text-sm text-secondary">Chỉ xét phần đã commit; thay đổi chưa commit không được tính.</p>
    <div className="flex flex-wrap items-center gap-2"><label className="text-sm">Nhánh hiện tại<select className="ml-2 rounded border border-border bg-panel px-2 py-1" value={branchA} onChange={(event) => setBranchA(event.target.value)}><option value="">Chọn nhánh</option>{[checkout, ...branches].filter((node): node is ProjectTreeNode => node !== undefined && Boolean(node.branch)).map((node) => <option key={node.id} value={node.branch ?? ''}>{node.branch}</option>)}</select></label><span aria-hidden="true">→</span><label className="text-sm">Nhánh kia<select className="ml-2 rounded border border-border bg-panel px-2 py-1" value={branchB} onChange={(event) => setBranchB(event.target.value)}><option value="">Chọn nhánh</option>{branches.map((node) => <option key={node.id} value={node.branch ?? ''}>{node.branch}</option>)}</select></label><button disabled={!repo?.path || !branchA || !branchB || branchA === branchB} className="rounded bg-accent px-3 py-1.5 text-sm text-on-accent disabled:opacity-50" onClick={() => repo?.path && store.previewMerge({ repo: repo.path, branchA, branchB })}>Thử gộp</button></div>
    {result && <div role="status" className="text-sm"><p className={result.clean ? 'text-success' : 'text-danger'}>{result.clean ? 'Không có xung đột' : 'Có xung đột'}</p>{result.conflicts.map((file) => <p key={file} className="font-mono text-xs">{file}</p>)}</div>}
  </section>;
}
