import { useEffect, useState } from 'react';

import type { ProjectBranchCompareMessage, ProjectDiffMessage, ProjectTreeNode } from '../../../../core/src/messages.js';
import { relativeTimeVi } from '../agentSidebarView.js';
import { CompanyButton } from '../components/CompanyButton.js';
import { ledgerStore } from '../ledger/ledgerClient.js';
import { useNow } from '../useNow.js';
import { chooseMergeFirst, chooseNewerSide, classifyComparedFiles, composeRebaseMessage } from './branchCompareView.js';
import { ProjectDiffLine } from './ProjectDiffLine.js';
import { numberDiffLines } from './projectDiffLines.js';
import { type ProjectStore, useProjectState } from './projectStore.js';

interface BranchComparePanelProps {
  store: ProjectStore;
  checkout?: ProjectTreeNode;
  branches: ProjectTreeNode[];
  initialBranchA: string;
  nodes: readonly ProjectTreeNode[];
}

const FIELD_CLASS = 'rounded border border-hairline bg-well px-2 py-1 text-text';

export function BranchComparePanel({ store, checkout, branches, initialBranchA, nodes }: BranchComparePanelProps) {
  const state = useProjectState(store);
  const [branchA, setBranchA] = useState(initialBranchA || checkout?.branch || '');
  const [branchB, setBranchB] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [expandedConflict, setExpandedConflict] = useState<string | null>(null);
  const [diffVisible, setDiffVisible] = useState(false);
  const repo = nodes.find((node) => node.id === checkout?.parentId);
  const resultValue = requestId === null ? undefined : state.results[requestId];
  const result = resultValue?.type === 'projectBranchCompare' ? resultValue : undefined;
  const pending = requestId !== null && state.pending[requestId] !== undefined;
  const failure = requestId === null ? undefined : state.errors[`compare:${repo?.path ?? ''}:${branchA}:${branchB}`];

  useEffect(() => setBranchA(initialBranchA || checkout?.branch || ''), [initialBranchA, checkout?.branch]);
  useEffect(() => setRequestId(null), [branchA, branchB]);
  const compare = () => {
    if (!repo?.path || !branchA || !branchB || branchA === branchB) return;
    setRequestId(store.requestBranchCompare({ repo: repo.path, branchA, branchB }));
    setDiffVisible(false);
  };
  const startDiff = () => {
    if (result?.a.checkout === undefined) return;
    store.requestDiff({ checkout: result.a.checkout, scope: 'compare', sha: result.branchB });
    setDiffVisible(true);
  };
  const diff = state.diff?.scope === 'compare' && state.diff.checkout === result?.a.checkout ? state.diff : null;

  return <section className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto rounded border border-hairline bg-well p-3" aria-label="So sánh nhánh">
    <div className="flex flex-wrap items-center gap-2">
      <label className="text-xs text-text-secondary">Nhánh A<select aria-label="Nhánh A" className={`ml-2 text-sm ${FIELD_CLASS}`} value={branchA} onChange={(event) => setBranchA(event.target.value)}><option value="">Chọn nhánh</option>{branches.filter((node) => node.branch).map((node) => <option key={node.id} value={node.branch}>{node.branch}</option>)}</select></label>
      <button type="button" aria-label="Đổi chỗ hai nhánh" className="rounded px-2 py-1 text-sm text-text-secondary hover:bg-hover" onClick={() => { setBranchA(branchB); setBranchB(branchA); }}>⇄</button>
      <label className="text-xs text-text-secondary">Nhánh B<select aria-label="Nhánh B" className={`ml-2 text-sm ${FIELD_CLASS}`} value={branchB} onChange={(event) => setBranchB(event.target.value)}><option value="">Chọn nhánh</option>{branches.filter((node) => node.branch).map((node) => <option key={node.id} value={node.branch}>{node.branch}</option>)}</select></label>
      <CompanyButton size="sm" variant="accent" disabled={pending || !repo?.path || !branchA || !branchB || branchA === branchB} onClick={compare}>{pending ? 'Đang so sánh…' : 'So sánh'}</CompanyButton>
    </div>
    {!result && !pending && !failure && <p className="text-sm text-text-muted">Chọn hai nhánh trong cùng repo rồi bấm So sánh.</p>}
    {failure && <p role="alert" className="text-sm text-status-error">{failure}</p>}
    {result?.reason && <p role="alert" className="text-sm text-status-error">{result.reason}</p>}
    {result && !result.reason && <CompareResult result={result} store={store} nodes={nodes} expandedConflict={expandedConflict} setExpandedConflict={setExpandedConflict} onDiff={startDiff} />}
    {diffVisible && <DiffResult diff={diff} />}
  </section>;
}

