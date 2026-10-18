/**
 * AgentContextMenu: the right-click menu on a piece of work, as one floating panel.
 *
 * It opens from the surface that was used, at the pointer or below the focused
 * row, and lists what that subject offers (agentMenu.ts decides the items). A
 * rename, a focus or a lifecycle control is sent here, and the menu stays open
 * until the server answers, so a refusal can be read. A destructive action asks
 * inline first. Escape steps back out of a rename or a confirm, then closes the
 * menu and returns focus to the element that opened it.
 */

import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { AgentInfo, CompanySessionSummary, HerdrAgent } from '../../../../core/src/company.js';
import type { HerdrSleepingSession } from '../../../../core/src/messages.js';
import { workingFolder } from '../agentInfoView.js';
import {
  type AgentMenuAction,
  type AgentMenuItem,
  type AgentMenuRequest,
  type AgentMenuSubject,
  type CopyWhat,
  HERDR_NAME_RULE,
  herdrMenuItems,
  herdrNameProblem,
  placeMenu,
  planningMenuItems,
  type Point,
  projectMenuItems,
  SESSION_NAME_MAX_LENGTH,
  type SessionControlAction,
  type SessionMenuFacts,
  sessionMenuItems,
  type SessionMenuTab,
  sessionNameProblem,
  sleepingMenuItems,
  taskCardMenuItems,
} from '../agentMenu.js';
import { pendingQuestionSessionIds, sleepingName } from '../agentSidebarView.js';
import { copyText } from '../clipboard.js';
import { failureNotice } from '../commandResults.js';
import type { CompanyClient, CompanyCommandHandle } from '../companyClient.js';
import type { CompanyViewState } from '../companyState.js';
import { HERDR_TONE_LABELS, type HerdrDrawerTab, herdrToneFor } from '../herdrView.js';
import { DELETE_CONFIRM_DETAIL, REFUSED_NOTICE, sessionHoldsWork } from '../sessionActions.js';
import { deleteSessionsInOrder, removalNotice } from '../sessionRemoval.js';
import { sessionStatusLabel, taskStatusLabel } from '../statusLabels.js';
import { CompanyButton } from './CompanyButton.js';
import { ConfirmAction } from './ConfirmAction.js';

