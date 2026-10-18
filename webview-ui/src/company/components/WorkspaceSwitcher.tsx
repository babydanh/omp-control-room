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
import { Icon } from './Icon.js';

export interface WorkspaceSwitcherProps {
  client: CompanyClient;
  state: CompanyViewState;
  /** Bumped by the command palette to open the path field; a new value opens it once. */
  openRequest?: number;
}

/** The class every control in the switcher shares: a small ghost button, no edge. */
const CONTROL_CLASS =
  'touch-target company-btn-ghost cursor-pointer rounded-(--company-radius-sm) px-2.5 py-1 text-2xs disabled:cursor-default disabled:opacity-50';
/** The one affirmative action in the switcher: the filled accent button. */
const ACTION_CLASS =
  'touch-target company-btn-accent cursor-pointer rounded-(--company-radius-sm) px-2.5 py-1 text-2xs disabled:cursor-default disabled:opacity-50';

export function WorkspaceSwitcher({ client, state, openRequest = 0 }: WorkspaceSwitcherProps) {
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  /** A refusal of the request itself, shown until the next attempt. */
  const [refusal, setRefusal] = useState<string | null>(null);
  /** requestId of the last switch sent, so its verdict can be shown if it failed. */
  const [lastOpen, setLastOpen] = useState<string | null>(null);
  /** The last palette request this switcher answered; a new value opens the path field. */
  const [seenRequest, setSeenRequest] = useState(openRequest);
  if (openRequest !== seenRequest) {
    setSeenRequest(openRequest);
    setRefusal(null);
    setTyping(true);
  }

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
          className="min-w-0 max-w-[min(260px,100%)] cursor-pointer rounded-(--company-radius-sm) bg-transparent px-2 py-1 text-2xs text-text hover:bg-hover disabled:opacity-50"
        >
          {workspaces.map((entry) => (
            <option
              key={entry.path}
              value={entry.path}
              title={entry.path}
              className="bg-raised text-text"
            >
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
            className="w-[260px] rounded-(--company-radius-sm) bg-raised px-2 py-1 text-2xs text-text"
          />
          <button type="submit" disabled={opening} className={ACTION_CLASS}>
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
          aria-label="Mở thư mục…"
          title="Mở thư mục…"
          onClick={() => {
            setRefusal(null);
            setTyping(true);
          }}
          className="company-icon-btn touch-target shrink-0 px-2 text-sm"
        >
          <Icon name="folder" />
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
