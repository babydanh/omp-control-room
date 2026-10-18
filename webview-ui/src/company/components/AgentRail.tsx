/**
 * AgentRail: the collapsed sidebar. One badge per agent, a repo's herdr panes
 * under its tag, and one "+N" badge for the parked sessions, so every agent the
 * sidebar lists stays in view at rail width. A badge's tooltip carries its name,
 * status and summary.
 */

import { type AgentMenuRequest, type AgentMenuTriggers, agentMenuTriggers } from '../agentMenu.js';
import {
  activityCounts,
  agentTooltip,
  buildAgentGroups,
  buildRail,
  herdrGroup,
  herdrTooltip,
  paneShortCode,
  type RailEntry,
  sessionShortCode,
} from '../agentSidebarView.js';
import type { CompanyViewState } from '../companyState.js';
import { COMPANY_RAIL_WIDTH_PX } from '../constants.js';
import { ROLE_EDGE_CLASS } from '../roleProfiles.js';
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
  /** Expands the sidebar back to its full width. */
  onExpand: () => void;
  onSelectSession: (sessionId: string) => void;
  onOpenHerdr: (paneId: string) => void;
  onMenu: (request: AgentMenuRequest) => void;
}

export function AgentRail({
  state,
  selectedSessionId,
  selectedPaneId,
  onExpand,
  onSelectSession,
  onOpenHerdr,
  onMenu,
}: AgentRailProps) {
  const now = useNow();
  const groups = buildAgentGroups(state, now);
  const herdr = herdrGroup(state.herdr);
  const entries = buildRail(groups, herdr);
  const counts = activityCounts(groups, herdr);

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
      <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto py-2">
        {entries.map((entry, index) => (
          <RailEntryView
            key={railKey(entry, index)}
            entry={entry}
            selectedSessionId={selectedSessionId}
            selectedPaneId={selectedPaneId}
            onExpand={onExpand}
            onSelectSession={onSelectSession}
            onOpenHerdr={onOpenHerdr}
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
    case 'session':
      return `session:${entry.row.sessionId}`;
    case 'pane':
      return `pane:${entry.row.paneId}`;
    case 'repo':
      return `repo:${entry.key}`;
    case 'parked':
      return 'parked';
    case 'break':
      return `break:${index}`;
  }
}

function RailEntryView({
  entry,
  selectedSessionId,
  selectedPaneId,
  onExpand,
  onSelectSession,
  onOpenHerdr,
  onMenu,
}: {
  entry: RailEntry;
  selectedSessionId: string | null;
  selectedPaneId: string | null;
  onExpand: () => void;
  onSelectSession: (sessionId: string) => void;
  onOpenHerdr: (paneId: string) => void;
  onMenu: (request: AgentMenuRequest) => void;
}) {
  switch (entry.kind) {
    case 'session':
      return (
        <RailBadge
          testId={`rail-session-${entry.row.code}`}
          label={sessionShortCode(entry.row.code)}
          sub={entry.row.label}
          tone={entry.row.tone}
          edgeClass={ROLE_EDGE_CLASS[entry.row.role]}
          title={agentTooltip(entry.row)}
          selected={entry.row.sessionId === selectedSessionId}
          onClick={() => onSelectSession(entry.row.sessionId)}
          triggers={agentMenuTriggers<HTMLButtonElement>(
            { kind: 'session', sessionId: entry.row.sessionId },
            onMenu,
          )}
        />
      );
    case 'pane':
      return (
        <RailBadge
          testId={`rail-pane-${entry.row.paneId}`}
          label={`${entry.row.kind} ${paneShortCode(entry.row.paneId)}`}
          sub={entry.row.label}
          tone={entry.row.tone}
          edgeClass={PANE_EDGE_CLASS}
          title={herdrTooltip(entry.row)}
          selected={entry.row.paneId === selectedPaneId}
          onClick={() => onOpenHerdr(entry.row.paneId)}
          triggers={agentMenuTriggers<HTMLButtonElement>(
            { kind: 'herdr', paneId: entry.row.paneId },
            onMenu,
          )}
        />
      );
    case 'repo':
      return (
        <span
          title={entry.label}
          data-testid={`rail-repo-${entry.key}`}
          className="w-full truncate px-2 pt-1 font-mono text-2xs leading-4 text-text-muted"
        >
          {entry.label}
        </span>
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

function RailBadge({
  testId,
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
      className={`relative flex h-11 w-[84px] shrink-0 cursor-pointer flex-col items-start justify-center rounded-[5px] border-l-4 pl-2 pr-4 text-left hover:bg-btn-hover ${edgeClass} ${selected ? 'bg-btn-bg ring-1 ring-accent' : ''}`}
    >
      <span className="w-full truncate font-mono text-xs text-text">{label}</span>
      <span className="w-full truncate text-2xs text-text-muted">{sub}</span>
      <span className="absolute right-1.5 top-1.5 flex h-3 w-3 items-center justify-center">
        <StatusDot tone={tone} />
      </span>
    </button>
  );
}
