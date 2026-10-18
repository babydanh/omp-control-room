/**
 * BoardShell: the whole Company surface, a full-screen board for runs on OMP.
 *
 * It owns the state the surfaces share: the subject the drawer shows, the artifact
 * a file view opened, the remembered shapes of the sidebar and the drawer, the
 * herdr tab, the folds of the project tree, and the one context menu. Every
 * action a row, card, drawer header or project header offers lives in that
 * menu; the surfaces keep only their content controls.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { type AgentMenuRequest, type SessionMenuTab } from '../agentMenu.js';
import { boardFlow, buildBoardLanes, planningPrompts } from '../boardView.js';
import type { CompanyClient } from '../companyClient.js';
import { COMPANY_RAIL_WIDTH_PX, COMPANY_SIDEBAR_OVERLAY_MAX_PX } from '../constants.js';
import { type DrawerPrefs, readDrawerPrefs, writeDrawerPrefs } from '../drawerPrefs.js';
import type { HerdrDrawerTab } from '../herdrView.js';
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
  toggleProjectKey,
  writeSidebarPrefs,
} from '../sidebarPrefs.js';
import { useCompanyState } from '../useCompanyState.js';
import { useMediaQuery } from '../useMediaQuery.js';
import { useSessionLogBackfill } from '../useSessionLogBackfill.js';
import { AgentContextMenu } from './AgentContextMenu.js';
import { AgentRail } from './AgentRail.js';
import { AgentSidebar } from './AgentSidebar.js';
import { AttentionBar } from './AttentionBar.js';
import { BoardTopBar } from './BoardTopBar.js';
import { CompanyBoard } from './CompanyBoard.js';
import { DetailDrawer } from './DetailDrawer.js';
import { PromptComposer } from './PromptComposer.js';
import { TerminalPreviewProvider } from './TerminalPreview.js';

/**
 * The webview's localStorage, or null when the host refuses access to it. A
 * refused store means the sidebar and the drawer simply do not remember their shape.
 */
