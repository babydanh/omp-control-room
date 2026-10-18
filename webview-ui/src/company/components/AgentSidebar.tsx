/**
 * AgentSidebar: every agent the company runs, grouped by role, plus the herdr
 * agents grouped by the repository they work in. Each agent takes two lines:
 * what it is and its state, then what it is doing. Collapsing the sidebar leaves
 * the AgentRail, which still shows every agent.
 *
 * A row that waits on the user is red and sorts first. A role's parked sessions
 * sit collapsed under "Tạm trữ" so live work stays in view. The role header
 * opens that role's model picker inline; the server applies a change at the
 * role's next turn. The sidebar can be resized from its right edge with the
 * pointer or with the arrow keys.
 */

import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useState } from 'react';

import type { CompanyRole, RoleProfile } from '../../../../core/src/company.js';
import {
  activityCounts,
  type AgentRoleGroup,
  type AgentRow,
  agentTooltip,
  buildAgentGroups,
  type HerdrGroup,
  herdrGroup,
  type HerdrRepoGroup,
  type HerdrRow,
  herdrRowCount,
  herdrTooltip,
  type RepoPlacement,
  type SummaryLine,
} from '../agentSidebarView.js';
import type { CompanyClient } from '../companyClient.js';
import type { CompanyViewState } from '../companyState.js';
import { COMPANY_SIDEBAR_MAX_WIDTH_PX, COMPANY_SIDEBAR_MIN_WIDTH_PX } from '../constants.js';
import { companyRoleLabel, ROLE_EDGE_CLASS, withRoleModel } from '../roleProfiles.js';
import { clampSidebarWidth } from '../sidebarPrefs.js';
import { useNow } from '../useNow.js';
import { ActivityChips } from './ActivityCounts.js';
import { ModelPicker } from './ModelPicker.js';
import { StatusDot } from './StatusDot.js';

/** Pixels one arrow-key press moves the resize edge. */
const RESIZE_STEP_PX = 16;

/** What a repo group header's tooltip says about how the group was found. */
const REPO_SOURCE_TITLE: Readonly<Record<RepoPlacement['source'], string>> = {
  repo: 'Nhóm theo repository git',
  workspace: 'Nhóm theo workspace của herdr (chưa có repository)',
  folder: 'Nhóm theo tên thư mục (chưa có repository hay workspace)',
  other: 'Chưa rõ repository, workspace hay thư mục',
};

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
  onWidthChange: (width: number) => void;
  onCollapse: () => void;
  onSelectSession: (sessionId: string) => void;
  onOpenHerdr: (paneId: string) => void;
}

export function AgentSidebar({
  client,
  state,
  selectedSessionId,
  selectedPaneId,
  width,
  overlay,
  onWidthChange,
  onCollapse,
  onSelectSession,
  onOpenHerdr,
}: AgentSidebarProps) {
  const [editingRole, setEditingRole] = useState<CompanyRole | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const now = useNow();

  const groups = buildAgentGroups(state, now);
  const herdr = herdrGroup(state.herdr);
  const counts = activityCounts(groups, herdr);
  const total =
    groups.reduce((sum, group) => sum + group.active.length + group.parked.length, 0) +
    herdrRowCount(herdr);
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

  return (
    <aside
      aria-label="Đàn agent"
      data-testid="agent-sidebar"
      className={`flex h-full shrink-0 flex-col border-r border-border bg-bg-dark ${overlay ? 'absolute inset-y-0 left-0 z-30 shadow-lg' : 'relative'}`}
      style={{ width: `${width}px` }}
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-2.5 py-2">
        <h2 className="text-2xs font-semibold text-text-muted">Đàn agent · {total}</h2>
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

      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.map((group) => (
          <RoleSection
            key={group.role}
            group={group}
            catalog={state.modelCatalog}
            profile={profiles[group.role] ?? null}
            editing={editingRole === group.role}
            selectedSessionId={selectedSessionId}
            onToggleEdit={() =>
              setEditingRole((current) => (current === group.role ? null : group.role))
            }
            onPick={(modelId, thinking) => changeRole(group.role, modelId, thinking)}
            onSelectSession={onSelectSession}
          />
        ))}
        <HerdrSection group={herdr} selectedPaneId={selectedPaneId} onOpen={onOpenHerdr} />
      </div>

      {notice && (
        <p
          role="status"
          data-testid="role-notice"
          className="border-t border-border px-2 py-1 text-2xs text-text-muted"
        >
          {notice}
        </p>
      )}

      <ResizeEdge width={width} onWidthChange={onWidthChange} />
    </aside>
  );
}

