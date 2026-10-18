/**
 * AgentSidebar: the project tree beside the board. Each board folder is a project
 * header with its counts; the active folder expands into its roles and their
 * sessions, and the herdr agents sit under the repository they work in, one
 * project per repo. A project folds with its header, and the fold is remembered.
 *
 * An open background folder lists its sessions too; a click switches the board to it.
 *
 * A row that waits on the user is red and sorts first. A role's parked sessions
 * sit collapsed under "Tạm trữ" so live work stays in view. The role header opens
 * that role's model picker inline; the server applies a change at the role's next
 * turn. Every action on a project or a row is in its right-click menu. The sidebar
 * can be resized from its right edge with the pointer or with the arrow keys.
 */

import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { Fragment, useRef, useState } from 'react';

import type { CompanyRole, RoleProfile } from '../../../../core/src/company.js';
import { type AgentMenuRequest, type AgentMenuSubject, agentMenuTriggers } from '../agentMenu.js';
import {
  activityCounts,
  type AgentRoleGroup,
  type AgentRow,
  agentTooltip,
  type HerdrGroup,
  type HerdrRow,
  herdrRowCount,
  herdrTooltip,
  type SummaryLine,
} from '../agentSidebarView.js';
import {
  buildProjectTree,
  type FolderRows,
  projectCountsText,
  type ProjectNode,
} from '../agentTree.js';
import type { CompanyClient } from '../companyClient.js';
import type { CompanyViewState } from '../companyState.js';
import { COMPANY_SIDEBAR_MAX_WIDTH_PX, COMPANY_SIDEBAR_MIN_WIDTH_PX } from '../constants.js';
import { companyRoleLabel, ROLE_EDGE_CLASS, withRoleModel } from '../roleProfiles.js';
import { clampSidebarWidth } from '../sidebarPrefs.js';
import { useFlightLayout } from '../useFlightLayout.js';
import { useNow } from '../useNow.js';
import { ActivityChips } from './ActivityCounts.js';
import { ModelPicker } from './ModelPicker.js';
import { StatusDot } from './StatusDot.js';

/** Pixels one arrow-key press moves the resize edge. */
const RESIZE_STEP_PX = 16;

export interface AgentSidebarProps {
  client: CompanyClient;
  state: CompanyViewState;
  /** The session the drawer shows, so its row reads as selected. */
  selectedSessionId: string | null;
  /** The herdr pane the drawer shows, so its row reads as selected. */
  selectedPaneId: string | null;
  width: number;
  /** True below the overlay breakpoint: the sidebar floats over the board. */
  overlay: boolean;
  /** The keys of the projects the user folded. */
  collapsedProjects: ReadonlySet<string>;
  onWidthChange: (width: number) => void;
  onCollapse: () => void;
  onSelectSession: (sessionId: string) => void;
  onSelectWorkspaceSession: (path: string, sessionId: string) => void;
  onOpenHerdr: (paneId: string) => void;
  onToggleProject: (key: string) => void;
  onMenu: (request: AgentMenuRequest) => void;
}

/** What every row and header needs from the sidebar, passed down once. */
interface TreeView {
  catalog: CompanyViewState['modelCatalog'];
  editingRole: CompanyRole | null;
  selectedSessionId: string | null;
  selectedPaneId: string | null;
  profileOf: (role: CompanyRole) => RoleProfile | null;
  onToggleEdit: (role: CompanyRole) => void;
  onPick: (role: CompanyRole, modelId: string, thinking: string | undefined) => void;
  onSelectSession: (sessionId: string) => void;
  onSelectWorkspaceSession: (path: string, sessionId: string) => void;
  onOpenWorkspace: (path: string) => void;
  /** The folder the board is switching to for a session chosen in another folder; null when none. */
  switchingPath: string | null;
  onOpenHerdr: (paneId: string) => void;
  onToggleProject: (key: string) => void;
  onMenu: (request: AgentMenuRequest) => void;
}