export interface AgentContextMenuProps {
  client: CompanyClient;
  state: CompanyViewState;
  request: AgentMenuRequest;
  onClose: () => void;
  onSessionTab: (sessionId: string, tab: SessionMenuTab) => void;
  onHerdrTab: (paneId: string, tab: HerdrDrawerTab) => void;
  onSelectTask: (taskId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onOpenContract: (contractId: string) => void;
  onToggleMaximize: () => void;
  onToggleProject: (key: string) => void;
}

/** The actions that ask first. Each names the item that opened the question. */
type ConfirmKind = 'kill' | 'delete' | 'cancel-prompt' | 'clean';

type MenuMode = 'menu' | 'rename' | ConfirmKind;

interface Notice {
  text: string;
  failed: boolean;
}

interface ConfirmSpec {
  message: string;
  label: string;
  run: () => void;
}

/** What the menu reads from state for its subject. Each field is null or undefined when gone. */
interface MenuFacts {
  session: CompanySessionSummary | undefined;
  sessionFacts: SessionMenuFacts | null;
  agent: HerdrAgent | undefined;
  sleeping: HerdrSleepingSession | undefined;
  task: { code: string; title: string; status: string } | undefined;
  prompt: { preview: string } | undefined;
  folder: string | null;
  taskContractId: string | null;
}

const ITEM_SELECTOR = 'button[role="menuitem"]:not([aria-disabled="true"])';
const NOT_SENT_NOTICE = 'Không gửi được.';
const COPY_FAILED_NOTICE = 'Không sao chép được vào bộ nhớ tạm.';
const GONE_TEXT = 'Mục này không còn trên bảng.';

/** The session a menu acts on: a session row's own, or the one a task or planning card names. */
function actingSessionId(subject: AgentMenuSubject): string | null {
  switch (subject.kind) {
    case 'session':
    case 'task':
    case 'planning':
      return subject.sessionId;
    case 'herdr':
    case 'sleeping':
    case 'project':
      return null;
  }
}

/** The folder a herdr pane works in: herdr's own cwd first, else the one its info reports. */
function herdrFolder(cwd: string | undefined, info: AgentInfo | undefined): string | null {
  return cwd || (info === undefined ? null : workingFolder(info)) || null;
}

/** The items for the subject; null when what it names is gone from the board. */
function itemsFor(subject: AgentMenuSubject, facts: MenuFacts): AgentMenuItem[] | null {
  switch (subject.kind) {
    case 'session':
      return facts.sessionFacts === null
        ? null
        : sessionMenuItems(facts.sessionFacts, subject.drawer);
    case 'task':
      if (facts.task === undefined) return null;
      return taskCardMenuItems(
        { code: facts.task.code, contractId: facts.taskContractId },
        facts.sessionFacts,
        subject.drawer,
      );
    case 'planning':
      return facts.prompt === undefined ? null : planningMenuItems(facts.session !== undefined);
    case 'herdr':
      return facts.agent === undefined ? null : herdrMenuItems(facts.folder, subject.drawer);
    case 'sleeping':
      return facts.sleeping === undefined ? null : sleepingMenuItems(subject.drawer);
    case 'project':
      return projectMenuItems(subject.project);
  }
}

/** The two lines the menu's header prints about what it is open on. */
function headerLines(
  subject: AgentMenuSubject,
  facts: MenuFacts,
): { title: string; subtitle: string } {
  switch (subject.kind) {
    case 'session':
      if (facts.session === undefined) return { title: 'Phiên không còn', subtitle: '' };
      return {
        title: `${facts.session.code} · ${facts.session.name}`,
        subtitle: sessionStatusLabel(facts.session.status),
      };
    case 'task':
      if (facts.task === undefined) return { title: 'Việc không còn trên bảng', subtitle: '' };
      return {
        title: `${facts.task.code} · ${facts.task.title}`,
        subtitle: taskStatusLabel(facts.task.status),
      };
    case 'planning':
      return { title: 'Prompt đang lập kế hoạch', subtitle: facts.prompt?.preview ?? '' };
    case 'herdr':
      if (facts.agent === undefined)
        return { title: 'Agent herdr', subtitle: 'Không còn trong herdr' };
      return {
        title: `${facts.agent.kind} · ${facts.agent.paneId}`,
        subtitle: HERDR_TONE_LABELS[herdrToneFor(facts.agent.status)],
      };
    case 'sleeping':
      if (facts.sleeping === undefined) return { title: 'Phiên ngủ đông không còn', subtitle: '' };
      return { title: sleepingName(facts.sleeping), subtitle: 'Ngủ đông' };
    case 'project':
      return { title: subject.project.name, subtitle: subject.project.path ?? '' };
  }
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
  onSelectTask,
  onSelectSession,
  onOpenContract,
  onToggleMaximize,
  onToggleProject,
}: AgentContextMenuProps) {
  const { subject, anchor, returnFocus } = request;
  const sessionId = actingSessionId(subject);
  const paneId = subject.kind === 'herdr' || subject.kind === 'sleeping' ? subject.paneId : null;
  const isHerdr = subject.kind === 'herdr';
  const session = sessionId === null ? undefined : state.sessions[sessionId];
  const sessionInfo = sessionId === null ? undefined : state.sessionInfos[sessionId];
  const agent =
    paneId === null ? undefined : state.herdr.agents.find((entry) => entry.paneId === paneId);
  const paneInfo = paneId === null ? undefined : state.herdr.infos[paneId];
  const sleeping =
    subject.kind === 'sleeping'
      ? state.herdr.sleeping.find((entry) => entry.paneId === subject.paneId)
      : undefined;
  const task = subject.kind === 'task' ? state.tasks[subject.taskId] : undefined;
  const prompt =
    subject.kind === 'planning'
      ? state.prompts.find((entry) => entry.id === subject.promptId)
      : undefined;
  const folder = isHerdr
    ? herdrFolder(agent?.cwd, paneInfo)
    : sessionInfo === undefined
      ? null
      : workingFolder(sessionInfo);
  const holdsWork =
    session !== undefined &&
    sessionHoldsWork(session, pendingQuestionSessionIds(state).has(session.id));
  const facts: MenuFacts = {
    session,
    sessionFacts: session === undefined ? null : { status: session.status, cwd: folder, holdsWork },
    agent,
    sleeping,
    task,
    prompt,
    folder,
    taskContractId:
      task !== undefined && task.contractId in state.contracts ? task.contractId : null,
  };
  const items = itemsFor(subject, facts);
  const header = headerLines(subject, facts);
  const cleanIds = subject.kind === 'project' ? subject.project.cleanable : [];

  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [position, setPosition] = useState<Point>(anchor);
  const [mode, setMode] = useState<MenuMode>('menu');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');

  const sessionKnown = session !== undefined;
  const paneKnown = agent !== undefined;

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

  // A rename, a focus or a control is in flight: the menu closes on success and
  // shows the server's reason on a refusal, read from the command result.
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

  function copyValue(what: CopyWhat): string | null {
    switch (what) {
      case 'cwd':
        return folder;
      case 'sessionCode':
        return session?.code ?? null;
      case 'paneId':
        return paneId;
      case 'taskCode':
        return task?.code ?? null;
      case 'path':
        return subject.kind === 'project' ? subject.project.path : null;
    }
  }

  async function copy(what: CopyWhat): Promise<void> {
    const text = copyValue(what);
    if (text === null) return;
    const copied = await copyText(text);
    setNotice(
      copied
        ? { text: `Đã sao chép: ${text}`, failed: false }
        : { text: COPY_FAILED_NOTICE, failed: true },
    );
  }

  async function runClean(ids: readonly string[]): Promise<void> {
    setBusy(true);
    const report = await deleteSessionsInOrder(client, ids);
    setBusy(false);
    setMode('menu');
    setNotice({ text: removalNotice(report), failed: report.refused > 0 });
  }

  function confirmSpec(kind: ConfirmKind): ConfirmSpec {
    switch (kind) {
      case 'kill':
        return {
          message: `Tắt phiên ${session?.code ?? ''}? Phiên đang chạy sẽ bị dừng ngay.`,
          label: 'Tắt phiên',
          run: () => control('kill'),
        };
      case 'delete':
        return {
          message: `Xoá phiên ${session?.code ?? ''}? ${DELETE_CONFIRM_DETAIL}`,
          label: 'Xoá phiên',
          run: () => control('delete'),
        };
      case 'cancel-prompt':
        return {
          message: 'Huỷ prompt này? Prompt chưa thành Contract sẽ bị bỏ.',
          label: 'Huỷ prompt',
          run: () => {
            if (subject.kind === 'planning') track(client.cancelPrompt(subject.promptId));
          },
        };
      case 'clean':
        return {
          message: `Xoá ${cleanIds.length} phiên lỗi của ${header.title}? ${DELETE_CONFIRM_DETAIL}`,
          label: 'Xoá các phiên',
          run: () => void runClean(cleanIds),
        };
    }
  }

  function runItem(entry: AgentMenuItem): void {
    if (entry.disabled) return;
    const action: AgentMenuAction = entry.action;
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
        setDraft((isHerdr ? agent?.name : session?.name) ?? '');
        setNotice(null);
        setMode('rename');
        return;
      case 'copy':
        void copy(action.what);
        return;
      case 'control':
        if (action.action === 'kill' || action.action === 'delete') {
          setNotice(null);
          setMode(action.action);
          return;
        }
        control(action.action);
        return;
      case 'focus':
        if (paneId !== null) track(client.herdrFocus(paneId));
        return;
      case 'readScreen':
        if (paneId !== null) track(client.herdrRead(paneId));
        return;
      case 'maximize':
        onToggleMaximize();
        onClose();
        return;
      case 'openTask':
        if (subject.kind === 'task') onSelectTask(subject.taskId);
        onClose();
        return;
      case 'openContract':
        onOpenContract(action.contractId);
        onClose();
        return;
      case 'openSession':
        if (subject.kind === 'planning' && subject.sessionId !== null) {
          onSelectSession(subject.sessionId);
        }
        onClose();
        return;
      case 'cancelPrompt':
        setNotice(null);
        setMode('cancel-prompt');
        return;
      case 'toggleProject':
        if (subject.kind === 'project') onToggleProject(subject.project.key);
        onClose();
        return;
      case 'openBoardFolder':
        if (subject.kind === 'project' && subject.project.switchTo !== null) {
          track(client.openWorkspace(subject.project.switchTo));
        }
        return;
      case 'cleanErrored':
        setNotice(null);
        setMode('clean');
        return;
      case 'wake':
        if (paneId !== null) track(client.herdrWake(paneId));
        return;
    }
  }

  const problem = isHerdr ? herdrNameProblem(draft) : sessionNameProblem(draft);
  const showProblem = draft.trim() !== '' && problem !== null;
  const ruleHint = isHerdr ? HERDR_NAME_RULE : `Tối đa ${SESSION_NAME_MAX_LENGTH} ký tự.`;

  function submitRename(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (problem !== null) return;
    const name = draft.trim();
    if (isHerdr) {
      if (paneId !== null) track(client.herdrRename(paneId, name));
      return;
    }
    if (sessionId !== null) track(client.renameSession(sessionId, name));
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

  const confirm = mode === 'menu' || mode === 'rename' ? null : confirmSpec(mode);

  return (
    <div
      ref={menuRef}
      data-testid="agent-menu"
      tabIndex={-1}
      onKeyDown={onMenuKeyDown}
      className="fixed z-50 min-w-[220px] max-w-[min(280px,calc(100vw-16px))] rounded-(--company-radius-md) border border-hairline bg-raised py-1 text-xs text-text"
      style={{ left: position.x, top: position.y }}
    >
      <div className="px-3 pt-1.5 pb-2">
        <p className="truncate font-semibold text-text">{header.title}</p>
        {header.subtitle !== '' && (
          <p className="truncate text-2xs text-text-muted">{header.subtitle}</p>
        )}
      </div>

      {items === null ? (
        <p className="px-3 py-2 text-text-muted">{GONE_TEXT}</p>
      ) : mode === 'menu' ? (
        <div role="menu" aria-label="Thao tác" className="flex flex-col py-0.5">
          {items.map((entry) => (
            <MenuItemButton key={entry.id} item={entry} onRun={runItem} />
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
              className="rounded-(--company-radius-sm) bg-well px-2 py-1 text-xs text-text"
            />
          </label>
          <p id="agent-rename-hint" className="text-2xs text-text-muted">
            {ruleHint}
          </p>
          {showProblem && (
            <p role="alert" className="text-danger">
              {problem}
            </p>
          )}
          <div className="flex gap-1">
            <CompanyButton type="submit" size="sm" disabled={problem !== null || pending !== null}>
              Lưu
            </CompanyButton>
            <CompanyButton size="sm" onClick={() => setMode('menu')}>
              Quay lại
            </CompanyButton>
          </div>
        </form>
      ) : confirm === null ? null : (
        <div className="px-3 py-2">
          <ConfirmAction
            message={confirm.message}
            confirmLabel={confirm.label}
            danger
            disabled={pending !== null || busy}
            onConfirm={confirm.run}
            onCancel={() => setMode('menu')}
          />
        </div>
      )}

      {notice !== null && (
        <p
          role="status"
          className={`mt-1 px-3 py-1.5 ${notice.failed ? 'text-danger' : 'text-text-muted'}`}
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
      ? 'text-danger hover:bg-hover focus-visible:bg-hover'
      : 'text-text hover:bg-hover focus-visible:bg-hover';
  return (
    <>
      {item.startsGroup && <div role="separator" className="my-1" />}
      <button
        type="button"
        role="menuitem"
        aria-disabled={item.disabled}
        title={item.title ?? undefined}
        onClick={() => onRun(item)}
        className={`touch-target flex h-7 w-full items-center justify-between gap-3 px-3 text-left outline-none ${tone}`}
      >
        <span className="truncate">{item.label}</span>
        {item.hint !== null && (
          <span className="shrink-0 text-2xs text-text-muted">{item.hint}</span>
        )}
      </button>
    </>
  );
}
