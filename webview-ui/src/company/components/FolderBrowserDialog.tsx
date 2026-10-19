/**
 * FolderBrowserDialog: a modal that browses the folders on the server's machine and
 * chooses one. The start view lists the recent folders, then the drives or roots. A
 * folder the user goes into lists its subfolders. Choosing a folder may rename it, points
 * the board at it, and for a new session starts an omp chat there.
 *
 * Every path shown is one the server listed. The dialog never compares or stores a typed
 * path, so a folder reached through a junction is still one folder.
 */

import {
  type FormEvent,
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import type { CompanyFolderBrowseMessage } from '../../../../core/src/messages.js';
import { failureNotice } from '../commandResults.js';
import type { CompanyClient, CompanyCommandHandle } from '../companyClient.js';
import type { CompanyViewState } from '../companyState.js';
import { startNewChat } from '../composerRouting.js';
import {
  breadcrumbs,
  defaultFolderName,
  filterFolderEntries,
  folderNameError,
} from '../folderBrowser.js';
import { FOLDER_LIST_LOADING_MESSAGE, folderListLoading } from '../folderView.js';
import { folderLabel } from '../workspaces.js';
import { CompanyButton } from './CompanyButton.js';
import { Icon } from './Icon.js';

export interface FolderBrowserDialogProps {
  client: CompanyClient;
  state: CompanyViewState;
  /** `open` points the board at the chosen folder; `new-session` also starts an omp chat there. */
  purpose: 'open' | 'new-session';
  onClose: () => void;
}

type RootKind = CompanyFolderBrowseMessage['roots'][number]['kind'];

const ROOT_KIND_LABELS: Record<RootKind, string> = {
  drive: 'Ổ đĩa',
  root: 'Gốc',
  home: 'Thư mục cá nhân',
};

const BROWSE_FALLBACK = 'Chưa mở được thư mục.';
const CREATE_FALLBACK = 'Chưa tạo được thư mục.';
const RENAME_FALLBACK = 'Chưa đổi được tên thư mục.';
const OPEN_FALLBACK = 'Chưa mở được thư mục này trên bảng.';
const NEW_CHAT_FALLBACK = 'Chưa mở được phiên mới.';
const CREATE_HINT = 'Thư mục con sẽ được tạo trong thư mục đang mở.';
const CLEAR_NAME_HINT = 'Để trống để bỏ tên hiển thị và dùng tên thư mục.';
const TRUNCATED_NOTE = 'Danh sách bị cắt bớt. Gõ tên để tìm thư mục cần chọn.';
const NO_SUBFOLDERS = 'Thư mục này không có thư mục con.';
const NO_MATCH = 'Không có thư mục nào khớp.';

const ROW_CLASS =
  'touch-target flex w-full min-w-0 items-center gap-2 rounded-(--company-radius-sm) px-2 py-1 text-left text-text hover:bg-hover disabled:cursor-default disabled:text-text-muted';
const INPUT_CLASS =
  'touch-target min-w-0 rounded-(--company-radius-sm) bg-well px-2 py-1 text-xs text-text placeholder:text-text-muted disabled:text-text-muted';

/** Waits for a command's verdict: its refusal's notice, or null when it went through. */
async function refusalOf(
  client: CompanyClient,
  handle: CompanyCommandHandle,
  fallback: string,
): Promise<string | null> {
  return failureNotice(await client.waitForCommand(handle), fallback);
}

export function FolderBrowserDialog({ client, state, purpose, onClose }: FolderBrowserDialogProps) {
  const loading = folderListLoading(state);
  // A reply counts only when it answers the latest browse; an older listing is not shown.
  const listing =
    state.folderBrowse !== null && state.folderBrowse.requestId === state.folderBrowseRequest
      ? state.folderBrowse
      : null;
  const latestBrowse =
    state.folderBrowseRequest === null
      ? undefined
      : state.commandResults[state.folderBrowseRequest];

  const [notice, setNotice] = useState<string | null>(null);
  const shownNotice = notice ?? failureNotice(latestBrowse, BROWSE_FALLBACK);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [chosenName, setChosenName] = useState<{ path: string; value: string } | null>(null);
  const [opener] = useState<Element | null>(() => document.activeElement);
  const dialogRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);

  const controlsDisabled = loading || busy;
  // The folder the footer chooses: the listed folder, or null in the start view.
  const folderPath = listing?.path ?? null;
  const storedName =
    folderPath === null
      ? null
      : (state.workspaces?.find((entry) => entry.path === folderPath)?.name ?? null);
  const prefill = folderPath === null ? '' : (storedName ?? defaultFolderName(folderPath));
  const nameValue =
    folderPath !== null && chosenName?.path === folderPath ? chosenName.value : prefill;
  const nameProblem = nameValue.trim() === '' ? null : folderNameError(nameValue.trim());
  const nameChanged = nameValue.trim() !== prefill.trim();
  const createProblem = newName.trim() === '' ? null : folderNameError(newName.trim());
  const canCreate = newName.trim() !== '' && createProblem === null;
  const choosable = folderPath !== null && !controlsDisabled && nameProblem === null;
  const waiting = loading || (listing === null && shownNotice === null);
  const title = purpose === 'new-session' ? 'Chọn thư mục cho phiên mới' : 'Chọn thư mục';

  useEffect(() => {
    dialogRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    return () => {
      if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected) {
        opener.focus();
      }
    };
  }, [opener]);

  // The server refuses a browse until it has the folder list, so the start view waits for it.
  useEffect(() => {
    if (loading || started.current) return;
    started.current = true;
    setNotice(failureNotice(client.browseFolders(), BROWSE_FALLBACK));
  }, [client, loading]);

  function navigate(path?: string): void {
    setFilter('');
    setCreating(false);
    setNotice(failureNotice(client.browseFolders(path), BROWSE_FALLBACK));
  }

  async function createSubfolder(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (folderPath === null || !canCreate || controlsDisabled) return;
    const parent = folderPath;
    setBusy(true);
    setNotice(null);
    const failure = await refusalOf(
      client,
      client.createFolder(parent, newName.trim()),
      CREATE_FALLBACK,
    );
    setBusy(false);
    if (failure !== null) {
      setNotice(failure);
      return;
    }
    setNewName('');
    navigate(parent);
  }

  async function choose(): Promise<void> {
    if (folderPath === null || controlsDisabled || nameProblem !== null) return;
    const path = folderPath;
    const name = nameValue.trim();
    setBusy(true);
    setNotice(null);
    if (nameChanged) {
      const failure = await refusalOf(client, client.renameFolder(path, name), RENAME_FALLBACK);
      if (failure !== null) {
        setBusy(false);
        setNotice(failure);
        return;
      }
    }
    const opened = await refusalOf(client, client.openWorkspace(path), OPEN_FALLBACK);
    if (opened !== null) {
      setBusy(false);
      setNotice(opened);
      return;
    }
    if (purpose === 'new-session') {
      const chat = failureNotice(await startNewChat(client), NEW_CHAT_FALLBACK);
      if (chat !== null) {
        setBusy(false);
        setNotice(chat);
        return;
      }
    }
    onClose();
  }

  function onDialogKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  }

  const visible = listing === null ? [] : filterFolderEntries(listing.entries, filter);
  const crumbs = folderPath === null ? [] : breadcrumbs(folderPath);
  const recent = state.workspaces ?? [];
  const createHint = createProblem ?? CREATE_HINT;
  const nameHint = nameProblem ?? CLEAR_NAME_HINT;

  const dialog = (
    // The company scale (spacing, text sizes) and reduced motion live on .company-ui.
    <div className="company-ui">
      <div className="fixed inset-0 z-40 flex items-center justify-center">
        <button
          type="button"
          aria-label="Đóng chọn thư mục"
          onClick={onClose}
          className="absolute inset-0 cursor-default bg-black/40"
        />
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="folder-browser-title"
          tabIndex={-1}
          onKeyDown={onDialogKeyDown}
          className="relative flex max-h-[85vh] w-[min(560px,92vw)] flex-col gap-2 overflow-hidden rounded-(--company-radius-md) bg-panel p-3 text-xs text-text outline-none max-md:h-full max-md:max-h-none max-md:w-full max-md:rounded-none"
        >
          <header className="flex shrink-0 items-center justify-between gap-2">
            <h2 id="folder-browser-title" className="text-sm text-text">
              {title}
            </h2>
            <button
              type="button"
              aria-label="Đóng"
              onClick={onClose}
              className="company-icon-btn touch-target"
            >
              <Icon name="close" />
            </button>
          </header>

          {listing !== null && listing.path !== null && (
            <div className="flex shrink-0 flex-wrap items-center gap-1">
              <CompanyButton
                type="button"
                size="sm"
                disabled={controlsDisabled || listing.parent === null}
                onClick={() => {
                  if (listing.parent !== null) navigate(listing.parent);
                }}
              >
                Lên trên
              </CompanyButton>
              <nav
                aria-label="Đường dẫn"
                className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 text-2xs"
              >
                {crumbs.map((crumb, index) => (
                  <Fragment key={crumb.path}>
                    {index > 0 && (
                      <span aria-hidden="true" className="text-text-muted">
                        ›
                      </span>
                    )}
                    <button
                      type="button"
                      disabled={controlsDisabled}
                      onClick={() => navigate(crumb.path)}
                      className="touch-target max-w-[18ch] truncate rounded-(--company-radius-sm) px-1 text-text hover:bg-hover disabled:cursor-default disabled:text-text-muted"
                    >
                      {crumb.label}
                    </button>
                  </Fragment>
                ))}
              </nav>
            </div>
          )}

          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
            {waiting ? (
              <p role="status" className="py-6 text-center text-text-muted">
                {FOLDER_LIST_LOADING_MESSAGE}
              </p>
            ) : listing === null ? (
              <div>
                <CompanyButton type="button" size="sm" onClick={() => navigate()}>
                  Về màn đầu
                </CompanyButton>
              </div>
            ) : listing.path === null ? (
              <div className="flex flex-col gap-3">
                {recent.length > 0 && (
                  <section aria-labelledby="folder-recent" className="flex flex-col gap-1">
                    <h3 id="folder-recent" className="text-2xs text-text-muted">
                      Gần đây
                    </h3>
                    <ul className="flex flex-col">
                      {recent.map((entry) => (
                        <li key={entry.path}>
                          <button
                            type="button"
                            title={entry.path}
                            disabled={controlsDisabled}
                            onClick={() => navigate(entry.path)}
                            className={ROW_CLASS}
                          >
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate text-text">{folderLabel(entry)}</span>
                              <span className="truncate text-2xs text-text-muted">
                                {entry.path}
                              </span>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                <section aria-labelledby="folder-roots" className="flex flex-col gap-1">
                  <h3 id="folder-roots" className="text-2xs text-text-muted">
                    Ổ đĩa và thư mục
                  </h3>
                  <ul className="flex flex-col">
                    {listing.roots.map((root) => (
                      <li key={root.path}>
                        <button
                          type="button"
                          title={root.path}
                          disabled={controlsDisabled}
                          onClick={() => navigate(root.path)}
                          className={ROW_CLASS}
                        >
                          <Icon name="folder" className="size-3.5 shrink-0 text-text-muted" />
                          <span className="truncate text-text">{root.name}</span>
                          <span className="ml-auto shrink-0 text-2xs text-text-muted">
                            {ROOT_KIND_LABELS[root.kind]}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              </div>
            ) : (
              <>
                <input
                  type="search"
                  aria-label="Lọc thư mục"
                  placeholder="Lọc theo tên…"
                  value={filter}
                  disabled={controlsDisabled}
                  onChange={(event) => setFilter(event.target.value)}
                  className={`${INPUT_CLASS} w-full`}
                />
                {listing.truncated && <p className="text-2xs text-warning">{TRUNCATED_NOTE}</p>}
                <ul aria-label="Thư mục con" className="flex min-h-0 flex-1 flex-col">
                  {visible.map((entry) => (
                    <li key={entry.path}>
                      <button
                        type="button"
                        title={entry.path}
                        disabled={controlsDisabled}
                        onClick={() => navigate(entry.path)}
                        className={ROW_CLASS}
                      >
                        <Icon name="folder" className="size-3.5 shrink-0 text-text-muted" />
                        <span className="truncate text-text">{entry.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                {visible.length === 0 && (
                  <p className="py-2 text-center text-text-muted">
                    {listing.entries.length === 0 ? NO_SUBFOLDERS : NO_MATCH}
                  </p>
                )}
                {creating ? (
                  <form onSubmit={createSubfolder} className="flex flex-col gap-1">
                    <div className="flex items-center gap-1">
                      <input
                        autoFocus
                        aria-label="Tên thư mục mới"
                        aria-describedby="folder-create-hint"
                        aria-invalid={createProblem !== null}
                        value={newName}
                        disabled={controlsDisabled}
                        onChange={(event) => setNewName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key !== 'Escape') return;
                          // Escape closes the name box, not the dialog.
                          event.stopPropagation();
                          setCreating(false);
                        }}
                        className={`${INPUT_CLASS} flex-1`}
                      />
                      <CompanyButton
                        type="submit"
                        size="sm"
                        disabled={!canCreate || controlsDisabled}
                      >
                        Tạo
                      </CompanyButton>
                      <CompanyButton type="button" size="sm" onClick={() => setCreating(false)}>
                        Hủy
                      </CompanyButton>
                    </div>
                    <p
                      id="folder-create-hint"
                      className={`text-2xs ${createProblem === null ? 'text-text-muted' : 'text-danger'}`}
                    >
                      {createHint}
                    </p>
                  </form>
                ) : (
                  <div>
                    <CompanyButton
                      type="button"
                      size="sm"
                      disabled={controlsDisabled}
                      onClick={() => setCreating(true)}
                    >
                      Tạo thư mục
                    </CompanyButton>
                  </div>
                )}
              </>
            )}
          </div>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void choose();
            }}
            className="flex shrink-0 flex-col gap-2 border-t border-hairline pt-2"
          >
            <label className="flex flex-col gap-1 text-text-muted">
              Tên hiển thị
              <input
                aria-describedby="folder-name-hint"
                aria-invalid={nameProblem !== null}
                value={nameValue}
                disabled={folderPath === null || controlsDisabled}
                onChange={(event) => {
                  if (folderPath !== null) {
                    setChosenName({ path: folderPath, value: event.target.value });
                  }
                }}
                className={`${INPUT_CLASS} w-full`}
              />
            </label>
            <p
              id="folder-name-hint"
              className={`text-2xs ${nameProblem === null ? 'text-text-muted' : 'text-danger'}`}
            >
              {nameHint}
            </p>
            {shownNotice !== null && (
              <p role="alert" className="text-danger">
                {shownNotice}
              </p>
            )}
            <div className="flex justify-end gap-1">
              <CompanyButton type="button" size="sm" onClick={onClose}>
                Hủy
              </CompanyButton>
              <CompanyButton type="submit" size="sm" variant="accent" disabled={!choosable}>
                Chọn thư mục này
              </CompanyButton>
            </div>
          </form>
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