function CompareResult({ result, store, nodes, expandedConflict, setExpandedConflict, onDiff }: {
  result: ProjectBranchCompareMessage;
  store: ProjectStore;
  nodes: readonly ProjectTreeNode[];
  expandedConflict: string | null;
  setExpandedConflict: (file: string | null) => void;
  onDiff: () => void;
}) {
  const state = useProjectState(store);
  const [commitCheckout, setCommitCheckout] = useState<string | null>(null);
  const newer = chooseNewerSide(result.a, result.b);
  const files = classifyComparedFiles(result.files);
  const mergeFirst = chooseMergeFirst(result.onlyA.length, result.onlyB.length, result.branchA, result.branchB);
  const rebaseBranch = mergeFirst === result.branchA ? result.branchB : result.branchA;
  const rebaseSide = rebaseBranch === result.branchA ? result.a : result.b;
  const sessions = rebaseSide.checkout === undefined ? [] : nodes.filter((node) => node.kind === 'session' && node.parentId === nodes.find((candidate) => candidate.path === rebaseSide.checkout)?.id && node.sessionId && !['ended', 'stopped', 'closed', 'exited'].includes((node.state ?? '').toLowerCase()));
  const message = composeRebaseMessage({ file: result.conflicts[0]?.file ?? '(các tệp xung đột)', line: result.conflicts[0]?.hunks[0]?.line ?? 1, checkout: rebaseSide.checkout ?? '', branch: mergeFirst });
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(message.slice(message.indexOf('git -C')));
    setCopied(true);
  };

  function openCommit(sha: string, branch: string): void {
    const side = branch === result.branchA ? result.a : result.b;
    if (side.checkout) {
      store.requestDiff({ checkout: side.checkout, scope: 'commit', sha });
      setCommitCheckout(side.checkout);
    }
  }
  const commitDiff = state.diff?.scope === 'commit' && state.diff.checkout === commitCheckout ? state.diff : null;
  return <div className="flex flex-col gap-3 text-sm">
    <div className="grid gap-3 md:grid-cols-2">
      <SideSummary label="A" side={result.a} newer={newer === 'a'} />
      <SideSummary label="B" side={result.b} newer={newer === 'b'} />
    </div>
    <div className="grid gap-3 md:grid-cols-2">
      <CommitList label={`Chỉ có ở A (${result.onlyA.length})`} commits={result.onlyA} branch={result.branchA} onOpen={openCommit} />
      <CommitList label={`Chỉ có ở B (${result.onlyB.length})`} commits={result.onlyB} branch={result.branchB} onOpen={openCommit} />
    </div>
    <div className="grid gap-3 md:grid-cols-2">
      <DirtyFiles label={`Chưa commit · ${result.branchA}`} side={result.a} />
      <DirtyFiles label={`Chưa commit · ${result.branchB}`} side={result.b} />
    </div>
    <details className="rounded border border-hairline p-2"><summary className="cursor-pointer text-sm font-medium">File cả hai cùng sửa ({files.both.length})</summary>
      <ul className="mt-2 flex flex-col gap-1">{files.both.map((file) => <li key={file} className="font-mono text-xs">{result.files.find((item) => item.path === file)?.conflict ? '⚔ đụng' : '≈ tự gộp'} · {file}</li>)}</ul>
      <p className="mt-2 text-xs text-text-muted">Chỉ A: {files.onlyA.join(', ') || 'không có'} · Chỉ B: {files.onlyB.join(', ') || 'không có'}</p>
    </details>
    <section className="rounded border border-hairline p-3" aria-label="Gộp thử">
      <h3 className={`font-semibold ${result.mergeClean ? 'text-status-success' : 'text-status-error'}`}>{result.mergeClean ? 'Gộp thử sạch' : `Gộp thử: đụng ${result.conflicts.length} tệp`}</h3>
      {!result.mergeClean && result.conflicts.map((conflict) => <div key={conflict.file} className="mt-2 border-t border-hairline pt-2">
        <button type="button" className="font-mono text-sm text-text hover:text-accent" onClick={() => setExpandedConflict(expandedConflict === conflict.file ? null : conflict.file)}>{conflict.file} {expandedConflict === conflict.file ? '⌄' : '›'}</button>
        {expandedConflict === conflict.file && conflict.hunks.map((hunk, index) => <div key={`${hunk.line}-${index}`} className="mt-2"><p className="text-xs text-text-muted">Dòng {hunk.line}</p><div className="grid gap-2 md:grid-cols-2"><pre className="overflow-auto rounded bg-raised p-2 text-xs text-status-success">A · {hunk.ours}</pre><pre className="overflow-auto rounded bg-raised p-2 text-xs text-status-error">B · {hunk.theirs}</pre></div></div>)}
      </div>)}
      <p className="mt-3 text-xs text-text-secondary">Gộp trước {mergeFirst}, sau đó rebase {rebaseBranch}, giữ ý hai bên, chạy test rồi merge-lane.</p>
      {result.conflicts.length > 0 && (sessions.length > 0 ? sessions.map((session) => <CompanyButton key={session.sessionId} size="sm" className="mt-2" onClick={() => { if (session.sessionId) ledgerStore.sendMessage(session.sessionId, message); }}>Giao agent · {session.title || session.sessionId}</CompanyButton>) : <CompanyButton size="sm" className="mt-2" onClick={() => void copy()}>{copied ? 'Đã chép lệnh' : 'Chép lệnh'}</CompanyButton>)}
    </section>
    <section className="rounded border border-hairline p-3" aria-label="Diff A và B"><div className="flex items-center justify-between"><h3 className="font-semibold">Diff A ⇄ B</h3><CompanyButton size="sm" onClick={onDiff}>Xem diff</CompanyButton></div></section>
    {commitCheckout !== null && <DiffResult diff={commitDiff} />}
  </div>;
}

