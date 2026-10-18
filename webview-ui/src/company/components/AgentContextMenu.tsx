/**
 * AgentContextMenu: the right-click menu on an agent, as one floating panel.
 *
 * It opens from the surface that was used, at the pointer or below the focused
 * row, and lists what the agent offers (agentMenu.ts decides the items). A rename,
 * a focus or a lifecycle control is sent here, and the menu stays open until the
 * server answers, so a refusal can be read. Escape steps back out of rename or a
 * confirm, then closes the menu and returns focus to the row that opened it.
 */

import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { AgentInfo, CompanySessionSummary, HerdrAgent } from '../../../../core/src/company.js';
import { workingFolder } from '../agentInfoView.js';
import {
  type AgentMenuAction,
  type AgentMenuItem,
  type AgentMenuRequest,
  type AgentMenuSubject,
  HERDR_NAME_RULE,
  herdrMenuItems,
  herdrNameProblem,
  placeMenu,
  type Point,
  SESSION_NAME_MAX_LENGTH,
  type SessionControlAction,
  sessionMenuItems,
  type SessionMenuTab,
  sessionNameProblem,
} from '../agentMenu.js';
import { pendingQuestionSessionIds } from '../agentSidebarView.js';
import { copyText } from '../clipboard.js';
import { failureNotice } from '../commandResults.js';
import type { CompanyClient, CompanyCommandHandle } from '../companyClient.js';
import type { CompanyViewState } from '../companyState.js';
import { HERDR_TONE_LABELS, type HerdrDrawerTab, herdrToneFor } from '../herdrView.js';
import { DELETE_CONFIRM_DETAIL, REFUSED_NOTICE, sessionHoldsWork } from '../sessionActions.js';
import { sessionStatusLabel } from '../statusLabels.js';
import { CompanyButton } from './CompanyButton.js';
import { ConfirmAction } from './SessionActions.js';

export interface AgentContextMenuProps {
  client: CompanyClient;
  state: CompanyViewState;
  request: AgentMenuRequest;
  onClose: () => void;
  onSessionTab: (sessionId: string, tab: SessionMenuTab) => void;
  onHerdrTab: (paneId: string, tab: HerdrDrawerTab) => void;
}

type MenuMode = 'menu' | 'rename' | 'confirm-kill' | 'confirm-delete';

interface Notice {
  text: string;
  failed: boolean;
}

const ITEM_SELECTOR = 'button[role="menuitem"]:not([aria-disabled="true"])';
const NOT_SENT_NOTICE = 'Không gửi được.';
const COPY_FAILED_NOTICE = 'Không sao chép được vào bộ nhớ tạm.';

/** The folder a herdr pane works in: herdr's own cwd first, else the one its info reports. */
function herdrFolder(cwd: string | undefined, info: AgentInfo | undefined): string | null {
  return cwd || (info === undefined ? null : workingFolder(info)) || null;
}

/** The items for the subject; null when the session or pane it names is gone. */
function menuItemsFor(
  subject: AgentMenuSubject,
  session: CompanySessionSummary | undefined,
  agent: HerdrAgent | undefined,
  folder: string | null,
  holdsWork: boolean,
): AgentMenuItem[] | null {
  if (subject.kind === 'herdr') return agent === undefined ? null : herdrMenuItems(folder);
  if (subject.sessionId === null) return sessionMenuItems(null);
  if (session === undefined) return null;
  return sessionMenuItems({ status: session.status, cwd: folder, holdsWork });
}

/** The two lines the menu's header prints about what it is open on. */
function headerLines(
  subject: AgentMenuSubject,
  session: CompanySessionSummary | undefined,
  agent: HerdrAgent | undefined,
): { title: string; subtitle: string } {
  if (subject.kind === 'herdr') {
    if (agent === undefined) return { title: 'Agent herdr', subtitle: 'Không còn trong herdr' };
    return {
      title: `${agent.kind} · ${agent.paneId}`,
      subtitle: HERDR_TONE_LABELS[herdrToneFor(agent.status)],
    };
  }
  if (subject.sessionId === null) {
    return { title: 'Chưa có phiên', subtitle: 'Mục này chưa gắn với phiên nào' };
  }
  if (session === undefined) return { title: 'Phiên không còn', subtitle: '' };
  return {
    title: `${session.code} · ${session.name}`,
    subtitle: sessionStatusLabel(session.status),
  };
}

