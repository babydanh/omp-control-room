/**
 * BoardShell: the whole Company surface, a full-screen board for runs on OMP.
 *
 * Top to bottom:
 *  1. Where the board points and how the company is doing (BoardTopBar).
 *  2. What is waiting on the user: a Contract to approve, questions to answer
 *     (AttentionBar). These are the only things that unblock the company.
 *  3. Beside the lanes: the agent sidebar (every agent by role, herdr by repo),
 *     which collapses to a rail that still shows every agent, and the detail
 *     drawer for whatever is open.
 *  4. The composer, always mounted.
 *
 * Everything shown came from a server message. When a revision gap is open the
 * board says so instead of quietly showing stale cards.
 */

import { useEffect, useMemo, useState } from 'react';

import { boardFlow, buildBoardLanes, planningPrompts } from '../boardView.js';
import type { CompanyClient } from '../companyClient.js';
import { COMPANY_SIDEBAR_OVERLAY_MAX_PX } from '../constants.js';
import {
  type DrawerSubject,
  drawerSubjectFor,
  type OpenedSubject,
  pendingContract,
  selectionForSession,
  selectionForTask,
} from '../selection.js';
import {
  clampSidebarWidth,
  isSidebarToggleKey,
  isTypingTarget,
  readSidebarPrefs,
  type SidebarPrefs,
  type SidebarStorage,
  writeSidebarPrefs,
} from '../sidebarPrefs.js';
import { useCompanyState } from '../useCompanyState.js';
import { useMediaQuery } from '../useMediaQuery.js';
import { useSessionLogBackfill } from '../useSessionLogBackfill.js';
import { AgentRail } from './AgentRail.js';
import { AgentSidebar } from './AgentSidebar.js';
import { AttentionBar } from './AttentionBar.js';
import { BoardTopBar } from './BoardTopBar.js';
import { CompanyBoard } from './CompanyBoard.js';
import { DetailDrawer } from './DetailDrawer.js';
import { PromptComposer } from './PromptComposer.js';

/**
 * The webview's localStorage, or null when the host refuses access to it. A
 * refused store means the sidebar simply does not remember its shape.
 */
function browserSidebarStorage(): SidebarStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export interface BoardShellProps {
  client: CompanyClient;
}

export function BoardShell({ client }: BoardShellProps) {
  const state = useCompanyState(client);
  useSessionLogBackfill(client, state);
  const [opened, setOpened] = useState<OpenedSubject | null>(null);
  const [artifactId, setArtifactId] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<SidebarPrefs>(() => readSidebarPrefs(browserSidebarStorage()));
  const overlay = useMediaQuery(`(max-width: ${COMPANY_SIDEBAR_OVERLAY_MAX_PX}px)`);

  const lanes = useMemo(() => buildBoardLanes(state), [state]);
  const pendingQuestions = useMemo(
    () => Object.values(state.questions).filter((question) => question.status === 'pending'),
    [state.questions],
  );
  const subject: DrawerSubject | null = drawerSubjectFor(state, opened);
  const selectedSessionId =
    subject?.kind === 'session' || subject?.kind === 'task' ? state.selection.sessionId : null;
  const selectedPaneId = subject?.kind === 'herdr' ? subject.paneId : null;

  // Diagnostics are a live measurement of processes the user owns: asked for
  // once the board is on screen, never polled in the background.
  useEffect(() => {
    client.requestDiagnostics();
  }, [client]);

  // The sidebar's shape is remembered across reloads, so it is written whenever
  // it changes. A refused store only means it is not remembered.
  useEffect(() => {
    writeSidebarPrefs(browserSidebarStorage(), prefs);
  }, [prefs]);

  // Ctrl+B / ⌘B toggles the sidebar, except where the key is text or a shell key.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!isSidebarToggleKey(event)) return;
      if (isTypingTarget(event.target instanceof HTMLElement ? event.target : null)) return;
      event.preventDefault();
      setPrefs((current) => ({ ...current, collapsed: !current.collapsed }));
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  function toggleSidebar(): void {
    setPrefs((current) => ({ ...current, collapsed: !current.collapsed }));
  }

  function selectSession(sessionId: string): void {
    setOpened(null);
    client.select(selectionForSession(state, sessionId));
  }

  function selectTask(taskId: string): void {
    setOpened(null);
    client.select(selectionForTask(state, taskId));
  }

  function openHerdr(paneId: string): void {
    setOpened({ kind: 'herdr', paneId });
  }

  function closeDrawer(): void {
    setOpened(null);
    client.select({ sessionId: null, taskId: null, tab: null });
  }

  function toggleFiles(): void {
    setOpened((current) => (current?.kind === 'files' ? null : { kind: 'files' }));
  }

  return (
    <div
      className="company-ui flex h-full w-full flex-col overflow-hidden bg-bg"
      data-testid="company-workspace"
    >
      <BoardTopBar
        state={state}
        sidebarCollapsed={prefs.collapsed}
        onToggleSidebar={toggleSidebar}
        filesOpen={opened?.kind === 'files'}
        onToggleFiles={toggleFiles}
      />
      {state.needsSnapshot && (
        <p className="border-b border-warning px-3 py-1 text-2xs text-warning">
          Có thay đổi đã bị bỏ sót; đang chờ một bản chụp mới từ máy chủ.
        </p>
      )}
      <AttentionBar
        contract={pendingContract(state)}
        questions={pendingQuestions}
        onOpenContract={() => setOpened({ kind: 'contract' })}
        onOpenQuestion={(questionId) => setOpened({ kind: 'question', questionId })}
      />
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {!prefs.collapsed && overlay && (
          <button
            type="button"
            aria-label="Thu gọn đàn agent"
            onClick={toggleSidebar}
            className="absolute inset-0 z-20 cursor-default bg-black/40"
          />
        )}
        {prefs.collapsed ? (
          <AgentRail
            state={state}
            selectedSessionId={selectedSessionId}
            selectedPaneId={selectedPaneId}
            onExpand={toggleSidebar}
            onSelectSession={selectSession}
            onOpenHerdr={openHerdr}
          />
        ) : (
          <AgentSidebar
            client={client}
            state={state}
            selectedSessionId={selectedSessionId}
            selectedPaneId={selectedPaneId}
            width={prefs.width}
            overlay={overlay}
            onWidthChange={(width) =>
              setPrefs((current) => ({ ...current, width: clampSidebarWidth(width) }))
            }
            onCollapse={toggleSidebar}
            onSelectSession={selectSession}
            onOpenHerdr={openHerdr}
          />
        )}
        <CompanyBoard
          lanes={lanes}
          flow={boardFlow(lanes, state.settings?.maxWorkers ?? null)}
          planning={planningPrompts(state)}
          onSelectSession={selectSession}
          onSelectTask={selectTask}
        />
        <DetailDrawer
          client={client}
          state={state}
          subject={subject}
          lanes={lanes}
          artifactId={artifactId}
          onOpen={setOpened}
          onOpenArtifact={(id) => {
            setArtifactId(id);
            setOpened({ kind: 'files' });
          }}
          onClearArtifact={() => setArtifactId(null)}
          onClose={closeDrawer}
        />
      </div>
      <PromptComposer client={client} />
    </div>
  );
}
