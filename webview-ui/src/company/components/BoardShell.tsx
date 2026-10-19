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

import type { AgentMenuRequest } from '../agentMenu.js';
import { boardFlow, buildBoardLanes, planningPrompts } from '../boardView.js';
import { buildPaletteItems, type PaletteActionId, type PaletteItem } from '../commandPalette.js';
import type { CompanyClient } from '../companyClient.js';
import type { CompanyDrawerTab, CompanyViewState } from '../companyState.js';
import { startNewChat } from '../composerRouting.js';
import { COMPANY_RAIL_WIDTH_PX } from '../constants.js';
import { type DrawerPrefs, readDrawerPrefs, writeDrawerPrefs } from '../drawerPrefs.js';
import { readDrawerTabPrefs, writeDrawerTabPrefs } from '../drawerTabPrefs.js';
import { folderIdentityOf, foldersWaitingForSnapshot, showsAllFolders } from '../folderIdentity.js';
import type { FolderFocusInput } from '../folderView.js';
import type { HerdrDrawerTab } from '../herdrView.js';
import { sidebarPresentation } from '../layoutMode.js';
import { ledgerStore } from '../ledger/ledgerClient.js';
import { panesOf } from '../ledger/ledgerManagers.js';
import { boardSessionIndex } from '../ledger/ledgerMapping.js';
import { useLedgerState } from '../ledger/ledgerStore.js';
import { LedgerView } from '../ledger/LedgerView.js';
import { startScrollFades } from '../scrollFades.js';
import {
  type DrawerSubject,
  drawerSubjectFor,
  type OpenedSubject,
  pendingContract,
  selectionForSession,
  selectionForTask,
} from '../selection.js';
import { findShortcutId, matchShortcut } from '../shortcuts.js';
import {
  clampSidebarWidth,
  isTypingTarget,
  readSidebarPrefs,
  type SidebarPrefs,
  toggleProjectKey,
  writeSidebarPrefs,
} from '../sidebarPrefs.js';
import { useCompanyState } from '../useCompanyState.js';
import { useLayoutMode } from '../useLayoutMode.js';
import { useSessionLogBackfill } from '../useSessionLogBackfill.js';
import { openUsagePage } from '../useUsageRoute.js';
import { AgentContextMenu } from './AgentContextMenu.js';
import { AgentRail } from './AgentRail.js';
import { AgentSidebar } from './AgentSidebar.js';
import { AttentionBar } from './AttentionBar.js';
import { BoardTopBar } from './BoardTopBar.js';
import { CommandPalette } from './CommandPalette.js';
import { CompanyBoard } from './CompanyBoard.js';
import { DetailDrawer } from './DetailDrawer.js';
import { PromptComposer } from './PromptComposer.js';
import { ShortcutsSheet } from './ShortcutsSheet.js';
import { TerminalPreviewProvider } from './TerminalPreview.js';
import { WorkDialogHost, type WorkDialogRequest } from './WorkDialogHost.js';

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

/** Apple platforms show ⌘ in shortcut hints; elsewhere the key names stay. */
const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform);

/**
 * The words of the snapshot banner. In all mode it names the folders still waiting for a fresh
 * snapshot, so the reader knows which folder's board may be behind.
 */
function snapshotNoticeText(state: CompanyViewState): string {
  const waiting = showsAllFolders(state) ? foldersWaitingForSnapshot(state) : [];
  if (waiting.length === 0) {
    return 'Có thay đổi đã bị bỏ sót; đang chờ một bản chụp mới từ máy chủ.';
  }
  return `Có thay đổi đã bị bỏ sót ở ${waiting.join(', ')}; đang chờ một bản chụp mới từ máy chủ.`;
}

export interface BoardShellProps {
  client: CompanyClient;
}