export function AgentSidebar({
  client,
  state,
  selectedSessionId,
  selectedPaneId,
  width,
  overlay,
  collapsedProjects,
  onWidthChange,
  onCollapse,
  onSelectSession,
  onSelectWorkspaceSession,
  onOpenHerdr,
  onToggleProject,
  onMenu,
}: AgentSidebarProps) {
  const [editingRole, setEditingRole] = useState<CompanyRole | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const now = useNow();
  const treeRef = useRef<HTMLDivElement>(null);
  useFlightLayout(treeRef);

  const tree = buildProjectTree(state, now, collapsedProjects);
  const boards = tree.projects.filter((project) => project.kind === 'board');
  const repos = tree.projects.filter((project) => project.kind === 'herdr');
  const activeGroups = boards.find((project) => project.active)?.groups ?? [];
  const counts = activityCounts(activeGroups, tree.herdr);
  const total =
    activeGroups.reduce((sum, group) => sum + group.active.length + group.parked.length, 0) +
    herdrRowCount(tree.herdr);
  const profiles = state.settings?.roleProfiles ?? {};

  function changeRole(role: CompanyRole, modelId: string, thinking: string | undefined): void {
    const outcome = client.updateRoleProfiles(withRoleModel(profiles, role, modelId, thinking));
    setEditingRole(null);
    setNotice(
      outcome.ok
        ? `${companyRoleLabel(role)} sẽ dùng ${modelId}${thinking ? ` · ${thinking}` : ''} từ lượt tới.`
        : (outcome.message ?? outcome.errorCode ?? 'Máy chủ từ chối đổi model.'),
    );
  }

  const view: TreeView = {
    catalog: state.modelCatalog,
    editingRole,
    selectedSessionId,
    selectedPaneId,
    profileOf: (role) => profiles[role] ?? null,
    onToggleEdit: (role) => setEditingRole((current) => (current === role ? null : role)),
    onPick: changeRole,
    onSelectSession,
    onSelectWorkspaceSession,
    onOpenWorkspace: (path) => {
      client.openWorkspace(path);
    },
    switchingPath: state.pendingWorkspaceSelection?.path ?? null,
    onOpenHerdr,
    onToggleProject,
    onMenu,
  };

  return (
    <aside
      aria-label="Đàn agent"
      data-testid="agent-sidebar"
      className={`flex h-full shrink-0 flex-col border-r border-border bg-bg-dark ${overlay ? 'absolute inset-y-0 left-0 z-30 shadow-lg' : 'relative'}`}
      style={{ width: `${width}px` }}
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-2.5 py-2">
        <h2 className="text-xs font-semibold text-text-muted">Đàn agent · {total}</h2>
        <button
          type="button"
          onClick={onCollapse}
          aria-label="Thu gọn đàn agent"
          title="Thu gọn thành thanh biểu tượng (Ctrl+B)"
          className="cursor-pointer px-1 text-2xs text-text-muted hover:text-text"
        >
          ⟨
        </button>
      </header>
      <ActivityChips counts={counts} />

      <div ref={treeRef} data-testid="agent-tree" className="min-h-0 flex-1 overflow-y-auto">
        {boards.map((project) => (
          <ProjectSection key={project.key} project={project} view={view} />
        ))}
        <HerdrBlock herdr={tree.herdr} repos={repos} view={view} />
      </div>

      {notice && (
        <p
          role="status"
          data-testid="role-notice"
          className="border-t border-border px-2 py-1 text-xs text-text-muted"
        >
          {notice}
        </p>
      )}

      <ResizeEdge width={width} onWidthChange={onWidthChange} />
    </aside>
  );
}

/** A project's header, and its children when it is open. */
function ProjectSection({ project, view }: { project: ProjectNode; view: TreeView }) {
  const triggers = agentMenuTriggers<HTMLButtonElement>({ kind: 'project', project }, view.onMenu);
  return (
    <section
      aria-label={project.name}
      data-testid={`project-${project.key}`}
      className="border-b border-border"
    >
      <button
        type="button"
        aria-expanded={!project.collapsed}
        onClick={() => view.onToggleProject(project.key)}
        {...triggers}
        title={project.tooltip}
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 px-2.5 py-2 text-left hover:bg-btn-hover"
      >
        <span aria-hidden="true" className="w-3 shrink-0 text-2xs text-text-muted">
          {project.collapsed ? '▸' : '▾'}
        </span>
        <span
          aria-hidden="true"
          className="h-4 w-[3px] shrink-0 rounded-full"
          style={{ backgroundColor: `var(--company-project-${project.tone})` }}
        />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text">
          {project.name}
        </span>
        {project.branch !== null && (
          <span
            title={project.branch}
            className="max-w-[40%] min-w-0 shrink truncate rounded-[3px] border border-border px-1 font-mono text-2xs text-status-active"
          >
            {project.branch}
          </span>
        )}
        <span className="shrink-0 text-xs text-text-muted">
          {projectCountsText(project.counts)}
        </span>
      </button>
      {!project.collapsed && <ProjectBody project={project} view={view} />}
    </section>
  );
}

