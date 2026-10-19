/**
 * WorkspaceSwitcher: what the board shows. The menu lists the folders the server knows,
 * with a first row that stands for all of them together; a folder row opens that folder,
 * and right-click or its pencil names it. Beside the menu: a button that browses the
 * server's folders, and a field to open a folder by typed path. Switching is a server
 * command: while it is in flight the controls wait, and a refusal stays visible beside them.
 */

import { type FormEvent, useEffect, useRef, useState } from 'react';

import type { CompanyWorkspaceEntry } from '../../../../core/src/messages.js';
import type { CompanyClient } from '../companyClient.js';
import type { CompanyViewState } from '../companyState.js';
import {
  activeWorkspace,
  folderLabel,
  planWorkspaceOpen,
  workspaceActivity,
} from '../workspaces.js';
import { FolderBrowserDialog } from './FolderBrowserDialog.js';
import { FolderNameDialog } from './FolderNameDialog.js';
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
/** One row of the folder menu. A row reads as pressed when it is the folder the board shows. */
const MENU_ROW_CLASS =
  'touch-target flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-(--company-radius-sm) px-2 py-1.5 text-left text-text hover:bg-hover aria-pressed:bg-selected disabled:cursor-default disabled:opacity-50';

/** The folder whose display name is being edited, and the name it has now. */
interface NamingTarget {
  path: string;
  currentName: string | null;
}

