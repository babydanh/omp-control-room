import './NewSessionDialog.css';

import { type FormEvent, useEffect, useMemo, useState } from 'react';

import type { ProjectTreeNode } from '../../../../core/src/messages.js';
import { type ProjectStore, useProjectState } from './projectStore.js';

export interface NewSessionDialogProps { store: ProjectStore; nodeId: string; onClose: () => void; initialEngine?: SessionEngine; }

type SessionEngine = 'omp' | 'claude' | 'agy';

export function NewSessionDialog({ store, nodeId, onClose, initialEngine }: NewSessionDialogProps) {
  const state = useProjectState(store);
  const target = state.nodes.find((node) => node.id === nodeId);
  const candidateRepos = useMemo(() => getCandidateRepos(target, state.nodes), [target, state.nodes]);
  const [repoId, setRepoId] = useState(candidateRepos.length === 1 ? candidateRepos[0]?.id ?? '' : '');
  const [engine, setEngine] = useState<SessionEngine>(initialEngine ?? 'omp');
  const [worktree, setWorktree] = useState<'separate' | 'shared'>('separate');
  const [taskName, setTaskName] = useState('');
  const [initialPrompt, setInitialPrompt] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);

  useEffect(() => {
    store.requestSettings(nodeId);
  }, [nodeId, store]);

  useEffect(() => {
    if (initialEngine !== undefined) {
      setEngine(initialEngine);
      return;
    }
    const defaultEngine = state.settings?.nodeId === nodeId ? state.settings.values.engineLeader : undefined;
    if (defaultEngine === 'omp' || defaultEngine === 'claude' || defaultEngine === 'agy') setEngine(defaultEngine);
  }, [initialEngine, nodeId, state.settings]);

  useEffect(() => {
    if (candidateRepos.length === 1) setRepoId(candidateRepos[0]?.id ?? '');
    else if (!candidateRepos.some((repo) => repo.id === repoId)) setRepoId('');
  }, [candidateRepos, repoId]);

  const selectedRepo = candidateRepos.find((repo) => repo.id === repoId);
  const worktreePath = selectedRepo?.path === undefined || taskName.trim() === ''
    ? ''
    : engine === 'omp'
      ? `${selectedRepo.path}.worktrees/${taskSlug(taskName)}`
      : `${selectedRepo.path}/.worktrees/squad-<mã việc>`;
  const result = requestId === null ? undefined : state.results[requestId];
  const pending = requestId !== null && state.pending[requestId] !== undefined;
  const reason = result?.type === 'projectSessionStartResult' && !result.ok
    ? result.reason
    : requestId === null ? undefined : state.errors.sessionStart;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectedRepo === undefined) return;
    const nextRequestId = store.startSession({
      nodeId: target?.kind === 'checkout' ? target.id : selectedRepo.id,
      engine,
      worktree,
      taskName: taskName.trim(),
      initialPrompt: initialPrompt.trim(),
    });
    setRequestId(nextRequestId);
  }

  return (
    <div className="project-session-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="project-session-dialog" role="dialog" aria-modal="true" aria-labelledby="project-session-title" onSubmit={submit}>
        <header className="project-session-dialog__header">
          <h2 id="project-session-title">Phiên mới</h2>
          <button type="button" aria-label="Đóng" onClick={onClose}>×</button>
        </header>
        <label>
          Engine
          <select value={engine} onChange={(event) => setEngine(event.target.value as SessionEngine)}>
            <option value="omp">OMP — phiên board</option>
            <option value="claude">Claude Code</option>
            <option value="agy">Antigravity</option>
          </select>
        </label>
        {candidateRepos.length > 1 && (
          <label>
            Repo
            <select value={repoId} onChange={(event) => setRepoId(event.target.value)} required>
              <option value="">Chọn repo</option>
              {candidateRepos.map((repo) => <option key={repo.id} value={repo.id}>{repo.name}</option>)}
            </select>
          </label>
        )}
        <fieldset>
          <legend>Thư mục làm việc</legend>
          <label><input type="radio" name="project-session-worktree" checked={worktree === 'separate'} onChange={() => setWorktree('separate')} /> Worktree riêng (mặc định)</label>
          <label><input type="radio" name="project-session-worktree" checked={worktree === 'shared'} onChange={() => setWorktree('shared')} /> Dùng chung thư mục này</label>
        </fieldset>
        <label>
          Tên việc
          <input value={taskName} onChange={(event) => setTaskName(event.target.value)} required maxLength={120} />
        </label>
        {worktree === 'separate' && <p className="project-session-dialog__path">Worktree sẽ tạo: <code>{worktreePath || 'Nhập tên việc để xem đường dẫn'}</code></p>}
        <label>
          Prompt đầu tiên
          <textarea value={initialPrompt} onChange={(event) => setInitialPrompt(event.target.value)} required rows={5} />
        </label>
        {reason && <p role="alert" className="project-session-dialog__error">{reason}</p>}
        {result?.type === 'projectSessionStartResult' && result.ok && <p role="status">Đã mở phiên tại <code>{result.checkout}</code></p>}
        <footer>
          <button type="button" onClick={onClose}>Huỷ</button>
          <button type="submit" disabled={pending || selectedRepo === undefined || taskName.trim() === '' || initialPrompt.trim() === ''}>
            {pending ? 'Đang mở…' : 'Mở phiên'}
          </button>
        </footer>
      </form>
    </div>
  );
}

function getCandidateRepos(target: ProjectTreeNode | undefined, nodes: readonly ProjectTreeNode[]): ProjectTreeNode[] {
  if (target === undefined) return [];
  if (target.kind === 'repository') return [target];
  if (target.kind === 'checkout') {
    const repo = nodes.find((node) => node.id === target.parentId && node.kind === 'repository');
    return repo === undefined ? [] : [repo];
  }
  if (target.kind !== 'folder') return [];
  return nodes.filter((node) => node.kind === 'repository' && node.parentId === target.id);
}

function taskSlug(name: string): string {
  const slug = name.normalize('NFKD').replace(/[đĐ]/g, 'd').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
  return slug || 'viec-moi';
}