/** A project's children, indented under a guide: its roles, its panes, or a note. */
function ProjectBody({ project, view }: { project: ProjectNode; view: TreeView }) {
  if (project.kind === 'herdr') {
    return (
      <ul className="ml-4 border-l border-border pb-1 pl-1">
        {project.panes.map((row, index) => (
          <li key={row.paneId}>
            <HerdrRowButton
              row={row}
              lane={project.key}
              index={index}
              selected={row.paneId === view.selectedPaneId}
              onOpen={() => view.onOpenHerdr(row.paneId)}
              onMenu={view.onMenu}
            />
          </li>
        ))}
      </ul>
    );
  }
  if (!project.active) {
    if (project.folderRows !== null) {
      return <WorkspaceSessions folder={project.folderRows} project={project} view={view} />;
    }
    if (project.notOpen && project.switchTo !== null) {
      const path = project.switchTo;
      return (
        <button
          type="button"
          onClick={() => view.onOpenWorkspace(path)}
          className="cursor-pointer px-4 pb-2 text-left text-xs text-text-muted hover:text-text"
        >
          chưa mở — bấm để mở
        </button>
      );
    }
    return (
      <p className="px-4 pb-2 text-xs text-text-muted">Mở thư mục này trên bảng để xem phiên.</p>
    );
  }
  return (
    <div className="ml-4 border-l border-border pb-1 pl-1">
      {project.groups.map((group, index) => (
        <Fragment key={group.role}>
          {index > 0 && project.groups[index - 1]?.role === 'chat' && group.role !== 'chat' && (
            <div role="separator" className="mx-1 my-1 border-t border-border" />
          )}
          <RoleSection group={group} profile={view.profileOf(group.role)} view={view} />
        </Fragment>
      ))}
    </div>
  );
}

/**
 * A background folder's sessions, as the folder list reports them. A click switches the
 * board to that folder and selects the session there; the right-click menu is the folder's.
 */