function RoleSection({
  group,
  catalog,
  profile,
  editing,
  selectedSessionId,
  onToggleEdit,
  onPick,
  onSelectSession,
}: {
  group: AgentRoleGroup;
  catalog: CompanyViewState['modelCatalog'];
  profile: RoleProfile | null;
  editing: boolean;
  selectedSessionId: string | null;
  onToggleEdit: () => void;
  onPick: (modelId: string, thinking: string | undefined) => void;
  onSelectSession: (sessionId: string) => void;
}) {
  const [showParked, setShowParked] = useState(false);
  const rowCount = group.active.length + group.parked.length;

  return (
    <section
      aria-label={group.label}
      data-testid={`agent-group-${group.role}`}
      className="border-b border-border"
    >
      <button
        type="button"
        disabled={profile === null}
        onClick={onToggleEdit}
        aria-expanded={editing}
        title="Bấm để đổi model và mức suy nghĩ của vai này"
        className={`flex w-full min-w-0 cursor-pointer items-center gap-2 border-l-4 px-2.5 pb-1 pt-2 text-left hover:bg-btn-hover disabled:cursor-default disabled:hover:bg-transparent ${ROLE_EDGE_CLASS[group.role]}`}
      >
        <span className="shrink-0 text-sm font-semibold text-text">{group.label}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-status-active">
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
          <ModelPicker profile={profile} catalog={catalog} onPick={onPick} />
        </div>
      )}

      <ul>
        {group.active.map((row) => (
          <li key={row.sessionId}>
            <AgentRowButton
              row={row}
              selected={row.sessionId === selectedSessionId}
              onSelect={() => onSelectSession(row.sessionId)}
            />
          </li>
        ))}
        {rowCount === 0 && (
          <li className="px-2 py-1 text-2xs text-text-muted">Chưa có phiên nào.</li>
        )}
      </ul>

      {group.parked.length > 0 && (
        <div className="px-2 pb-1">
          <button
            type="button"
            aria-expanded={showParked}
            onClick={() => setShowParked((current) => !current)}
            className="cursor-pointer text-2xs text-text-muted hover:text-text"
          >
            Tạm trữ ({group.parked.length}) {showParked ? '▴' : '▾'}
          </button>
          {showParked && (
            <ul>
              {group.parked.map((row) => (
                <li key={row.sessionId}>
                  <AgentRowButton
                    row={row}
                    selected={row.sessionId === selectedSessionId}
                    onSelect={() => onSelectSession(row.sessionId)}
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
    <span className="mt-0.5 flex min-w-0 items-baseline gap-2 font-mono text-2xs text-text-muted">
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
  selected,
  onSelect,
}: {
  row: AgentRow;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      title={agentTooltip(row)}
      data-testid={`agent-row-${row.code}`}
      className={`flex w-full cursor-pointer items-start gap-2 rounded-[5px] border px-2 py-1.5 text-left hover:bg-btn-hover ${selected ? 'border-accent bg-btn-bg' : 'border-transparent'}`}
    >
      <span className="flex h-4 w-3 shrink-0 items-center justify-center">
        <StatusDot tone={row.tone} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="shrink-0 font-mono text-2xs text-text-muted">{row.code}</span>
          <span className="min-w-0 flex-1 truncate text-sm text-text">{row.name}</span>
          <span
            className={`shrink-0 text-2xs ${row.needsYou ? 'text-warning' : 'text-text-muted'}`}
          >
            {row.label}
          </span>
        </span>
        {row.summary !== null && <SummaryText summary={row.summary} />}
      </span>
    </button>
  );
}

function HerdrSection({
  group,
  selectedPaneId,
  onOpen,
}: {
  group: HerdrGroup;
  selectedPaneId: string | null;
  onOpen: (paneId: string) => void;
}) {
  if (group.kind === 'hidden') return null;
  return (
    <section aria-label="herdr" data-testid="agent-group-herdr" className="border-b border-border">
      <h3 className="flex items-baseline gap-2 px-2.5 pb-1 pt-2">
        <span className="text-sm font-semibold text-text">Herdr</span>
        {group.kind === 'ready' && (
          <span className="font-mono text-2xs text-status-active">
            {herdrRowCount(group)} agent
          </span>
        )}
      </h3>
      {group.kind === 'unavailable' ? (
        <p className="px-2 pb-2 text-2xs text-text-muted">{group.message}</p>
      ) : group.repos.length === 0 ? (
        <p className="px-2.5 pb-2 text-2xs text-text-muted">Không có agent nào trong herdr.</p>
      ) : (
        group.repos.map((repo) => (
          <HerdrRepoSection
            key={repo.key}
            repo={repo}
            selectedPaneId={selectedPaneId}
            onOpen={onOpen}
          />
        ))
      )}
    </section>
  );
}

/** The herdr agents of one repository, under a header that says where they work. */
function HerdrRepoSection({
  repo,
  selectedPaneId,
  onOpen,
}: {
  repo: HerdrRepoGroup;
  selectedPaneId: string | null;
  onOpen: (paneId: string) => void;
}) {
  return (
    <div className="pb-1">
      <h4
        title={REPO_SOURCE_TITLE[repo.source]}
        className="flex items-baseline gap-2 px-2.5 pt-1 text-2xs text-text-muted"
      >
        <span className="min-w-0 flex-1 truncate font-semibold text-text">{repo.label}</span>
        <span className="shrink-0 font-mono">{repo.rows.length}</span>
      </h4>
      <ul>
        {repo.rows.map((row) => (
          <li key={row.paneId}>
            <HerdrRowButton
              row={row}
              selected={row.paneId === selectedPaneId}
              onOpen={() => onOpen(row.paneId)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function HerdrRowButton({
  row,
  selected,
  onOpen,
}: {
  row: HerdrRow;
  selected: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-pressed={selected}
      title={herdrTooltip(row)}
      data-testid={`herdr-row-${row.paneId}`}
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
          <span className="shrink-0 text-2xs text-text-muted">{row.label}</span>
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
