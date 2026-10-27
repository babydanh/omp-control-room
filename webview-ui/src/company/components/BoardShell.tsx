/**
 * BoardShell: the whole Company surface, a full-screen board for runs on OMP.
 *
 * It owns the state the surfaces share: the subject the drawer shows, the artifact
 * a file view opened, the remembered shapes of the sidebar and the drawer, the
 * herdr tab, the folds of the project tree, and the one context menu. Every
 * action a row, card, drawer header or project header offers lives in that
 * menu; the surfaces keep only their content controls.
 */

import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ProjectTreeNode } from '../../../../core/src/messages.js';
import type { AgentMenuRequest, ProjectNodeAction, WorkItemMenuAction } from '../agentMenu.js';
import { boardFlow, buildBoardLanes, planningPrompts } from '../boardView.js';
import { buildPaletteItems, type PaletteActionId, type PaletteItem } from '../commandPalette.js';
import type { CompanyClient } from '../companyClient.js';
import type { CompanyDrawerTab, CompanyViewState } from '../companyState.js';
import { startNewChat } from '../composerRouting.js';
import {
  COMPANY_NAV_MOBILE_MAX_PX,
  COMPANY_PAGE_TRANSITION_MS,
  COMPANY_RAIL_WIDTH_PX,
} from '../constants.js';
import { type DrawerPrefs, readDrawerPrefs, writeDrawerPrefs } from '../drawerPrefs.js';
import { readDrawerTabPrefs, writeDrawerTabPrefs } from '../drawerTabPrefs.js';
import { folderIdentityOf, foldersWaitingForSnapshot, showsAllFolders } from '../folderIdentity.js';
import { openPickedFolder, pickFolder } from '../folderPick.js';
import { folderBasename, type FolderFocusInput } from '../folderView.js';
import type { HerdrDrawerTab } from '../herdrView.js';
import type { IconName } from '../iconNames.js';
import { sidebarPresentation } from '../layoutMode.js';
import { ledgerStore } from '../ledger/ledgerClient.js';
import { panesOf } from '../ledger/ledgerManagers.js';
import { boardSessionIndex } from '../ledger/ledgerMapping.js';
import { useLedgerState } from '../ledger/ledgerStore.js';
import { LedgerView } from '../ledger/LedgerView.js';
import { AccountsPage } from '../library/AccountsPage.js';
import { McpPage } from '../library/McpPage.js';
import { SkillsPage } from '../library/SkillsPage.js';
import { StoragePage } from '../library/StoragePage.js';
import { ChangesPage } from '../projects/ChangesPage.js';
import { LayeredSettingsDialog } from '../projects/LayeredSettingsDialog.js';
import { NewSessionDialog } from '../projects/NewSessionDialog.js';
import { projectStore } from '../projects/projectClient.js';
import {
  ancestorOf,
  checkoutPathFor,
  engineForAction,
  paneCheckouts,
  type ProjectSessionEngine,
  sessionChanges,
} from '../projects/projectNodeTargets.js';
import { useProjectState } from '../projects/projectStore.js';
import { isEndedNode } from '../projects/projectTreeView.js';
import { COMPANY_ROLES, roleProfile } from '../roleProfiles.js';
import { startScrollFades } from '../scrollFades.js';
import {
  type DrawerSubject,
  drawerSubjectFor,
  herdrPaneHidden,
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
import { closeUsagePage, openUsagePage, useUsageRoute } from '../useUsageRoute.js';
import { workItemCardTarget, workItemsOf } from '../workItemView.js';
import { AgentContextMenu } from './AgentContextMenu.js';
import { AgentRail } from './AgentRail.js';
import { AgentSidebar } from './AgentSidebar.js';
import { AttentionBar } from './AttentionBar.js';
import { BoardTopBar } from './BoardTopBar.js';
import { CommandPalette } from './CommandPalette.js';
import { CompanyBoard } from './CompanyBoard.js';
import { DetailDrawer } from './DetailDrawer.js';
import { Icon } from './Icon.js';
import { PromptComposer } from './PromptComposer.js';
import { RolesDialog } from './RolesDialog.js';
import { ShortcutsSheet } from './ShortcutsSheet.js';
import { TerminalPreviewProvider } from './TerminalPreview.js';
import { UsagePage } from './usage/UsagePage.js';
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

type ShellPage = 'board' | 'ledger' | 'usage' | 'storage' | 'skills' | 'mcp' | 'accounts' | 'changes';

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

/** How a project create ended: made (with the new Project's id when the server named it), or refused and why. */
type ProjectCreateOutcome = { readonly nodeId: string | undefined } | { readonly refusal: string };

/**
 * Waits until the project create `requestId` is answered (or failed to send). A create that a
 * newer one replaced before its answer came reads as made, with no id: the newer one reports.
 * Executor form: the ES2022 lib has no Promise.withResolvers.
 */
function projectCreateOutcome(requestId: string): Promise<ProjectCreateOutcome> {
  return new Promise((resolve) => {
    const settle = (): void => {
      const state = projectStore.getSnapshot();
      if (state.pending[requestId] !== undefined) return;
      unsubscribe();
      const result = state.results[requestId];
      if (result?.type === 'projectCommandResult' && result.ok) {
        resolve({ nodeId: result.nodeId });
        return;
      }
      const reason = (result?.type === 'projectCommandResult' ? result.reason : undefined) || state.errors['command:create'];
      resolve(reason ? { refusal: reason } : { nodeId: undefined });
    };
    const unsubscribe = projectStore.subscribe(settle);
    settle();
  });
}

/** The Project already holding `folderPath`, if any: a refused create shows where that folder is. */
function projectHoldingFolder(nodes: readonly ProjectTreeNode[], folderPath: string): string | undefined {
  const key = (value: string): string => value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const folder = nodes.find((node) => node.kind === 'folder' && node.path !== undefined && key(node.path) === key(folderPath));
  return folder === undefined ? undefined : ancestorOf(nodes, folder, 'project')?.id;
}

/** What a click on an exited session says: it has no pane left, and how to bring it back. */
function endedSessionNotice(session: ProjectTreeNode, id: string): string {
  if (session.engine === 'claude') return `Phiên ${session.name} đã tắt. Mở lại trong terminal ở thư mục của nó: claude --resume ${id}`;
  if (session.engine === 'omp') return `Phiên ${session.name} đã tắt. Mở omp ở thư mục của nó rồi gõ /resume để chọn lại phiên.`;
  return `Phiên ${session.name} đã tắt, không còn khung nào để mở.`;
}

export interface BoardShellProps {
  client: CompanyClient;
}

export function BoardShell({ client }: BoardShellProps) {
  const projects = useProjectState(projectStore);
  const paneCheckout = useMemo(() => paneCheckouts(projects.nodes), [projects.nodes]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [projectSettingsNode, setProjectSettingsNode] = useState<string | null>(null);
  const [newSessionNode, setNewSessionNode] = useState<{ nodeId: string; engine?: ProjectSessionEngine } | null>(null);
  const [selectedCheckoutId, setSelectedCheckoutId] = useState('');
  const [changesTab, setChangesTab] = useState<'diff' | 'merge' | 'compare'>('diff');
  const [compareBranchA, setCompareBranchA] = useState('');
  const state = useCompanyState(client);
  useSessionLogBackfill(client, state);
  const ledger = useLedgerState(ledgerStore);
  const usageRouteOpen = useUsageRoute();
  const [activePage, setActivePage] = useState<ShellPage>(() => usageRouteOpen ? 'usage' : 'board');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mobileViewport, setMobileViewport] = useState(
    () => window.matchMedia(`(max-width: ${COMPANY_NAV_MOBILE_MAX_PX}px)`).matches,
  );
  const ledgerShown = activePage === 'ledger' && ledger.privileged === true;
  const ledgerAvailable = ledger.privileged === true;
  const [opened, setOpened] = useState<OpenedSubject | null>(null);
  // Why a session clicked in the tree opened nothing: it runs outside herdr, so there is no pane.
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
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
  const [rolesOpen, setRolesOpen] = useState(false);
  const [herdrTab, setHerdrTab] = useState<HerdrDrawerTab>('screen');
  const [menu, setMenu] = useState<(AgentMenuRequest & { token: number }) | null>(null);
  // Each open gets a new token, so the menu remounts and starts from its first view.
  const openMenu = useCallback((request: AgentMenuRequest) => {
    setMenu((current) => ({ ...request, token: (current?.token ?? 0) + 1 }));
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);
  function runWorkItemMenuAction(
    ref: { id: string; workspacePath: string },
    action: WorkItemMenuAction,
  ): void {
    setOpened({ kind: 'workItem', ...ref });
    if (action === 'open') return;
    setWorkItemAction((current) => ({
      ref,
      action,
      token: (current?.token ?? 0) + 1,
    }));
  }
  const [workDialog, setWorkDialog] = useState<WorkDialogRequest | null>(null);
  const [workItemAction, setWorkItemAction] = useState<{
    ref: { id: string; workspacePath: string };
    action: Exclude<WorkItemMenuAction, 'open'>;
    token: number;
  } | null>(null);
  const mode = useLayoutMode();

  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${COMPANY_NAV_MOBILE_MAX_PX}px)`);
    const update = () => setMobileViewport(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (usageRouteOpen) setActivePage('usage');
    else setActivePage((page) => page === 'usage' ? 'board' : page);
  }, [usageRouteOpen]);

  useEffect(() => {
    if (!ledgerAvailable && activePage === 'ledger') setActivePage('board');
  }, [activePage, ledgerAvailable]);

  useEffect(() => {
    if (!mobileNavOpen || !mobileViewport) return undefined;
    function closeOnEscape(event: KeyboardEvent): void {
      if (matchShortcut('board.escape', event)) setMobileNavOpen(false);
    }
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [mobileNavOpen, mobileViewport]);

  function selectPage(page: ShellPage): void {
    if (page === 'usage') {
      if (!usageRouteOpen) openUsagePage();
    } else if (usageRouteOpen) {
      closeUsagePage();
    }
    if (page !== 'board' && page !== 'usage' && !ledgerAvailable) return;
    setActivePage(page);
    setMobileNavOpen(false);
    setOpened(null);
  }

  function toggleActiveLedgerPage(): void {
    selectPage(activePage === 'ledger' ? 'board' : 'ledger');
  }
  // The keydown listener below is registered once per ledger availability; it reads the
  // current toggle through this ref so it never acts on a stale active page.
  const toggleLedgerRef = useRef(toggleActiveLedgerPage);
  toggleLedgerRef.current = toggleActiveLedgerPage;
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
  const squadPath = state.settings?.workspacePath ?? null;
  const squadFolder =
    squadPath === null
      ? null
      : {
          workspacePath: squadPath,
          settings: workItemsOf(state, squadPath).settings,
          claudeStatus: workItemsOf(state, squadPath).claudeStatus,
          claudeMcpServers: workItemsOf(state, squadPath).claudeMcpServers,
        };
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
  // The Project tree's folders: Cây git narrows to one of them, or to all of them.
  const ledgerFolders = useMemo(
    () => projects.nodes.flatMap((node) => (node.kind === 'folder' && node.path !== undefined ? [{ name: node.name, path: node.path }] : [])),
    [projects.nodes],
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
  const selectedSquad =
    subject?.kind === 'squad'
      ? { runId: subject.runId, workspacePath: subject.workspacePath }
      : null;
  // A folder switch settles the selection and drops a pane picked a moment before it landed, which
  // left the drawer showing the pane while the composer had nowhere to send. Pick it again, only
  // while nothing else is selected, so a session the user chose since is never overridden.
  const selectionEmpty =
    state.selection.herdrPaneId === null && state.selection.sessionId === null && state.selection.taskId === null;
  useEffect(() => {
    if (selectedPaneId !== null && selectionEmpty) client.select({ herdrPaneId: selectedPaneId });
  }, [client, selectedPaneId, selectionEmpty]);
  // A wake answers with the pane the session now runs in and picks it. The drawer still shows the
  // sleep record, which the wake removed ("không còn trong herdr"): turn it to that pane's screen.
  const pickedPane = state.selection.herdrPaneId;
  useEffect(() => {
    if (opened?.kind !== 'sleeping' || pickedPane === null || pickedPane === opened.paneId) return;
    setOpened({ kind: 'herdr', paneId: pickedPane, starting: true });
    setHerdrTab('screen');
  }, [opened, pickedPane]);

  // Diagnostics are a live measurement of processes the user owns: asked for
  // once the board is on screen, never polled in the background.
  useEffect(() => {
    if (activePage === 'board') client.requestDiagnostics();
  }, [activePage, client]);

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
        toggleLedgerRef.current();
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

  // On a phone the open sheet closes on Escape, as a modal does, unless the roles dialog is open.
  useEffect(() => {
    if (mode !== 'phone' || !sheetOpen || rolesOpen) return;
    function onKey(event: KeyboardEvent): void {
      if (matchShortcut('board.escape', event)) setSheetOpen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mode, sheetOpen, rolesOpen]);

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

  function openProjectChanges(checkoutPath: string, tab: 'diff' | 'merge' | 'compare' = 'diff', branchA = ''): void {
    setSelectedCheckoutId(checkoutPath);
    setChangesTab(tab);
    setCompareBranchA(branchA);
    if (tab !== 'compare') projectStore.requestDiff({ checkout: checkoutPath, scope: 'uncommitted', sha: '' });
    selectPage('changes');
  }

  function openProjectSettings(nodeId: string | null): void {
    setProjectSettingsNode(nodeId);
    projectStore.requestSettings(nodeId ?? undefined);
  }

  /**
   * A board session opens in the drawer, a session in a herdr pane (a herdr row, or a
   * ledger session herdr reports) in that pane's terminal. A session with neither (a Claude or
   * agy run in a terminal of its own) has no pane to open or type into: the board says so.
   */
  function openProjectSession(session: ProjectTreeNode, where: { readonly folderPath?: string }): void {
    const id = session.sessionId;
    if (id === undefined) return;
    setSessionNotice(null);
    // The tree names omp sessions by their native id; the server adds the board session behind one.
    const boardKey = session.boardSessionId ?? (state.sessions[id] !== undefined ? id : null);
    if (boardKey !== null && state.sessions[boardKey] !== undefined) selectSession(boardKey);
    else if (boardKey !== null && where.folderPath !== undefined) selectWorkspaceSession(where.folderPath, boardKey);
    else if (isEndedNode(session)) setSessionNotice(endedSessionNotice(session, id));
    else if (session.herdrPaneId !== undefined) openHerdr(revealPane(session.herdrPaneId, where));
    else if (session.agentKind === 'herdr' && session.state === 'sleeping') openSleeping(revealPane(id, where));
    else if (session.agentKind === 'herdr') openHerdr(revealPane(id, where));
    else if (session.engine === 'claude' || session.engine === 'agy') setSessionNotice(`Phiên ${session.name} chạy ngoài herdr (cửa sổ terminal riêng): board không mở hay gõ vào được. Gõ ở cửa sổ đang chạy nó, hoặc bấm "+ Phiên mới" để mở phiên trong herdr.`);
    else setSessionNotice(`Phiên ${session.name} không có khung nào để mở trên board lúc này.`);
  }

  /**
   * The folder view hides the panes of every other folder, even one the user just opened, so a
   * click on another folder's session in the tree showed nothing. Point the board at that folder,
   * as an omp session of another folder does; the pane shows once the switch lands.
   */
  function revealPane(paneId: string, where: { readonly folderPath?: string }): string {
    if (where.folderPath !== undefined && herdrPaneHidden(state, paneId)) client.openWorkspace(where.folderPath);
    return paneId;
  }

  /** Menu actions that leave the menu: pages and dialogs. Tree edits run in the menu itself. */
  function runProjectNodeAction(node: ProjectTreeNode, action: ProjectNodeAction): void {
    if (action === 'changes' || action === 'merge' || action === 'compare') {
      const checkout = checkoutPathFor(projects.nodes, node);
      if (checkout !== null) openProjectChanges(checkout, action === 'merge' ? 'merge' : action === 'compare' ? 'compare' : 'diff', node.branch ?? '');
      return;
    }
    if (action === 'settings') {
      openProjectSettings(node.id);
      return;
    }
    if (action === 'closeHerdr') {
      const paneId = node.herdrPaneId ?? (node.agentKind === 'herdr' ? node.sessionId : undefined);
      if (paneId !== undefined) client.herdrClose(paneId);
      return;
    }
    if (action === 'wake') {
      const paneId = node.herdrPaneId ?? node.sessionId;
      if (paneId !== undefined) client.herdrWake(paneId);
      return;
    }
    if (action === 'openSession') {
      const folderPath = ancestorOf(projects.nodes, node, 'folder')?.path;
      openProjectSession(node, folderPath === undefined ? {} : { folderPath });
      return;
    }
    if (action === 'newSession' || action === 'newSessionOmp' || action === 'newSessionClaude' || action === 'newSessionAgy') {
      const engine = engineForAction(action);
      setNewSessionNode({ nodeId: node.id, ...(engine === undefined ? {} : { engine }) });
    }
  }

  const globalOmpRoleModels = COMPANY_ROLES.flatMap((role) => {
    const profile = roleProfile(state, role);
    return profile === null
      ? []
      : [{ role, model: profile.requestedModel, ...(profile.thinking ? { thinking: profile.thinking } : {}) }];
  });

  function openHerdr(paneId: string, tab: HerdrDrawerTab = 'screen', starting = false): void {
    setOpened({ kind: 'herdr', paneId, ...(starting ? { starting: true } : {}) });
    setHerdrTab(tab);
    client.select({ herdrPaneId: paneId });
    dismissSheet();
  }

  function openSleeping(paneId: string): void {
    setOpened({ kind: 'sleeping', paneId });
    // The composer aims at it: a line sent there wakes the session with that line as its prompt.
    client.select({ herdrPaneId: paneId });
    dismissSheet();
  }

  /**
   * A work item card opens onto the agent that holds it, as a session row does: its live terminal
   * and log are what the user wants to see, whatever the item's status. The composer below talks
   * to that agent. An item no live agent holds (queued, run by Claude Code, or its herdr tab since
   * closed) opens the item's panel, which shows its result and history.
   */
  function openWorkItemCard(ref: { id: string; workspacePath: string }): void {
    const item = workItemsOf(state, ref.workspacePath).items.find((entry) => entry.id === ref.id);
    const target = workItemCardTarget(state, item);
    switch (target.kind) {
      case 'sleeping':
        openSleeping(target.paneId);
        return;
      case 'herdr':
        openHerdr(target.paneId);
        return;
      case 'session':
        openSessionTab(target.sessionId, 'terminal');
        return;
      case 'workspaceSession':
        selectWorkspaceSession(ref.workspacePath, target.sessionId);
        return;
      case 'panel':
        setOpened({ kind: 'workItem', ...ref });
    }
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
  function selectSquad(ref: { runId: string; workspacePath: string }): void {
    setOpened({ kind: 'squad', ...ref });
    dismissSheet();
  }

  function closeRemovedSquad(ref: { runId: string; workspacePath: string }): void {
    if (
      opened?.kind === 'squad' &&
      opened.runId === ref.runId &&
      opened.workspacePath === ref.workspacePath
    ) {
      closeDrawer();
    }
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

  /** "Tạo project": a folder chosen in Windows' dialog becomes a new Project, named after it and holding it. */
  async function createProjectFromPickedFolder(): Promise<void> {
    setSessionNotice(null);
    const picked = await pickFolder(client);
    if (picked === null) return;
    if ('notice' in picked) {
      setSessionNotice(picked.notice);
      return;
    }
    const name = folderBasename(picked.path) || picked.path;
    const requestId = projectStore.createNode({ kind: 'project', name, path: picked.path });
    const outcome = await projectCreateOutcome(requestId);
    // The new Project lands at the end of the list, out of sight: show it on its own.
    if ('refusal' in outcome) {
      const holder = projectHoldingFolder(projects.nodes, picked.path);
      if (holder !== undefined) setSelectedProjectId(holder);
      setSessionNotice(`Không tạo được project: ${outcome.refusal}`);
      return;
    }
    if (outcome.nodeId !== undefined) setSelectedProjectId(outcome.nodeId);
    setSessionNotice(`Đã tạo project ${name}. Bấm "Tất cả dự án" để xem lại mọi project.`);
  }

  /** "Mở thư mục…" in the palette: choose a folder in Windows' dialog and show it on the board. */
  async function openFolderFromPalette(): Promise<void> {
    setSessionNotice(null);
    const opened = await openPickedFolder(client);
    if (typeof opened === 'object') setSessionNotice(opened.notice);
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
        if (ledgerAvailable) selectPage('ledger');
        return;
      case 'open-files':
        setOpened({ kind: 'files' });
        return;
      case 'open-folder':
        void openFolderFromPalette();
        return;
      case 'open-roles':
        setRolesOpen(true);
        return;
      case 'open-usage':
        selectPage('usage');
        return;
      case 'show-shortcuts':
        setShortcutsOpen(true);
        return;
    }
  }

  const boardAreaRef = useRef<HTMLDivElement>(null);

  const navItems: { page: ShellPage; label: string; icon: IconName; group: string }[] = [
    { page: 'board', label: 'Bảng việc', icon: 'list', group: 'Không gian làm việc' },
    ...(ledgerAvailable
      ? [
          { page: 'ledger' as const, label: 'Cây git', icon: 'git-branch' as const, group: 'Không gian làm việc' },
          { page: 'changes' as const, label: 'Thay đổi', icon: 'file-text' as const, group: 'Không gian làm việc' },
        ]
      : []),
    { page: 'usage', label: 'Sử dụng', icon: 'bar-chart', group: 'Không gian làm việc' },
    ...(ledgerAvailable
      ? [
          { page: 'storage' as const, label: 'Lưu trữ', icon: 'archive' as const, group: 'Thư viện' },
          { page: 'skills' as const, label: 'Kho skill', icon: 'list' as const, group: 'Thư viện' },
          { page: 'mcp' as const, label: 'MCP', icon: 'terminal' as const, group: 'Thư viện' },
          { page: 'accounts' as const, label: 'Tài khoản', icon: 'users' as const, group: 'Cài đặt' },
        ]
      : []),
  ];

  /** The phone menu: one page per row, under its group's heading. */
  function renderNavItems() {
    let previousGroup = '';
    return navItems.map((item) => {
      const showGroup = item.group !== previousGroup;
      previousGroup = item.group;
      return (
        <div key={item.page} className="flex flex-col">
          {showGroup && (
            <p className="px-3 pb-1 pt-4 text-2xs font-medium uppercase tracking-wider text-text-muted">
              {item.group}
            </p>
          )}
          <button
            type="button"
            aria-current={activePage === item.page ? 'page' : undefined}
            onClick={() => selectPage(item.page)}
            className={`flex min-h-10 items-center gap-3 rounded-(--company-radius-sm) px-3 text-left text-sm transition-colors duration-150 hover:bg-hover motion-reduce:transition-none ${activePage === item.page ? 'bg-selected text-text' : 'text-text-secondary'}`}
          >
            <Icon name={item.icon} className="shrink-0" />
            <span className="truncate">{item.label}</span>
          </button>
        </div>
      );
    });
  }

  /** The board's controls: inside the page header on a desktop, in a row of their own on a phone. */
  function boardTopBar(inHeader: boolean) {
    return (
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
        onToggleLedger={toggleActiveLedgerPage}
        isMac={IS_MAC}
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        onOpenRoles={() => setRolesOpen(true)}
        onOpenUsage={() => selectPage('usage')}
        inHeader={inHeader}
      />
    );
  }

  return (
    <div
      className="company-ui company-shell-root flex h-full w-full flex-col overflow-hidden bg-bg"
      data-testid="company-workspace"
      style={{ '--company-page-transition': `${COMPANY_PAGE_TRANSITION_MS}ms` } as CSSProperties}
    >
      <header className="company-nav-mobile items-center gap-3 border-b border-hairline bg-panel px-3 py-2">
        <button
          type="button"
          aria-label={mobileNavOpen ? 'Đóng điều hướng' : 'Mở điều hướng'}
          aria-expanded={mobileNavOpen}
          onClick={() => setMobileNavOpen((open) => !open)}
          className="company-icon-btn touch-target shrink-0"
        >
          <Icon name="menu" />
        </button>
        <span className="font-medium">Agent Board</span>
        <span className="min-w-0 flex-1 truncate text-right text-sm text-text-secondary">
          {navItems.find((item) => item.page === activePage)?.label ?? 'Bảng việc'}
        </span>
      </header>
      <header
        className="company-nav-desktop h-10 shrink-0 items-center gap-3 border-b border-hairline bg-panel px-3"
        aria-label="Điều hướng"
      >
        <span className="shrink-0 font-semibold tracking-tight">Agent Board</span>
        <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" aria-label="Trang">
          {navItems.map((item) => (
            <button
              key={item.page}
              type="button"
              aria-current={activePage === item.page ? 'page' : undefined}
              onClick={() => selectPage(item.page)}
              className={`flex min-h-8 shrink-0 items-center gap-1.5 rounded-(--company-radius-sm) px-2.5 text-xs transition-colors duration-150 hover:bg-hover motion-reduce:transition-none ${activePage === item.page ? 'bg-selected text-text' : 'text-text-secondary'}`}
            >
              <Icon name={item.icon} className="shrink-0" />
              <span className="whitespace-nowrap">{item.label}</span>
            </button>
          ))}
        </nav>
        {(activePage === 'board' || activePage === 'ledger') && boardTopBar(true)}
      </header>
      {mobileViewport && mobileNavOpen && (
        <>
          <button
            type="button"
            aria-label="Đóng điều hướng"
            onClick={() => setMobileNavOpen(false)}
            className="fixed inset-0 z-40 cursor-default bg-black/40"
          />
          <nav
            className="fixed inset-x-0 top-12 z-50 max-h-[calc(100dvh-3rem)] overflow-y-auto border-b border-hairline bg-panel p-3 shadow-lg"
            aria-label="Trang"
          >
            {renderNavItems()}
          </nav>
        </>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {activePage === 'board' || activePage === 'ledger' ? (
      <>
      <div key={activePage} className="company-shell-page flex min-h-0 flex-1 flex-col">
      {mobileViewport && boardTopBar(false)}
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
      {sessionNotice !== null && (
        <p role="status" data-testid="session-open-notice" className="flex items-center gap-2 bg-warning/12 px-3 py-1.5 text-2xs text-warning">
          <span className="min-w-0 flex-1">{sessionNotice}</span>
          <button type="button" aria-label="Đóng thông báo" onClick={() => setSessionNotice(null)}>×</button>
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
              width={prefs.width}
              presentation={sidebar}
              onWidthChange={(width) =>
                setPrefs((current) => ({ ...current, width: clampSidebarWidth(width) }))
              }
              onCollapse={toggleSidebar}
              projectTree={{
                nodes: projects.nodes,
                selectedProjectId,
                onSelectProject: (projectId) => {
                  setSelectedProjectId(projectId);
                  if (projectId === null) {
                    client.setViewMode('all');
                    return;
                  }
                  const node = projects.nodes.find((candidate) => candidate.id === projectId);
                  if (node?.path !== undefined) {
                    client.setFocusFolder(node.path);
                    client.setViewMode('folder');
                  }
                },
                onCreateProject: () => void createProjectFromPickedFolder(),
                onOpenChanges: openProjectChanges,
                onOpenSettings: openProjectSettings,
                onNewSession: (nodeId, engine) => setNewSessionNode({ nodeId, ...(engine === undefined ? {} : { engine }) }),
                onOpenSession: openProjectSession,
                onMenu: openMenu,
                store: projectStore,
                selection: { sessionId: selectedSessionId, paneId: selectedPaneId },
              }}
              onOpenRoles={() => setRolesOpen(true)}
              onDismiss={dismissSheet}
            />
          )}
          {/* The composer sits under the board column only, so the agent list and the drawer run the full height. */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {ledgerShown ? (
            <LedgerView
              boardSessions={ledgerBoardSessions}
              focus={ledgerFocus}
              folders={ledgerFolders}
              onOpenBoardSession={selectSession}
              panes={ledgerPanes}
              onOpenHerdr={openHerdr}
              onOpenSleeping={openSleeping}
              onClose={() => selectPage('board')}
              onCompare={(repo, branch) => {
                // The ledger writes `V:/a/b`, the Project tree may write `V:\a\b`: compare them separator- and case-blind.
                const key = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
                const repository = projects.nodes.find((node) => node.kind === 'repository' && node.path !== undefined && key(node.path) === key(repo));
                const branchCheckout = projects.nodes.find((node) => node.kind === 'checkout' && node.parentId === repository?.id && node.branch === branch);
                if (branchCheckout?.path) openProjectChanges(branchCheckout.path, 'compare', branch);
              }}
            />
          ) : (
            <CompanyBoard
              lanes={lanes}
              flow={boardFlow(lanes, squadFolder?.settings?.maxParallel ?? state.settings?.maxWorkers ?? null)}
              squadFolder={squadFolder}
              planning={planningPrompts(state)}
              onSelectSession={selectSession}
              onSelectTask={selectTask}
              onOpenHerdr={openHerdr}
              selectedPaneId={selectedPaneId}
              selectedSessionId={selectedSessionId}
              selectedWorkItem={selectedWorkItem}
              onOpenWorkItem={openWorkItemCard}
              selectedSquad={selectedSquad}
              onOpenSquad={(ref) => setOpened({ kind: 'squad', ...ref })}
              client={client}
              onMenu={openMenu}
              changesFor={(card) => {
                // The session in the pane knows where it edits; the pane's own repo is the fallback.
                const checkout = (card.subject.kind === 'herdr' ? paneCheckout.get(card.subject.paneId) : undefined) ?? card.checkout;
                // The counts are the session's own: sessions sharing a checkout must not all show its total.
                const session = projects.nodes.find((node) =>
                  node.kind === 'session' && (card.subject.kind === 'herdr' ? node.herdrPaneId === card.subject.paneId : node.boardSessionId === card.subject.sessionId));
                const changes = sessionChanges(session);
                return checkout === null || changes === null ? null : { checkout, ...changes };
              }}
              onOpenChanges={(checkout) => openProjectChanges(checkout)}
              identityOf={(id) => folderIdentityOf(state, id)}
            />
          )}
          {!composerHidden && <PromptComposer client={client} projectFolders={ledgerFolders} />}
          </div>
          <DetailDrawer
            client={client}
            state={state}
            subject={subject}
            lanes={lanes}
            artifactId={artifactId}
            onOpen={setOpened}
            onOpenSessionTab={openSessionTab}
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
            workItemAction={
              opened?.kind === 'workItem' &&
              workItemAction?.ref.id === opened.id &&
              workItemAction.ref.workspacePath === opened.workspacePath
                ? { action: workItemAction.action, token: workItemAction.token }
                : null
            }
            onWorkItemActionHandled={(token) =>
              setWorkItemAction((current) => (current?.token === token ? null : current))
            }
          />
        </div>
      </TerminalPreviewProvider>
      </div>
      </>
      ) : activePage === 'changes' ? (
        <ChangesPage store={projectStore} checkoutId={selectedCheckoutId} initialTab={changesTab} initialBranchA={compareBranchA} onClose={() => selectPage('board')} />
      ) : activePage === 'usage' ? (
        <div key="usage-page" className="company-shell-page flex min-h-0 flex-1 flex-col">
          <UsagePage client={client} />
        </div>
      ) : activePage === 'storage' ? (
        <div key="storage-page" className="company-shell-page flex min-h-0 flex-1 flex-col">
          <StoragePage />
        </div>
      ) : activePage === 'skills' ? (
        <div key="skills-page" className="company-shell-page flex min-h-0 flex-1 flex-col">
          <SkillsPage />
        </div>
      ) : activePage === 'mcp' ? (
        <div key="mcp-page" className="company-shell-page flex min-h-0 flex-1 flex-col">
          <McpPage />
        </div>
      ) : (
        <div key="accounts-page" className="company-shell-page flex min-h-0 flex-1 flex-col">
          <AccountsPage />
        </div>
      )}
      {projectSettingsNode !== null && (
        <LayeredSettingsDialog
          store={projectStore}
          nodeId={projectSettingsNode}
          globalOmpRoleModels={globalOmpRoleModels}
          onClose={() => setProjectSettingsNode(null)}
        />
      )}
      {newSessionNode !== null && (
        <NewSessionDialog
          store={projectStore}
          nodeId={newSessionNode.nodeId}
          {...(newSessionNode.engine === undefined ? {} : { initialEngine: newSessionNode.engine })}
          onClose={() => setNewSessionNode(null)}
          onStarted={({ sessionId, engine, folderPath }) => {
            setNewSessionNode(null);
            // Claude and agy open as interactive agents in a herdr tab: show that pane's screen.
            if (engine !== 'omp') {
              openHerdr(sessionId, 'screen', true);
              return;
            }
            // An omp chat lives in its folder's board, so the board switches there to show it.
            if (folderPath !== undefined) selectWorkspaceSession(folderPath, sessionId);
          }}
        />
      )}
      {paletteOpen && (
        <CommandPalette
          items={paletteItems}
          onRun={runPaletteItem}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {rolesOpen && (
        <RolesDialog client={client} state={state} onClose={() => setRolesOpen(false)} />
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
          onWorkItemAction={runWorkItemMenuAction}
          onSelectSquad={selectSquad}
          onSquadRemoved={closeRemovedSquad}
          projectStore={projectStore}
          onProjectNodeAction={runProjectNodeAction}
        />
      )}
      <WorkDialogHost
        client={client}
        state={state}
        request={workDialog}
        onClose={() => setWorkDialog(null)}
      />
    </div>
      </div>
  );
}