/** The next item to focus for a navigation key, or null when the key moves nothing. */
function nextItemIndex(key: string, current: number, count: number): number | null {
  switch (key) {
    case 'ArrowDown':
      return (current + 1) % count;
    case 'ArrowUp':
      return current <= 0 ? count - 1 : current - 1;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

function enabledItems(menu: HTMLElement | null): HTMLElement[] {
  return menu === null ? [] : Array.from(menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR));
}

export function AgentContextMenu({
  client,
  state,
  request,
  onClose,
  onSessionTab,
  onHerdrTab,
}: AgentContextMenuProps) {
  const { subject, anchor, returnFocus } = request;
  const sessionId = subject.kind === 'session' ? subject.sessionId : null;
  const paneId = subject.kind === 'herdr' ? subject.paneId : null;
  const session: CompanySessionSummary | undefined =
    sessionId === null ? undefined : state.sessions[sessionId];
  const sessionInfo: AgentInfo | undefined =
    sessionId === null ? undefined : state.sessionInfos[sessionId];
  const agent: HerdrAgent | undefined =
    paneId === null ? undefined : state.herdr.agents.find((entry) => entry.paneId === paneId);
  const paneInfo: AgentInfo | undefined = paneId === null ? undefined : state.herdr.infos[paneId];
  const folder =
    subject.kind === 'herdr'
      ? herdrFolder(agent?.cwd, paneInfo)
      : sessionInfo === undefined
        ? null
        : workingFolder(sessionInfo);
  const holdsWork =
    session !== undefined &&
    sessionHoldsWork(session, pendingQuestionSessionIds(state).has(session.id));
  const items = menuItemsFor(subject, session, agent, folder, holdsWork);
  const header = headerLines(subject, session, agent);

  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [position, setPosition] = useState<Point>(anchor);
  const [mode, setMode] = useState<MenuMode>('menu');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const sessionKnown = sessionId !== null && session !== undefined;
  const paneKnown = paneId !== null && agent !== undefined;

  // The menu asks for the agent's info on open, so the folder copy and the info
  // tab are ready. A request is read-only; it is not repeated on every update.
  useEffect(() => {
    if (sessionId !== null && sessionKnown) client.requestSessionInfo(sessionId);
  }, [client, sessionId, sessionKnown]);

  useEffect(() => {
    if (paneId !== null && paneKnown) client.requestHerdrInfo(paneId);
  }, [client, paneId, paneKnown]);

  // Focus the first enabled item, or the rename box when renaming.
  useEffect(() => {
    if (mode === 'rename') {
      inputRef.current?.focus({ preventScroll: true });
      return;
    }
    const first = enabledItems(menuRef.current).at(0);
    (first ?? menuRef.current)?.focus({ preventScroll: true });
  }, [mode]);

  // Clamp the menu to the viewport once its size is known, before it is painted.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (menu === null) return;
    const rect = menu.getBoundingClientRect();
    setPosition(
      placeMenu(
        anchor,
        { width: rect.width, height: rect.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [anchor, mode, notice]);

  // Escape, a pointer press outside, scrolling anywhere else, or a resize closes the menu.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (mode !== 'menu') {
        setMode('menu');
        return;
      }
      returnFocus?.focus({ preventScroll: true });
      onClose();
    }
    function onPointerDown(event: PointerEvent): void {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      onClose();
    }
    function onScroll(event: Event): void {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      onClose();
    }
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
    };
  }, [mode, onClose, returnFocus]);

  // A rename or a focus is in flight: the menu closes on success and shows the
  // server's reason on a refusal, read from the command result the server sends.
  useEffect(() => {
    if (pending === null) return;
    const outcome = state.commandResults[pending];
    if (outcome === undefined) return;
    if (outcome.ok) {
      onClose();
      return;
    }
    setPending(null);
    setNotice({ text: outcome.message ?? outcome.errorCode ?? REFUSED_NOTICE, failed: true });
  }, [pending, state.commandResults, onClose]);

  function track(handle: CompanyCommandHandle): void {
    const failure = failureNotice(handle, NOT_SENT_NOTICE);
    if (failure !== null) {
      setNotice({ text: failure, failed: true });
      return;
    }
    setNotice(null);
    setPending(handle.requestId);
  }

  function control(action: SessionControlAction): void {
    if (sessionId === null) return;
    track(client.controlSession(sessionId, action));
  }

  async function copy(what: 'cwd' | 'sessionCode' | 'paneId'): Promise<void> {
    const text =
      what === 'cwd' ? folder : what === 'sessionCode' ? (session?.code ?? null) : paneId;
    if (text === null) return;
    const copied = await copyText(text);
    setNotice(
      copied
        ? { text: `Đã sao chép: ${text}`, failed: false }
        : { text: COPY_FAILED_NOTICE, failed: true },
    );
  }

  function runItem(item: AgentMenuItem): void {
    if (item.disabled) return;
    const action: AgentMenuAction = item.action;
    switch (action.kind) {
      case 'sessionTab':
        if (sessionId !== null) onSessionTab(sessionId, action.tab);
        onClose();
        return;
      case 'herdrTab':
        if (paneId !== null) onHerdrTab(paneId, action.tab);
        onClose();
        return;
      case 'rename':
        setDraft(subject.kind === 'session' ? (session?.name ?? '') : (agent?.name ?? ''));
        setNotice(null);
        setMode('rename');
        return;
      case 'copy':
        void copy(action.what);
        return;
      case 'control':
        if (action.action === 'kill' || action.action === 'delete') {
          setMode(action.action === 'kill' ? 'confirm-kill' : 'confirm-delete');
          return;
        }
        control(action.action);
        return;
      case 'focus':
        if (paneId !== null) track(client.herdrFocus(paneId));
        return;
    }
  }

  const problem = subject.kind === 'session' ? sessionNameProblem(draft) : herdrNameProblem(draft);
  const showProblem = draft.trim() !== '' && problem !== null;
  const hint =
    subject.kind === 'session' ? `Tối đa ${SESSION_NAME_MAX_LENGTH} ký tự.` : HERDR_NAME_RULE;

  function submitRename(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (problem !== null) return;
    const name = draft.trim();
    if (subject.kind === 'session') {
      if (sessionId !== null) track(client.renameSession(sessionId, name));
      return;
    }
    if (paneId !== null) track(client.herdrRename(paneId, name));
  }

  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (mode !== 'menu') return;
    if (event.key === 'Tab') {
      onClose();
      return;
    }
    const menuItems = enabledItems(menuRef.current);
    const current = menuItems.indexOf(document.activeElement as HTMLElement);
    const next = nextItemIndex(event.key, current, menuItems.length);
    if (next === null) return;
    event.preventDefault();
    menuItems.at(next)?.focus({ preventScroll: true });
  }

  return (
    <div
      ref={menuRef}
      data-testid="agent-menu"
      tabIndex={-1}
      onKeyDown={onMenuKeyDown}
      className="fixed z-50 min-w-[220px] max-w-[280px] rounded-[6px] border border-border bg-bg-dark py-1 text-2xs text-text shadow-lg"
      style={{ left: position.x, top: position.y }}
    >
      <div className="border-b border-border px-3 py-1.5">
        <p className="truncate text-text">{header.title}</p>
        {header.subtitle !== '' && <p className="truncate text-text-muted">{header.subtitle}</p>}
      </div>

      {items === null ? (
        <p className="px-3 py-2 text-text-muted">
          {subject.kind === 'session'
            ? 'Phiên đó không còn thuộc công ty nữa.'
            : 'Agent này không còn trong herdr.'}
        </p>
      ) : mode === 'menu' ? (
        <div role="menu" aria-label="Thao tác với agent" className="flex flex-col">
          {items.map((item) => (
            <MenuItemButton key={item.id} item={item} onRun={runItem} />
          ))}
        </div>
      ) : mode === 'rename' ? (
        <form onSubmit={submitRename} className="flex flex-col gap-2 px-3 py-2">
          <label className="flex flex-col gap-1 text-text-muted">
            Tên mới
            <input
              ref={inputRef}
              aria-describedby="agent-rename-hint"
              aria-invalid={showProblem}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setMode('menu');
              }}
              className="rounded-[5px] border border-border bg-bg px-2 py-1 text-2xs text-text"
            />
          </label>
          <p id="agent-rename-hint" className="text-text-muted">
            {hint}
          </p>
          {showProblem && (
            <p role="alert" className="text-warning">
              {problem}
            </p>
          )}
          <div className="flex gap-1">
            <CompanyButton type="submit" size="sm" disabled={problem !== null}>
              Lưu
            </CompanyButton>
            <CompanyButton size="sm" onClick={() => setMode('menu')}>
              Quay lại
            </CompanyButton>
          </div>
        </form>
      ) : mode === 'confirm-kill' ? (
        <div className="px-3 py-2">
          <ConfirmAction
            message={`Tắt phiên ${session?.code ?? ''}? Phiên đang chạy sẽ bị dừng ngay.`}
            confirmLabel="Tắt phiên"
            danger
            disabled={pending !== null}
            onConfirm={() => control('kill')}
            onCancel={() => setMode('menu')}
          />
        </div>
      ) : (
        <div className="px-3 py-2">
          <ConfirmAction
            message={`Xoá phiên ${session?.code ?? ''}? ${DELETE_CONFIRM_DETAIL}`}
            confirmLabel="Xoá phiên"
            danger
            disabled={pending !== null}
            onConfirm={() => control('delete')}
            onCancel={() => setMode('menu')}
          />
        </div>
      )}

      {notice !== null && (
        <p
          role="status"
          className={`border-t border-border px-3 py-1.5 ${notice.failed ? 'text-warning' : 'text-text-muted'}`}
        >
          {notice.text}
        </p>
      )}
    </div>
  );
}

function MenuItemButton({
  item,
  onRun,
}: {
  item: AgentMenuItem;
  onRun: (item: AgentMenuItem) => void;
}) {
  const tone = item.disabled
    ? 'cursor-default text-text-muted'
    : item.danger
      ? 'text-warning hover:bg-btn-hover focus:bg-btn-hover'
      : 'text-text hover:bg-btn-hover focus:bg-btn-hover';
  return (
    <>
      {item.startsGroup && <div role="separator" className="my-1 border-t border-border" />}
      <button
        type="button"
        role="menuitem"
        aria-disabled={item.disabled}
        title={item.reason ?? undefined}
        onClick={() => onRun(item)}
        className={`flex w-full flex-col items-start px-3 py-1 text-left outline-none ${tone}`}
      >
        <span>{item.label}</span>
        {item.reason !== null && <span className="text-2xs text-text-muted">{item.reason}</span>}
      </button>
    </>
  );
}