function browserStorage(): Storage | null {
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
  const [prefs, setPrefs] = useState<SidebarPrefs>(() => readSidebarPrefs(browserStorage()));
  const [drawerPrefs, setDrawerPrefs] = useState<DrawerPrefs>(() =>
    readDrawerPrefs(browserStorage()),
  );
  const [herdrTab, setHerdrTab] = useState<HerdrDrawerTab>('screen');
  const [menu, setMenu] = useState<(AgentMenuRequest & { token: number }) | null>(null);
  // Each open gets a new token, so the menu remounts and starts from its first view.
  const openMenu = useCallback((request: AgentMenuRequest) => {
    setMenu((current) => ({ ...request, token: (current?.token ?? 0) + 1 }));
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);
  const overlay = useMediaQuery(`(max-width: ${COMPANY_SIDEBAR_OVERLAY_MAX_PX}px)`);
  // The width the sidebar (or its rail) takes in the row beside the board; an open sidebar that floats takes none.
  let sidebarFootprint = prefs.width;
  if (prefs.collapsed) {
    sidebarFootprint = COMPANY_RAIL_WIDTH_PX;
  } else if (overlay) {
    sidebarFootprint = 0;
  }
  const collapsedProjects = useMemo(
    () => new Set(prefs.collapsedProjects),
    [prefs.collapsedProjects],
  );

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

  // The sidebar's and the drawer's shapes are remembered across reloads, so each
  // is written whenever it changes. A refused store only means it is not remembered.
  useEffect(() => {
    writeSidebarPrefs(browserStorage(), prefs);
  }, [prefs]);
  useEffect(() => {
    writeDrawerPrefs(browserStorage(), drawerPrefs);
  }, [drawerPrefs]);

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

  function toggleProject(key: string): void {
    setPrefs((current) => ({
      ...current,
      collapsedProjects: toggleProjectKey(current.collapsedProjects, key),
    }));
  }

  function selectSession(sessionId: string): void {
    setOpened(null);
    client.select(selectionForSession(state, sessionId));
  }

  function selectTask(taskId: string): void {
    setOpened(null);
    client.select(selectionForTask(state, taskId));
  }

  function openHerdr(paneId: string, tab: HerdrDrawerTab = 'screen'): void {
    setOpened({ kind: 'herdr', paneId });
    setHerdrTab(tab);
  }

  function openSessionTab(sessionId: string, tab: SessionMenuTab): void {
    setOpened(null);
    client.select({ ...selectionForSession(state, sessionId), tab });
  }

  /** Switch the board to another folder; the session is selected once that folder's snapshot holds it. */
  function selectWorkspaceSession(path: string, sessionId: string): void {
    setOpened(null);
    client.openWorkspaceSession(path, sessionId);
  }

  function openContract(contractId: string | null): void {
    setOpened({ kind: 'contract', contractId });
  }

  function closeDrawer(): void {
    setOpened(null);
    client.select({ sessionId: null, taskId: null, tab: null });
  }

  function toggleFiles(): void {
    setOpened((current) => (current?.kind === 'files' ? null : { kind: 'files' }));
  }

  function toggleDrawerMaximized(): void {
    setDrawerPrefs((current) => ({ ...current, maximized: !current.maximized }));
  }

  const boardAreaRef = useRef<HTMLDivElement>(null);

  return (
    <div
      className="company-ui flex h-full w-full flex-col overflow-hidden bg-bg"
      data-testid="company-workspace"
    >
      <BoardTopBar
        state={state}
        client={client}
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
      {state.workspaceSelectionNotice !== null && (
        <p
          role="status"
          data-testid="workspace-selection-notice"
          className="border-b border-warning px-3 py-1 text-2xs text-warning"
        >
          {state.workspaceSelectionNotice}
        </p>
      )}
      <AttentionBar
        contract={pendingContract(state)}
        questions={pendingQuestions}
        onOpenContract={() => openContract(null)}
        onOpenQuestion={(questionId) => setOpened({ kind: 'question', questionId })}
      />
      <TerminalPreviewProvider
        client={client}
        state={state}
        drawerSubject={subject}
        boardAreaRef={boardAreaRef}
      >
        <div ref={boardAreaRef} className="relative flex min-h-0 flex-1 overflow-hidden">
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
              collapsedProjects={collapsedProjects}
              onExpand={toggleSidebar}
              onSelectSession={selectSession}
              onSelectWorkspaceSession={selectWorkspaceSession}
              onOpenHerdr={openHerdr}
              onToggleProject={toggleProject}
              onMenu={openMenu}
            />
          ) : (
            <AgentSidebar
              client={client}
              state={state}
              selectedSessionId={selectedSessionId}
              selectedPaneId={selectedPaneId}
              width={prefs.width}
              overlay={overlay}
              collapsedProjects={collapsedProjects}
              onWidthChange={(width) =>
                setPrefs((current) => ({ ...current, width: clampSidebarWidth(width) }))
              }
              onCollapse={toggleSidebar}
              onSelectSession={selectSession}
              onSelectWorkspaceSession={selectWorkspaceSession}
              onOpenHerdr={openHerdr}
              onToggleProject={toggleProject}
              onMenu={openMenu}
            />
          )}
          <CompanyBoard
            lanes={lanes}
            flow={boardFlow(lanes, state.settings?.maxWorkers ?? null)}
            planning={planningPrompts(state)}
            onSelectSession={selectSession}
            onSelectTask={selectTask}
            onOpenHerdr={openHerdr}
            selectedPaneId={selectedPaneId}
            selectedSessionId={selectedSessionId}
            onMenu={openMenu}
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
            herdrTab={herdrTab}
            onHerdrTab={setHerdrTab}
            prefs={drawerPrefs}
            onPrefsChange={setDrawerPrefs}
            sidebarWidth={sidebarFootprint}
            onMenu={openMenu}
          />
        </div>
      </TerminalPreviewProvider>
      <PromptComposer client={client} />
      {menu !== null && (
        <AgentContextMenu
          key={menu.token}
          client={client}
          state={state}
          request={menu}
          onClose={closeMenu}
          onSessionTab={openSessionTab}
          onHerdrTab={openHerdr}
          onSelectTask={selectTask}
          onSelectSession={selectSession}
          onOpenContract={openContract}
          onToggleMaximize={toggleDrawerMaximized}
          onToggleProject={toggleProject}
        />
      )}
    </div>
  );
}