export function WorkspaceSwitcher({ client, state, openRequest = 0 }: WorkspaceSwitcherProps) {
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  /** A refusal of the request itself, shown until the next attempt. */
  const [refusal, setRefusal] = useState<string | null>(null);
  /** requestId of the last switch sent, so its verdict can be shown if it failed. */
  const [lastOpen, setLastOpen] = useState<string | null>(null);
  /** The last palette request this switcher answered; a new value opens the path field. */
  const [seenRequest, setSeenRequest] = useState(openRequest);
  /** Whether the folder menu is open. */
  const [menuOpen, setMenuOpen] = useState(false);
  /** Whether the folder browser dialog is open. */
  const [browsing, setBrowsing] = useState(false);
  /** The folder being named, or null when no naming dialog is open. */
  const [naming, setNaming] = useState<NamingTarget | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  if (openRequest !== seenRequest) {
    setSeenRequest(openRequest);
    setRefusal(null);
    setTyping(true);
  }

  // The menu closes on a press outside it, or on Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const workspaces = state.workspaces;
  const active = activeWorkspace(workspaces);
  const allMode = state.viewMode === 'all';
  const opening = state.pendingWorkspaceOpen !== null;
  const verdict = lastOpen === null ? undefined : state.commandResults[lastOpen];
  const message =
    refusal ?? (verdict !== undefined && !verdict.ok ? (verdict.message ?? null) : null);
  /** Every folder's counts added together, in the shape the activity text reads. */
  const everything: CompanyWorkspaceEntry = (workspaces ?? []).reduce<CompanyWorkspaceEntry>(
    (sum, entry) => ({
      ...sum,
      working: sum.working + entry.working,
      waiting: sum.waiting + entry.waiting,
    }),
    { path: '', active: false, open: true, working: 0, waiting: 0 },
  );
  let triggerText = 'Chưa có thư mục';
  if (allMode) {
    triggerText = `Tất cả thư mục · ${workspaceActivity(everything)}`;
  } else if (active !== null) {
    triggerText = `${folderLabel(active)} · ${workspaceActivity(active)}`;
  }

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

  function chooseAll(): void {
    setMenuOpen(false);
    client.setViewMode('all');
  }

  function chooseFolder(entry: CompanyWorkspaceEntry): void {
    setMenuOpen(false);
    // The folder already shown needs no command; in all mode it switches to folder mode.
    if (!allMode && entry.active) return;
    setRefusal(null);
    const handle = client.openWorkspace(entry.path);
    setLastOpen(handle.requestId);
    if (!handle.ok) setRefusal(handle.message ?? 'Không gửi được yêu cầu mở thư mục.');
  }

  function openNaming(entry: CompanyWorkspaceEntry): void {
    setMenuOpen(false);
    setNaming({ path: entry.path, currentName: entry.name ?? null });
  }

  return (
    <div
      className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5"
      data-testid="board-workspace"
    >
      {workspaces !== null && workspaces.length > 0 ? (
        <div ref={menuRef} className="relative min-w-0 max-w-[min(300px,100%)]">
          <button
            type="button"
            aria-label="Thư mục đang làm việc"
            aria-expanded={menuOpen}
            title={allMode ? undefined : (active?.path ?? undefined)}
            disabled={opening}
            onClick={() => setMenuOpen((open) => !open)}
            data-testid="folder-menu-trigger"
            className="flex w-full min-w-0 cursor-pointer items-center gap-1 rounded-(--company-radius-sm) bg-transparent px-2 py-1 text-left text-2xs text-text hover:bg-hover disabled:cursor-default disabled:opacity-50"
          >
            <span className="min-w-0 flex-1 truncate">{triggerText}</span>
            <Icon name="chevron-down" className="shrink-0" />
          </button>
          {menuOpen && (
            <ul
              aria-label="Thư mục"
              data-testid="folder-menu"
              className="absolute left-0 top-full z-40 mt-1 max-h-[60vh] w-72 max-w-[calc(100vw-1rem)] overflow-auto rounded-(--company-radius-md) bg-raised p-1 text-2xs"
            >
              <li>
                <button
                  type="button"
                  aria-pressed={allMode}
                  data-testid="folder-all"
                  disabled={opening}
                  onClick={chooseAll}
                  className={MENU_ROW_CLASS}
                >
                  <span className="min-w-0 flex-1 truncate">Tất cả thư mục</span>
                  <span className="shrink-0 text-text-muted">{workspaceActivity(everything)}</span>
                </button>
              </li>
              {workspaces.map((entry) => (
                <li key={entry.path} className="flex items-center">
                  <button
                    type="button"
                    aria-pressed={!allMode && entry.active}
                    data-testid="folder-option"
                    title={entry.path}
                    disabled={opening}
                    onClick={() => chooseFolder(entry)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      openNaming(entry);
                    }}
                    className={MENU_ROW_CLASS}
                  >
                    <span className="min-w-0 flex-1 truncate">{folderLabel(entry)}</span>
                    <span className="shrink-0 text-text-muted">{workspaceActivity(entry)}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Đặt tên cho ${folderLabel(entry)}`}
                    title="Đặt tên thư mục"
                    onClick={() => openNaming(entry)}
                    className="company-icon-btn touch-target shrink-0 px-2 text-2xs"
                  >
                    <Icon name="pencil" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
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
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={opening}
            aria-label="Duyệt thư mục"
            title="Duyệt thư mục"
            data-testid="folder-browser-open"
            onClick={() => {
              setMenuOpen(false);
              setBrowsing(true);
            }}
            className="company-icon-btn touch-target shrink-0 px-2 text-sm"
          >
            <Icon name="folder" />
          </button>
          <button
            type="button"
            disabled={opening}
            aria-label="Nhập đường dẫn thư mục"
            title="Nhập đường dẫn thư mục"
            onClick={() => {
              setRefusal(null);
              setTyping(true);
            }}
            className={CONTROL_CLASS}
          >
            Nhập đường dẫn
          </button>
        </div>
      )}
      {opening && <span className="text-2xs text-text-muted">Đang mở thư mục…</span>}
      {message !== null && (
        <span role="alert" className="break-all text-2xs text-warning">
          {message}
        </span>
      )}
      {browsing && (
        <FolderBrowserDialog
          client={client}
          state={state}
          purpose="open"
          onClose={() => setBrowsing(false)}
        />
      )}
      {naming !== null && (
        <FolderNameDialog
          client={client}
          path={naming.path}
          currentName={naming.currentName}
          onClose={() => setNaming(null)}
        />
      )}
    </div>
  );
}