function SideSummary({ label, side, newer }: { label: string; side: ProjectBranchCompareMessage['a']; newer: boolean }) {
  const now = useNow();
  const age = side.lastCommitAt === null ? null : relativeTimeVi(side.lastCommitAt, now);
  return <section className="rounded border border-hairline bg-panel p-3"><h3 className="font-semibold">{label} · {side.branch} {newer && <span className="text-warning">★ mới hơn</span>}</h3><p className="mt-1 text-xs text-text-secondary">{age ?? 'Chưa có commit'} · <code>{side.head.slice(0, 8)}</code></p>{side.lastCommitSubject && <p className="mt-1 text-sm">{side.lastCommitSubject}</p>}</section>;
}

function CommitList({ label, commits, branch, onOpen }: { label: string; commits: ProjectBranchCompareMessage['onlyA']; branch: string; onOpen: (sha: string, branch: string) => void }) {
  const now = useNow();
  return <section className="rounded border border-hairline bg-panel p-3"><h3 className="font-semibold">{label}</h3>{commits.length === 0 ? <p className="mt-1 text-xs text-text-muted">Không có commit riêng.</p> : <ul className="mt-2 flex flex-col gap-1">{commits.map((commit) => <li key={commit.sha}><button type="button" className="text-left hover:text-accent" onClick={() => onOpen(commit.sha, branch)}><code className="text-xs text-text-muted">{commit.sha.slice(0, 8)}</code> · {commit.subject}<span className="block text-xs text-text-muted">{commit.author} · {relativeTimeVi(commit.at, now) ?? commit.at}</span></button></li>)}</ul>}</section>;
}

function DirtyFiles({ label, side }: { label: string; side: ProjectBranchCompareMessage['a'] }) {
  return <section className="rounded border border-hairline bg-panel p-3"><h3 className="font-semibold">{label}</h3>{side.checkout === undefined ? <p className="mt-1 text-xs text-text-muted">Không có worktree.</p> : side.dirtyFiles.length === 0 ? <p className="mt-1 text-xs text-text-muted">Sạch.</p> : <ul className="mt-1 flex flex-col gap-1">{side.dirtyFiles.map((file) => <li key={file.path} className="font-mono text-xs">{file.status} · {file.path}</li>)}</ul>}</section>;
}

function DiffResult({ diff }: { diff: ProjectDiffMessage | null }) {
  if (diff === null) return <p role="status" className="text-xs text-text-muted">Đang tải diff…</p>;
  return <section className="flex flex-col gap-2" aria-label="Diff nhánh A với B">{diff.files.length === 0 ? <p className="text-sm text-text-muted">Không có khác biệt.</p> : diff.files.map((file) => {
    const lines = numberDiffLines(file.hunks.map((hunk) => `${hunk.header}\n${hunk.content}`).join('\n'));
    return <details key={file.path} className="rounded border border-hairline bg-panel p-2"><summary className="cursor-pointer font-mono text-xs">{file.path}</summary><div className="mt-2 overflow-auto bg-bg-dark font-mono text-xs leading-5">{lines.map((line, index) => <ProjectDiffLine key={`${index}-${line.oldLine}-${line.newLine}`} line={line} filePath={file.path} />)}</div></details>;
  })}</section>;
}
