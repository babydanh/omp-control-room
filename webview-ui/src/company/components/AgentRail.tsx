/**
 * AgentRail: the collapsed sidebar, drawn from the same project tree. Each project
 * opens with a short marker: its name cut to a few characters, a coloured tick,
 * and the full name in the tooltip. Clicking the marker folds or opens the
 * project. An open project lists one badge per agent, the ones that wait on the
 * user first, and one "+N" badge for its parked sessions; a folded project shows a
 * single summary. A badge's tooltip carries its name, status and summary.
 */
import { useRef } from 'react';

import { type AgentMenuRequest, type AgentMenuTriggers, agentMenuTriggers } from '../agentMenu.js';
import {
  activityCounts,
  agentTooltip,
  herdrTooltip,
  paneShortCode,
  sessionShortCode,
} from '../agentSidebarView.js';
import {
  buildProjectTree,
  buildRailTree,
  projectAgentTotal,
  type ProjectNode,
  type RailEntry,
  shortProjectName,
} from '../agentTree.js';
import type { CompanyViewState } from '../companyState.js';
import { COMPANY_RAIL_WIDTH_PX } from '../constants.js';
import { ROLE_EDGE_CLASS } from '../roleProfiles.js';
import { useFlightLayout } from '../useFlightLayout.js';
import { useNow } from '../useNow.js';
import { ActivityStack } from './ActivityCounts.js';
import { type DotTone, StatusDot } from './StatusDot.js';

/** Herdr panes have no role; their badges take a neutral edge. */
const PANE_EDGE_CLASS = 'border-l-text-muted';

export interface AgentRailProps {
  state: CompanyViewState;
  /** The session the drawer shows, so its badge reads as selected. */
  selectedSessionId: string | null;
  /** The herdr pane the drawer shows, so its badge reads as selected. */
  selectedPaneId: string | null;
  /** The keys of the projects the user folded. */
  collapsedProjects: ReadonlySet<string>;
  /** Expands the sidebar back to its full width. */
  onExpand: () => void;
  onSelectSession: (sessionId: string) => void;
  onOpenHerdr: (paneId: string) => void;
  onToggleProject: (key: string) => void;
  onMenu: (request: AgentMenuRequest) => void;
}

export function AgentRail({
  state,
  selectedSessionId,
  selectedPaneId,
  collapsedProjects,
  onExpand,
  onSelectSession,
  onOpenHerdr,
  onToggleProject,
  onMenu,
}: AgentRailProps) {
  const now = useNow();
  const listRef = useRef<HTMLDivElement>(null);
  useFlightLayout(listRef);
  const tree = buildProjectTree(state, now, collapsedProjects);
  const entries = buildRailTree(tree.projects);
  const active = tree.projects.find((project) => project.active);
  const counts = activityCounts(active?.groups ?? [], tree.herdr);

  return (
    <aside
      aria-label="Đàn agent (thu gọn)"
      data-testid="agent-rail"
      className="flex h-full shrink-0 flex-col items-center border-r border-border bg-bg-dark"
      style={{ width: `${COMPANY_RAIL_WIDTH_PX}px` }}
    >
      <button
        type="button"
        onClick={onExpand}
        aria-label="Mở rộng đàn agent"
        title="Mở rộng đàn agent (Ctrl+B)"
        className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center text-2xs text-text-muted hover:text-text"
      >
        ⟩
      </button>
      <ActivityStack counts={counts} />
      <div
        ref={listRef}
        className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto py-2"
      >
        {entries.map((entry, index) => (
          <RailEntryView
            key={railKey(entry, index)}
            entry={entry}
            index={index}
            selectedSessionId={selectedSessionId}
            selectedPaneId={selectedPaneId}
            onExpand={onExpand}
            onSelectSession={onSelectSession}
            onOpenHerdr={onOpenHerdr}
            onToggleProject={onToggleProject}
            onMenu={onMenu}
          />
        ))}
      </div>
    </aside>
  );
}

/** A stable key per entry; a break has no identity of its own, so it keeps its position. */
function railKey(entry: RailEntry, index: number): string {
  switch (entry.kind) {
    case 'project':
      return `project:${entry.project.key}`;
    case 'summary':
      return `summary:${entry.project.key}`;
    case 'session':
      return `session:${entry.row.sessionId}`;
    case 'pane':
      return `pane:${entry.row.paneId}`;
    case 'parked':
      return `parked:${entry.projectKey}`;
    case 'break':
      return `break:${index}`;
  }
}