function WorkspaceSessions({
  folder,
  project,
  view,
}: {
  folder: FolderRows;
  project: ProjectNode;
  view: TreeView;
}) {
  const [showParked, setShowParked] = useState(false);
  const empty = folder.live.length === 0 && folder.parked.length === 0;
  return (
    <div className="ml-4 border-l border-border pb-1 pl-1">
      {view.switchingPath === folder.path && (
        <p className="px-2 py-1 text-xs text-text-muted">Đang chuyển sang thư mục này…</p>
      )}
      {empty && <p className="px-2 py-1 text-xs text-text-muted">Chưa có phiên nào.</p>}
      <ul>
        {folder.live.map((row, index) => (
          <li key={row.sessionId}>
            <AgentRowButton
              row={row}
              testId={`folder-row-${row.code}`}
              lane={`folder:${folder.path}`}
              index={index}
              selected={false}
              menu={{ kind: 'project', project }}
              onSelect={() => view.onSelectWorkspaceSession(folder.path, row.sessionId)}
              onMenu={view.onMenu}
            />
          </li>
        ))}
      </ul>
      {folder.parked.length > 0 && (
        <div className="px-2">
          <button
            type="button"
            aria-expanded={showParked}
            onClick={() => setShowParked((current) => !current)}
            className="cursor-pointer py-0.5 text-xs text-text-muted hover:text-text"
          >
            Tạm trữ ({folder.parked.length}) {showParked ? '▴' : '▾'}
          </button>
          {showParked && (
            <ul>
              {folder.parked.map((row, index) => (
                <li key={row.sessionId}>
                  <AgentRowButton
                    row={row}
                    testId={`folder-row-${row.code}`}
                    lane={`folder:${folder.path}:parked`}
                    index={index}
                    selected={false}
                    menu={{ kind: 'project', project }}
                    onSelect={() => view.onSelectWorkspaceSession(folder.path, row.sessionId)}
                    onMenu={view.onMenu}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** The herdr agents, under a heading, one project per repository they work in. */
function HerdrBlock({
  herdr,
  repos,
  view,
}: {
  herdr: HerdrGroup;
  repos: readonly ProjectNode[];
  view: TreeView;
}) {
  if (herdr.kind === 'hidden') return null;
  if (herdr.kind === 'unavailable') {
    return <p className="px-2.5 py-2 text-xs text-text-muted">{herdr.message}</p>;
  }
  if (repos.length === 0) {
    return <p className="px-2.5 py-2 text-xs text-text-muted">Không có agent nào trong herdr.</p>;
  }
  return (
    <div data-testid="agent-group-herdr">
      <h3 className="flex items-baseline gap-2 px-2.5 pb-1 pt-2">
        <span className="text-sm font-semibold text-text">Herdr</span>
        <span className="text-xs text-status-active">{herdrRowCount(herdr)} agent</span>
      </h3>
      {repos.map((project) => (
        <ProjectSection key={project.key} project={project} view={view} />
      ))}
    </div>
  );
}

function RoleSection({
  group,
  profile,
  view,
}: {
  group: AgentRoleGroup;
  profile: RoleProfile | null;
  view: TreeView;
}) {
  const [showParked, setShowParked] = useState(false);
  const editing = view.editingRole === group.role;

  return (
    <section aria-label={group.label} data-testid={`agent-group-${group.role}`} className="pb-1">
      <button
        type="button"
        disabled={profile === null}
        onClick={() => view.onToggleEdit(group.role)}
        aria-expanded={editing}
        title="Bấm để đổi model và mức suy nghĩ của vai này"
        className={`flex w-full min-w-0 cursor-pointer items-center gap-2 border-l-4 px-2 pb-1 pt-1.5 text-left hover:bg-btn-hover disabled:cursor-default disabled:hover:bg-transparent ${ROLE_EDGE_CLASS[group.role]}`}
      >
        <span className="shrink-0 text-sm font-semibold text-text">{group.label}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-status-active">
          {profile === null
            ? 'chưa có hồ sơ'
            : `${group.hostRole} · ${profile.requestedModel}${profile.thinking ? ` · ${profile.thinking}` : ''}`}
        </span>
        {profile !== null && (
          <span aria-hidden="true" className="shrink-0 text-2xs text-text-muted">
            {editing ? '▴' : '▾'}
          </span>
        )}
      </button>

      {editing && profile !== null && (
        <div className="px-2 pb-2">
          <ModelPicker
            profile={profile}
            catalog={view.catalog}
            onPick={(modelId, thinking) => view.onPick(group.role, modelId, thinking)}
          />
        </div>
      )}

      <ul>
        {group.active.map((row, index) => (
          <li key={row.sessionId}>
            <AgentRowButton
              row={row}
              testId={`agent-row-${row.code}`}
              menu={{ kind: 'session', sessionId: row.sessionId, drawer: null }}
              lane={group.role}
              index={index}
              selected={row.sessionId === view.selectedSessionId}
              onSelect={() => view.onSelectSession(row.sessionId)}
              onMenu={view.onMenu}
            />
          </li>
        ))}
      </ul>

      {group.parked.length > 0 && (
        <div className="px-2">
          <button
            type="button"
            aria-expanded={showParked}
            onClick={() => setShowParked((current) => !current)}
            className="cursor-pointer py-0.5 text-xs text-text-muted hover:text-text"
          >
            Tạm trữ ({group.parked.length}) {showParked ? '▴' : '▾'}
          </button>
          {showParked && (
            <ul>
              {group.parked.map((row, index) => (
                <li key={row.sessionId}>
                  <AgentRowButton
                    row={row}
                    testId={`agent-row-${row.code}`}
                    menu={{ kind: 'session', sessionId: row.sessionId, drawer: null }}
                    lane={`${group.role}:parked`}
                    index={index}
                    selected={row.sessionId === view.selectedSessionId}
                    onSelect={() => view.onSelectSession(row.sessionId)}
                    onMenu={view.onMenu}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/** A row's second line: what the agent is doing, its glyph, and how long ago. */
function SummaryText({ summary }: { summary: SummaryLine }) {
  return (
    <span className="mt-0.5 flex min-w-0 items-baseline gap-2 text-xs text-text-muted">
      <span className="min-w-0 flex-1 truncate">
        {summary.glyph !== '' && <span aria-hidden="true">{summary.glyph} </span>}
        {summary.text}
      </span>
      {summary.age !== null && <span className="shrink-0">{summary.age}</span>}
    </span>
  );
}

function AgentRowButton({
  row,
  testId,
  lane,
  index,
  selected,
  menu,
  onSelect,
  onMenu,
}: {
  row: AgentRow;
  testId: string;
  lane: string;
  index: number;
  selected: boolean;
  /** What the row's right-click menu acts on: the session itself, or the folder it belongs to. */
  menu: AgentMenuSubject;
  onSelect: () => void;
  onMenu: (request: AgentMenuRequest) => void;
}) {
  const triggers = agentMenuTriggers<HTMLButtonElement>(menu, onMenu);
  return (
    <button
      type="button"
      onClick={onSelect}
      {...triggers}
      aria-pressed={selected}
      title={agentTooltip(row)}
      data-testid={testId}
      data-flight-key={`session:${row.sessionId}`}
      data-lane={lane}
      data-index={index}
      className={`flex w-full cursor-pointer items-start gap-2 rounded-[5px] border px-2 py-1.5 text-left hover:bg-btn-hover ${selected ? 'border-accent bg-btn-bg' : 'border-transparent'}`}
    >
      <span className="flex h-4 w-3 shrink-0 items-center justify-center">
        <StatusDot tone={row.tone} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="shrink-0 font-mono text-2xs text-text-muted">{row.code}</span>
          <span className="min-w-0 flex-1 truncate text-sm text-text">{row.name}</span>
          <span className={`shrink-0 text-xs ${row.needsYou ? 'text-warning' : 'text-text-muted'}`}>
            {row.label}
          </span>
        </span>
        {row.summary !== null && <SummaryText summary={row.summary} />}
      </span>
    </button>
  );
}

function HerdrRowButton({
  row,
  lane,
  index,
  selected,
  onOpen,
  onMenu,
}: {
  row: HerdrRow;
  lane: string;
  index: number;
  selected: boolean;
  onOpen: () => void;
  onMenu: (request: AgentMenuRequest) => void;
}) {
  const triggers = agentMenuTriggers<HTMLButtonElement>(
    { kind: 'herdr', paneId: row.paneId, drawer: null },
    onMenu,
  );
  return (
    <button
      type="button"
      onClick={onOpen}
      {...triggers}
      aria-pressed={selected}
      title={herdrTooltip(row)}
      data-testid={`herdr-row-${row.paneId}`}
      data-flight-key={`pane:${row.paneId}`}
      data-lane={lane}
      data-index={index}
      className={`flex w-full cursor-pointer items-start gap-2 rounded-[5px] border px-2 py-1.5 text-left hover:bg-btn-hover ${selected ? 'border-accent bg-btn-bg' : 'border-transparent'}`}
    >
      <span className="flex h-4 w-3 shrink-0 items-center justify-center">
        <StatusDot tone={row.tone} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text">
            {row.kind} · {row.paneId}
          </span>
          {row.branch !== null && (
            <span
              title={row.worktreeRoot ?? row.branch}
              className="min-w-0 max-w-[40%] shrink truncate rounded-[3px] border border-border px-1 font-mono text-2xs text-status-active"
            >
              {row.branch}
            </span>
          )}
          <span className="shrink-0 text-xs text-text-muted">{row.label}</span>
        </span>
        {row.summary !== null && <SummaryText summary={row.summary} />}
      </span>
    </button>
  );
}

/**
 * The sidebar's resize edge. A pointer drag follows the cursor from where the
 * press began; the arrow keys move it in steps, so the width is reachable
 * without a mouse.
 */
function ResizeEdge({
  width,
  onWidthChange,
}: {
  width: number;
  onWidthChange: (width: number) => void;
}) {
  const [drag, setDrag] = useState<{ startX: number; startWidth: number } | null>(null);

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = event.key === 'ArrowRight' ? RESIZE_STEP_PX : -RESIZE_STEP_PX;
    onWidthChange(clampSidebarWidth(width + step));
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Đổi độ rộng đại lý"
      aria-valuemin={COMPANY_SIDEBAR_MIN_WIDTH_PX}
      aria-valuemax={COMPANY_SIDEBAR_MAX_WIDTH_PX}
      aria-valuenow={width}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        setDrag({ startX: event.clientX, startWidth: width });
      }}
      onPointerMove={(event: ReactPointerEvent<HTMLDivElement>) => {
        if (drag === null) return;
        onWidthChange(clampSidebarWidth(drag.startWidth + event.clientX - drag.startX));
      }}
      onPointerUp={() => setDrag(null)}
      onPointerCancel={() => setDrag(null)}
      className="absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize hover:bg-accent focus-visible:bg-accent"
    />
  );
}