export function BoardShell({ client }: BoardShellProps) {
  const state = useCompanyState(client);
  useSessionLogBackfill(client, state);
  const ledger = useLedgerState(ledgerStore);
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const ledgerShown = ledgerOpen && ledger.privileged === true;
  const ledgerAvailable = ledger.privileged === true;
  const [opened, setOpened] = useState<OpenedSubject | null>(null);
  const [artifactId, setArtifactId] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<SidebarPrefs>(() => readSidebarPrefs(browserStorage()));
  // A phone's sidebar sheet starts closed and is not remembered; other layouts keep the saved pref.
  const [sheetOpen, setSheetOpen] = useState(false);
  const [drawerPrefs, setDrawerPrefs] = useState<DrawerPrefs>(() =>
    readDrawerPrefs(browserStorage()),
  );
  const [tabPrefs, setTabPrefs] = useState(() => readDrawerTabPrefs(browserStorage()));
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [browseRequest, setBrowseRequest] = useState(0);
  const [herdrTab, setHerdrTab] = useState<HerdrDrawerTab>('screen');
  const [menu, setMenu] = useState<(AgentMenuRequest & { token: number }) | null>(null);
  // Each open gets a new token, so the menu remounts and starts from its first view.
  const openMenu = useCallback((request: AgentMenuRequest) => {
    setMenu((current) => ({ ...request, token: (current?.token ?? 0) + 1 }));
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [workDialog, setWorkDialog] = useState<WorkDialogRequest | null>(null);
  const mode = useLayoutMode();
  const sidebarCollapsed = mode === 'phone' ? !sheetOpen : prefs.collapsed;
  const sidebar = sidebarPresentation(mode, sidebarCollapsed);
  // The width the sidebar (or its rail) takes in the row beside the board. A sidebar that
  // floats over the board, or is a phone's sheet, takes none.
  let sidebarFootprint = 0;
  if (sidebar === 'docked') {
    sidebarFootprint = prefs.width;
  } else if (sidebar === 'rail') {
    sidebarFootprint = COMPANY_RAIL_WIDTH_PX;
  }
  const collapsedProjects = useMemo(
    () => new Set(prefs.collapsedProjects),
    [prefs.collapsedProjects],
  );

  const lanes = useMemo(() => buildBoardLanes(state), [state]);
  const ledgerBoardSessions = useMemo(() => boardSessionIndex(state.sessions), [state.sessions]);
  const ledgerPanes = useMemo(
    () => panesOf(state.herdr.agents, state.herdr.sleeping),
    [state.herdr.agents, state.herdr.sleeping],
  );
  // The folder rules' input for the Cây git view: folder mode scopes it to the folder in view.
  const ledgerFocus = useMemo<FolderFocusInput>(
    () => ({ viewMode: state.viewMode, focusPath: state.focusPath, workspaces: state.workspaces }),
    [state.viewMode, state.focusPath, state.workspaces],
  );
  const pendingQuestions = useMemo(
    () => Object.values(state.questions).filter((question) => question.status === 'pending'),
    [state.questions],
  );

  // The palette's rows are built only while it is open: file listings can run long.
  const paletteItems = useMemo(
    () =>
      paletteOpen
        ? buildPaletteItems(state, {
            activePath: state.settings?.workspacePath ?? null,
            folders: (state.workspaces ?? []).map((entry) => entry.path),
          })
        : [],
    [paletteOpen, state],
  );
  const subject: DrawerSubject | null = drawerSubjectFor(state, opened);
  // A phone's full-screen drawer that has an input of its own (a sleeping pane, a question)
  // takes the place of the board composer, so each screen has one input. A herdr pane has
  // none: the board composer is how a prompt reaches it, on a phone as everywhere else.
  const composerHidden =
    mode === 'phone' && (subject?.kind === 'sleeping' || subject?.kind === 'question');
  const selectedSessionId =
    subject?.kind === 'session' || subject?.kind === 'task' ? state.selection.sessionId : null;
  const selectedPaneId =
    subject?.kind === 'herdr' || subject?.kind === 'sleeping' ? subject.paneId : null;
  const selectedWorkItem =
    subject?.kind === 'workItem' ? { id: subject.id, workspacePath: subject.workspacePath } : null;

  // Diagnostics are a live measurement of processes the user owns: asked for
  // once the board is on screen, never polled in the background.
  useEffect(() => {
    client.requestDiagnostics();
  }, [client]);

  // Scroll areas draw no scrollbar; an edge with more content beyond it fades instead.
  useEffect(() => startScrollFades(), []);

  // The sidebar's and the drawer's shapes are remembered across reloads, so each
  // is written whenever it changes. A refused store only means it is not remembered.
  useEffect(() => {
    writeSidebarPrefs(browserStorage(), prefs);
  }, [prefs]);
  useEffect(() => {
    writeDrawerPrefs(browserStorage(), drawerPrefs);
  }, [drawerPrefs]);

  useEffect(() => {
    writeDrawerTabPrefs(browserStorage(), tabPrefs);
  }, [tabPrefs]);

  // Board shortcuts come from the registry. Keys pressed inside a terminal belong to the
  // shell, so none of them fire there; the palette key still works from a text field.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest('.xterm')) return;
      const id = findShortcutId(event, { typing: isTypingTarget(target), groups: ['board'] });
      if (id === 'board.palette') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (id === 'board.sidebar') {
        event.preventDefault();
        setPrefs((current) => ({ ...current, collapsed: !current.collapsed }));
      } else if (id === 'board.help') {
        event.preventDefault();
        setShortcutsOpen(true);
      } else if (id === 'board.files') {
        event.preventDefault();
        setOpened((current) => (current?.kind === 'files' ? null : { kind: 'files' }));
      } else if (id === 'board.ledger' && ledgerAvailable) {
        event.preventDefault();
        setLedgerOpen((open) => !open);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [ledgerAvailable]);

  function toggleSidebar(): void {
    if (mode === 'phone') {
      setSheetOpen((open) => !open);
      return;
    }
    setPrefs((current) => ({ ...current, collapsed: !current.collapsed }));
  }

  function toggleProject(key: string): void {
    setPrefs((current) => ({
      ...current,
      collapsedProjects: toggleProjectKey(current.collapsedProjects, key),
    }));
  }

  // On a phone the sidebar is a sheet over the lanes; picking an agent closes it so its drawer shows.
  function dismissSheet(): void {
    if (mode !== 'phone') return;
    setSheetOpen(false);
  }

  // On a phone the open sheet closes on Escape, as a modal does.
  useEffect(() => {
    if (mode !== 'phone' || !sheetOpen) return;
    function onKey(event: KeyboardEvent): void {
      if (matchShortcut('board.escape', event)) setSheetOpen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mode, sheetOpen]);

  function selectSession(sessionId: string): void {
    setOpened(null);
    dismissSheet();
    client.select(selectionForSession(state, sessionId));
  }

  function selectTask(taskId: string): void {
    setOpened(null);
    dismissSheet();
    client.select(selectionForTask(state, taskId));
  }

  function openHerdr(paneId: string, tab: HerdrDrawerTab = 'screen'): void {
    setOpened({ kind: 'herdr', paneId });
    setHerdrTab(tab);
    client.select({ herdrPaneId: paneId });
    dismissSheet();
  }

  function openSleeping(paneId: string): void {
    setOpened({ kind: 'sleeping', paneId });
    dismissSheet();
  }

  function openSessionTab(sessionId: string, tab: CompanyDrawerTab): void {
    setOpened(null);
    setTabPrefs({ session: tab });
    client.select({ ...selectionForSession(state, sessionId), tab });
  }

  /** Switch the board to another folder; the session is selected once that folder's snapshot holds it. */
  function selectWorkspaceSession(path: string, sessionId: string): void {
    setOpened(null);
    dismissSheet();
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

  /** Runs the row the palette chose: select a session, task or agent, switch folder, or act. */
  function runPaletteItem(item: PaletteItem): void {
    setPaletteOpen(false);
    const target = item.target;
    switch (target.kind) {
      case 'action':
        runPaletteAction(target.action);
        return;
      case 'session':
        selectSession(target.sessionId);
        return;
      case 'task':
        selectTask(target.taskId);
        return;
      case 'herdr':
        openHerdr(target.paneId);
        return;
      case 'sleeping':
        openSleeping(target.paneId);
        return;
      case 'folder':
        if (target.path !== state.settings?.workspacePath) client.openWorkspace(target.path);
        return;
      case 'file':
        // The Tệp drawer opens; the chosen path is not yet passed to its browser.
        setOpened({ kind: 'files' });
        return;
    }
  }

  function runPaletteAction(action: PaletteActionId): void {
    switch (action) {
      case 'new-chat':
        startNewChat(client);
        return;
      case 'open-agents':
        if (mode === 'phone') setSheetOpen(true);
        else setPrefs((current) => ({ ...current, collapsed: false }));
        return;
      case 'open-git-tree':
        if (ledger.privileged === true) setLedgerOpen(true);
        return;
      case 'open-files':
        setOpened({ kind: 'files' });
        return;
      case 'open-folder':
        setBrowseRequest((count) => count + 1);
        return;
      case 'open-usage':
        openUsagePage();
        return;
      case 'show-shortcuts':
        setShortcutsOpen(true);
        return;
    }
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
        sidebarCollapsed={sidebarCollapsed}
        mode={mode}
        onToggleSidebar={toggleSidebar}
        filesOpen={opened?.kind === 'files'}
        onToggleFiles={toggleFiles}
        ledgerAvailable={ledgerAvailable}
        ledgerOpen={ledgerShown}
        onToggleLedger={() => setLedgerOpen((open) => !open)}
        isMac={IS_MAC}
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        onOpenUsage={openUsagePage}
        browseRequest={browseRequest}
      />
      {state.needsSnapshot && (
        <p className="bg-warning/12 px-3 py-1.5 text-2xs text-warning">
          {snapshotNoticeText(state)}
        </p>
      )}
      {state.workspaceSelectionNotice !== null && (
        <p
          role="status"
          data-testid="workspace-selection-notice"
          className="bg-warning/12 px-3 py-1.5 text-2xs text-warning"
        >
          {state.workspaceSelectionNotice}
        </p>
      )}
      <AttentionBar
        contract={pendingContract(state)}
        questions={pendingQuestions}
        identityOf={(id) => folderIdentityOf(state, id)}
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
          {(sidebar === 'overlay' || sidebar === 'sheet') && (
            <button
              type="button"
              aria-label={sidebar === 'sheet' ? 'Đóng đàn agent' : 'Thu gọn đàn agent'}
              onClick={sidebar === 'sheet' ? dismissSheet : toggleSidebar}
              className={`${sidebar === 'sheet' ? 'fixed z-30' : 'absolute z-20'} inset-0 cursor-default bg-black/40`}
            />
          )}
          {sidebar === 'rail' && (
            <AgentRail
              state={state}
              selectedSessionId={selectedSessionId}
              selectedPaneId={selectedPaneId}
              collapsedProjects={collapsedProjects}
              onExpand={toggleSidebar}
              onSelectSession={selectSession}
              onSelectWorkspaceSession={selectWorkspaceSession}
              onOpenHerdr={openHerdr}
              onOpenSleeping={openSleeping}
              onToggleProject={toggleProject}
              onMenu={openMenu}
            />
          )}
          {(sidebar === 'docked' || sidebar === 'overlay' || sidebar === 'sheet') && (
            <AgentSidebar
              client={client}
              state={state}
              selectedSessionId={selectedSessionId}
              selectedPaneId={selectedPaneId}
              width={prefs.width}
              presentation={sidebar}
              collapsedProjects={collapsedProjects}
              onWidthChange={(width) =>
                setPrefs((current) => ({ ...current, width: clampSidebarWidth(width) }))
              }
              onCollapse={toggleSidebar}
              onSelectSession={selectSession}
              onSelectWorkspaceSession={selectWorkspaceSession}
              onOpenHerdr={openHerdr}
              onOpenSleeping={openSleeping}
              onToggleProject={toggleProject}
              onMenu={openMenu}
              onDismiss={dismissSheet}
            />
          )}
          {ledgerShown ? (
            <LedgerView
              boardSessions={ledgerBoardSessions}
              focus={ledgerFocus}
              onOpenBoardSession={selectSession}
              panes={ledgerPanes}
              onOpenHerdr={openHerdr}
              onOpenSleeping={openSleeping}
              onClose={() => setLedgerOpen(false)}
            />
          ) : (
            <CompanyBoard
              lanes={lanes}
              flow={boardFlow(lanes, state.settings?.maxWorkers ?? null)}
              planning={planningPrompts(state)}
              onSelectSession={selectSession}
              onSelectTask={selectTask}
              onOpenHerdr={openHerdr}
              selectedPaneId={selectedPaneId}
              selectedSessionId={selectedSessionId}
              selectedWorkItem={selectedWorkItem}
              onOpenWorkItem={(ref) => setOpened({ kind: 'workItem', ...ref })}
              onMenu={openMenu}
              identityOf={(id) => folderIdentityOf(state, id)}
            />
          )}
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
            sessionTab={tabPrefs.session}
            onSessionTab={(tab) => setTabPrefs({ session: tab })}
            prefs={drawerPrefs}
            onPrefsChange={setDrawerPrefs}
            sidebarWidth={sidebarFootprint}
            onMenu={openMenu}
          />
        </div>
      </TerminalPreviewProvider>
      {!composerHidden && <PromptComposer client={client} />}
      {paletteOpen && (
        <CommandPalette
          items={paletteItems}
          onRun={runPaletteItem}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {shortcutsOpen && <ShortcutsSheet isMac={IS_MAC} onClose={() => setShortcutsOpen(false)} />}
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
          onWorkDialog={setWorkDialog}
        />
      )}
      <WorkDialogHost
        client={client}
        state={state}
        request={workDialog}
        onClose={() => setWorkDialog(null)}
      />
    </div>
  );
}