function RailEntryView({
  entry,
  index,
  selectedSessionId,
  selectedPaneId,
  onExpand,
  onSelectSession,
  onOpenHerdr,
  onToggleProject,
  onMenu,
}: {
  entry: RailEntry;
  index: number;
  selectedSessionId: string | null;
  selectedPaneId: string | null;
  onExpand: () => void;
  onSelectSession: (sessionId: string) => void;
  onOpenHerdr: (paneId: string) => void;
  onToggleProject: (key: string) => void;
  onMenu: (request: AgentMenuRequest) => void;
}) {
  switch (entry.kind) {
    case 'project':
      return (
        <ProjectMarker
          project={entry.project}
          index={index}
          onToggle={() => onToggleProject(entry.project.key)}
          triggers={agentMenuTriggers<HTMLButtonElement>(
            { kind: 'project', project: entry.project },
            onMenu,
          )}
        />
      );
    case 'summary':
      return (
        <div
          data-testid={`rail-summary-${entry.project.key}`}
          title={`${entry.project.name}: ${projectAgentTotal(entry.project.counts)} agent`}
          className="flex h-8 w-[84px] shrink-0 flex-col items-center justify-center rounded-[5px] border border-dashed border-border text-2xs text-text-muted"
        >
          <span>{projectAgentTotal(entry.project.counts)} agent</span>
          {entry.project.counts.needs > 0 && (
            <span className="text-warning">{entry.project.counts.needs} chờ bạn</span>
          )}
        </div>
      );
    case 'session':
      return (
        <RailBadge
          testId={`rail-session-${entry.row.code}`}
          flightKey={`session:${entry.row.sessionId}`}
          index={index}
          label={sessionShortCode(entry.row.code)}
          sub={entry.row.label}
          tone={entry.row.tone}
          edgeClass={ROLE_EDGE_CLASS[entry.row.role]}
          title={agentTooltip(entry.row)}
          selected={entry.row.sessionId === selectedSessionId}
          onClick={() => onSelectSession(entry.row.sessionId)}
          triggers={agentMenuTriggers<HTMLButtonElement>(
            { kind: 'session', sessionId: entry.row.sessionId, drawer: null },
            onMenu,
          )}
        />
      );
    case 'pane':
      return (
        <RailBadge
          testId={`rail-pane-${entry.row.paneId}`}
          flightKey={`pane:${entry.row.paneId}`}
          index={index}
          label={`${entry.row.kind} ${paneShortCode(entry.row.paneId)}`}
          sub={entry.row.label}
          tone={entry.row.tone}
          edgeClass={PANE_EDGE_CLASS}
          title={herdrTooltip(entry.row)}
          selected={entry.row.paneId === selectedPaneId}
          onClick={() => onOpenHerdr(entry.row.paneId)}
          triggers={agentMenuTriggers<HTMLButtonElement>(
            { kind: 'herdr', paneId: entry.row.paneId, drawer: null },
            onMenu,
          )}
        />
      );
    case 'parked':
      return (
        <button
          type="button"
          onClick={onExpand}
          aria-label={`${entry.count} agent đã tạm trữ`}
          title={`${entry.count} agent tạm trữ · mở rộng để xem`}
          data-testid="rail-parked"
          className="flex h-8 w-[84px] shrink-0 cursor-pointer items-center justify-center rounded-[5px] border border-dashed border-border text-2xs text-text-muted hover:text-text"
        >
          +{entry.count} tạm trữ
        </button>
      );
    case 'break':
      return <hr className="my-1 w-16 border-border" />;
  }
}

/** A project's marker: its short name, a coloured tick, and the fold it toggles. */
function ProjectMarker({
  project,
  index,
  onToggle,
  triggers,
}: {
  project: ProjectNode;
  index: number;
  onToggle: () => void;
  triggers: AgentMenuTriggers<HTMLButtonElement>;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      {...triggers}
      aria-expanded={!project.collapsed}
      aria-label={project.name}
      title={`${project.name} · ${project.tooltip}`}
      data-testid={`rail-project-${project.key}`}
      data-flight-key={`project:${project.key}`}
      data-lane="rail"
      data-index={index}
      className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 px-1.5 pt-1 text-left hover:bg-btn-hover"
    >
      <span
        aria-hidden="true"
        className="h-3 w-[3px] shrink-0 rounded-full"
        style={{ backgroundColor: `var(--company-project-${project.tone})` }}
      />
      <span className="min-w-0 flex-1 truncate text-xs leading-4 text-text-muted">
        {shortProjectName(project.name)}
      </span>
    </button>
  );
}

function RailBadge({
  testId,
  flightKey,
  index,
  label,
  sub,
  tone,
  edgeClass,
  title,
  selected,
  onClick,
  triggers,
}: {
  testId: string;
  /** The key the board's motion follows this badge by. */
  flightKey: string;
  index: number;
  label: string;
  /** The status word under the code, so the rail reads without hovering. */
  sub: string;
  tone: DotTone;
  edgeClass: string;
  title: string;
  selected: boolean;
  onClick: () => void;
  triggers: AgentMenuTriggers<HTMLButtonElement>;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      {...triggers}
      aria-pressed={selected}
      aria-label={title}
      title={title}
      data-testid={testId}
      data-flight-key={flightKey}
      data-lane="rail"
      data-index={index}
      className={`relative flex h-11 w-[84px] shrink-0 cursor-pointer flex-col items-start justify-center rounded-[5px] border-l-4 pl-2 pr-4 text-left hover:bg-btn-hover ${edgeClass} ${selected ? 'bg-btn-bg ring-1 ring-accent' : ''}`}
    >
      <span className="w-full truncate font-mono text-xs text-text">{label}</span>
      <span className="w-full truncate text-xs text-text-muted">{sub}</span>
      <span className="absolute right-1.5 top-1.5 flex h-3 w-3 items-center justify-center">
        <StatusDot tone={tone} />
      </span>
    </button>
  );
}
