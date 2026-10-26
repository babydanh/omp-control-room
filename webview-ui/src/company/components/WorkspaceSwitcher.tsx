/**
 * WorkspaceSwitcher: what the board shows. The menu lists the folders the server knows,
 * with a first row that stands for all of them together; a folder row opens that folder,
 * and right-click or its pencil names it. The menu's last row opens Windows' folder dialog,
 * and with no folder open the trigger opens it directly. Switching is a server command:
 * while it is in flight the trigger says so, and a refusal shows as a notice under it.
 * A folder whose directory is gone shows once, with a way to take it off the list.
 */

import { useEffect, useRef, useState } from 'react';

import type { CompanyWorkspaceEntry } from '../../../../core/src/messages.js';
import type { CompanyClient } from '../companyClient.js';
import type { CompanyViewState } from '../companyState.js';
import { openPickedFolder } from '../folderPick.js';
import { activeWorkspace, folderLabel, workspaceActivity } from '../workspaces.js';
import { FloatingNotice } from './FloatingNotice.js';
import { FolderNameDialog } from './FolderNameDialog.js';
import { Icon } from './Icon.js';

export interface WorkspaceSwitcherProps {
  client: CompanyClient;
  state: CompanyViewState;
}

/** The class every control in the switcher shares: a small ghost button, no edge. */
const CONTROL_CLASS =
  'touch-target company-btn-ghost cursor-pointer rounded-(--company-radius-sm) px-2.5 py-1 text-2xs disabled:cursor-default disabled:opacity-50';
/** One row of the folder menu. A row reads as pressed when it is the folder the board shows. */
const MENU_ROW_CLASS =
  'touch-target flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-(--company-radius-sm) px-2 py-1.5 text-left text-text hover:bg-hover aria-pressed:bg-selected disabled:cursor-default disabled:opacity-50';

/** The folder whose display name is being edited, and the name it has now. */
interface NamingTarget {
  path: string;
  currentName: string | null;
}

export function WorkspaceSwitcher({ client, state }: WorkspaceSwitcherProps) {
  /** A refusal of the request itself, shown until it is closed or the next attempt. */
  const [refusal, setRefusal] = useState<string | null>(null);
  /** requestId of the last switch sent, so its verdict can be shown if it failed. */
  const [lastOpen, setLastOpen] = useState<string | null>(null);
  /** The request whose verdict the reader closed; its notice is not shown again. */
  const [closedRequest, setClosedRequest] = useState<string | null>(null);
  /** Whether the folder menu is open. */
  const [menuOpen, setMenuOpen] = useState(false);
  /** Whether Windows' folder dialog is open for the switcher, so a second press cannot stack one. */
  const [picking, setPicking] = useState(false);
  /** The folder being named, or null when no naming dialog is open. */
  const [naming, setNaming] = useState<NamingTarget | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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
  const verdict =
    lastOpen === null || lastOpen === closedRequest ? undefined : state.commandResults[lastOpen];
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
  const noFolders = workspaces !== null && workspaces.length === 0;
  let triggerText = 'Chưa có thư mục';
  if (allMode) {
    triggerText = `Tất cả thư mục · ${workspaceActivity(everything)}`;
  } else if (active !== null) {
    const activity = active.missing === true ? 'Thư mục không còn' : workspaceActivity(active);
    triggerText = `${folderLabel(active)} · ${activity}`;
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

  function forgetFolder(entry: CompanyWorkspaceEntry): void {
    setMenuOpen(false);
    setRefusal(null);
    const handle = client.forgetFolder(entry.path);
    setLastOpen(handle.requestId);
    if (!handle.ok) setRefusal(handle.message ?? 'Không gửi được yêu cầu gỡ thư mục.');
  }

  async function openBrowser(): Promise<void> {
    setMenuOpen(false);
    setRefusal(null);
    setPicking(true);
    try {
      const opened = await openPickedFolder(client);
      if (typeof opened === 'object') setRefusal(opened.notice);
    } finally {
      setPicking(false);
    }
  }

  function closeNotice(): void {
    setRefusal(null);
    setClosedRequest(lastOpen);
  }

  return (
    <div className="relative flex min-w-0 max-w-full items-center" data-testid="board-workspace">
      {workspaces === null ? (
        <span
          className="min-w-0 max-w-[260px] truncate text-2xs text-text"
          title={state.settings?.workspacePath ?? undefined}
        >
          {state.settings?.workspacePath ?? 'đang chờ máy chủ…'}
        </span>
      ) : noFolders ? (
        <button
          type="button"
          disabled={opening || picking}
          onClick={() => void openBrowser()}
          data-testid="folder-browser-open"
          className={`${CONTROL_CLASS} inline-flex items-center gap-1.5`}
        >
          <Icon name="folder" className="shrink-0" />
          <span>Mở thư mục…</span>
        </button>
      ) : (
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
            <span className="min-w-0 flex-1 truncate">
              {opening ? 'Đang mở thư mục…' : triggerText}
            </span>
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
              {(workspaces ?? []).map((entry) => (
                <li key={entry.path} className="flex items-center">
                  <button
                    type="button"
                    aria-pressed={!allMode && entry.active}
                    data-testid="folder-option"
                    title={entry.path}
                    disabled={opening || entry.missing === true}
                    onClick={() => chooseFolder(entry)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      openNaming(entry);
                    }}
                    className={MENU_ROW_CLASS}
                  >
                    <span className="min-w-0 flex-1 truncate">{folderLabel(entry)}</span>
                    <span className="shrink-0 text-text-muted">
                      {entry.missing === true ? 'Thư mục không còn' : workspaceActivity(entry)}
                    </span>
                  </button>
                  {entry.missing === true ? (
                    <button
                      type="button"
                      disabled={opening}
                      onClick={() => forgetFolder(entry)}
                      className={`${CONTROL_CLASS} shrink-0`}
                    >
                      Gỡ khỏi danh sách
                    </button>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Đặt tên cho ${folderLabel(entry)}`}
                      title="Đặt tên thư mục"
                      onClick={() => openNaming(entry)}
                      className="company-icon-btn touch-target shrink-0 px-2 text-2xs"
                    >
                      <Icon name="pencil" />
                    </button>
                  )}
                </li>
              ))}
              <li aria-hidden="true" className="my-1 border-t border-hairline" />
              <li>
                <button
                  type="button"
                  data-testid="folder-browser-open"
                  disabled={opening || picking}
                  onClick={() => void openBrowser()}
                  className={MENU_ROW_CLASS}
                >
                  <Icon name="folder" className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate">Mở thư mục…</span>
                </button>
              </li>
            </ul>
          )}
        </div>
      )}
      {message !== null && (
        <FloatingNotice align="left" testId="board-workspace-notice" onClose={closeNotice}>
          {message}
        </FloatingNotice>
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
