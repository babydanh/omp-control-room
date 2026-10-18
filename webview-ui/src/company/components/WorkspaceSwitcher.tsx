/**
 * WorkspaceSwitcher: the folder the board points at, the other folders the server
 * knows, and a field to open a folder by path. Switching is a server command: while it
 * is in flight the controls wait, and a refusal stays visible beside them.
 */

import { type FormEvent, useState } from 'react';

import type { CompanyClient } from '../companyClient.js';
import type { CompanyViewState } from '../companyState.js';
import {
  activeWorkspace,
  planWorkspaceOpen,
  workspaceActivity,
  workspaceName,
} from '../workspaces.js';

export interface WorkspaceSwitcherProps {
  client: CompanyClient;
  state: CompanyViewState;
}

/** The class every control in the switcher shares: a small outlined button. */
const CONTROL_CLASS =
  'cursor-pointer rounded-[5px] border border-border px-2.5 py-1 text-2xs text-text-muted hover:border-accent hover:text-text disabled:cursor-default disabled:opacity-50';

export function WorkspaceSwitcher({ client, state }: WorkspaceSwitcherProps) {
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  /** A refusal of the request itself, shown until the next attempt. */
  const [refusal, setRefusal] = useState<string | null>(null);
  /** requestId of the last switch sent, so its verdict can be shown if it failed. */
  const [lastOpen, setLastOpen] = useState<string | null>(null);

  const workspaces = state.workspaces;
  const active = activeWorkspace(workspaces);
  const opening = state.pendingWorkspaceOpen !== null;
  const verdict = lastOpen === null ? undefined : state.commandResults[lastOpen];
  const message =
    refusal ?? (verdict !== undefined && !verdict.ok ? (verdict.message ?? null) : null);

  function openFolder(input: string): void {
    const plan = planWorkspaceOpen(workspaces, input);
    if (plan.kind === 'refuse') {
      setRefusal(plan.message);
      return;
    }
    setRefusal(null);
    if (plan.kind === 'stay') {
      setTyping(false);
      return;
    }
    const handle = client.openWorkspace(plan.path);
    setLastOpen(handle.requestId);
    if (!handle.ok) {
      setRefusal(handle.message ?? 'Không gửi được yêu cầu mở thư mục.');
      return;
    }
    setDraft('');
    setTyping(false);
  }

  function submitDraft(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    openFolder(draft);
  }

  return (
    <div
      className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5"
      data-testid="board-workspace"
    >
      {workspaces !== null && workspaces.length > 0 ? (
        <select
          aria-label="Thư mục đang làm việc"
          title={active?.path ?? undefined}
          value={active?.path ?? ''}
          disabled={opening}
          onChange={(event) => openFolder(event.target.value)}
          className="min-w-0 max-w-[min(260px,100%)] rounded-[5px] border border-border bg-bg px-2 py-1 text-2xs text-text disabled:opacity-50"
        >
          {workspaces.map((entry) => (
            <option key={entry.path} value={entry.path} title={entry.path}>
              {workspaceName(entry.path)} · {workspaceActivity(entry)}
            </option>
          ))}
        </select>
      ) : (
        <span
          className="min-w-0 max-w-[260px] truncate text-2xs text-text"
          title={state.settings?.workspacePath ?? undefined}
        >
          {state.settings?.workspacePath ?? 'đang chờ máy chủ…'}
        </span>
      )}
      {typing ? (
        <form onSubmit={submitDraft} className="flex items-center gap-1.5">
          <input
            type="text"
            aria-label="Đường dẫn thư mục"
            placeholder="Dán đường dẫn thư mục"
            value={draft}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setTyping(false);
            }}
            className="w-[260px] rounded-[5px] border border-border bg-bg px-2 py-1 text-2xs text-text"
          />
          <button type="submit" disabled={opening} className={CONTROL_CLASS}>
            Mở
          </button>
          <button type="button" onClick={() => setTyping(false)} className={CONTROL_CLASS}>
            Huỷ
          </button>
        </form>
      ) : (
        <button
          type="button"
          disabled={opening}
          onClick={() => {
            setRefusal(null);
            setTyping(true);
          }}
          className={CONTROL_CLASS}
        >
          Mở thư mục…
        </button>
      )}
      {opening && <span className="text-2xs text-text-muted">Đang mở thư mục…</span>}
      {message !== null && (
        <span role="alert" className="break-all text-2xs text-warning">
          {message}
        </span>
      )}
    </div>
  );
}
