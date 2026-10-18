/**
 * CompanyBoard: the lanes, read from server state.
 *
 * The board is flow management, not a second workflow engine: the SERVER owns
 * every status, and this column shows where work actually is. Two things make
 * that readable at a glance:
 *
 *  - The flow strip above the lanes says how much is moving (running cards
 *    against the configured worker limit) and how much is held up, so a stalled
 *    board is visibly stalled instead of quietly full. There is no utilisation
 *    percentage: the company has no definition to divide by.
 *  - Each stalled card says WHY it is not moving. Blocked by a dependency, held
 *    for an answer, paused, and queued behind a full running lane are four
 *    different problems, and the user acts on them differently.
 *
 * Each lane names who holds its cards, and a card in review names whether QA or
 * the Trọng tài holds it. A card sent back after a failed verification says so.
 * When a card changes lane, it flies there (flip.ts); reduced motion skips it. A lane
 * with no cards folds to a strip that a click opens, and a card that lands in an empty
 * lane opens that lane first, so the flight has room to land.
 *
 * A card is a button, not a draggable: the only thing clicking does is select,
 * because status is the server's to change.
 *
 * An agent with work of its own and no task card (a herdr pane, or a company
 * session) shows as a dashed card after the task cards. Clicking it opens that
 * agent; hovering previews its terminal, and right-click opens its menu.
 *
 * Hibernated sessions sit in a lane after the others, and that lane folds to a strip while
 * it is empty. A card there opens the session's drawer, where it can be woken.
 */

import { useRef, useState } from 'react';

import type { AgentBoardCard, AgentCardSubject } from '../agentBoard.js';
import { type AgentMenuRequest, agentMenuTriggers } from '../agentMenu.js';
import { type SleepingRow, sleepingTooltip } from '../agentSidebarView.js';
import type { BoardCard, BoardFlow, BoardLane, PlanningPrompt } from '../boardView.js';
import { WAIT_REASON_LABELS } from '../boardView.js';
import { COMPANY_LANE_ICONS, COMPANY_LANE_OWNERS, type CompanyLaneId } from '../constants.js';
import { isLaneCollapsed, laneColumnStyle } from '../laneLayout.js';
import { companyRoleLabel, ROLE_EDGE_CLASS } from '../roleProfiles.js';
import { taskStatusLabel } from '../statusLabels.js';
import type { PreviewTarget } from '../terminalPreview.js';
import { previewTriggers, useTerminalPreview } from '../terminalPreviewActions.js';
import { useFlightLayout } from '../useFlightLayout.js';
import { StatusDot } from './StatusDot.js';

export interface CompanyBoardProps {
  lanes: readonly BoardLane[];
  flow: BoardFlow;
  /** Prompts a Director is still planning; shown in the planned lane. */
  planning: readonly PlanningPrompt[];
  onSelectTask: (taskId: string) => void;
  onSelectSession: (sessionId: string) => void;
  /** Opens the drawer on a herdr pane's agent card. */
  onOpenHerdr: (paneId: string) => void;
  /** Opens a hibernated session's drawer, where it can be woken. */
  onOpenSleeping: (paneId: string) => void;
  /** The hibernated sessions, most recently slept first. */
  sleeping: readonly SleepingRow[];
  /** The herdr pane and session the drawer shows, so their agent cards read as pressed. */
  selectedPaneId: string | null;
  selectedSessionId: string | null;
  onMenu: (request: AgentMenuRequest) => void;
}

/**
 * The detail a compact task card leaves out: its status word, contract, session,
 * evidence and route reason. It reads from the card's tooltip; the drawer shows the rest.
 */
function taskDetail(card: BoardCard): string {
  const lines = [
    `${card.code} ${card.title}`,
    taskStatusLabel(card.status),
    `${card.contractCode} · ${card.phaseTitle}`,
  ];
  if (card.session) {
    const model = card.session.effectiveModel ?? card.session.requestedModel;
    const mismatch =
      card.session.effectiveModel !== null &&
      card.session.effectiveModel !== card.session.requestedModel;
    lines.push(
      `${card.session.code} · ${companyRoleLabel(card.session.role)} · ${model}${mismatch ? ' (khác với mô hình đã yêu cầu)' : ''}`,
    );
  }
  if (card.evidence.total > 0) {
    const failed = card.evidence.failed > 0 ? ` (${card.evidence.failed} thất bại)` : '';
    lines.push(`bằng chứng ${card.evidence.passed}/${card.evidence.total}${failed}`);
  }
  if (card.routeReason) lines.push(card.routeReason);
  return lines.join('\n');
}

/**
 * A prompt a Director is still planning. The board lists it only while no Contract
 * holds it (planningPrompts). Its menu offers the cancel while the server can still
 * withdraw the prompt; a prompt with no session yet has no drawer to open.
 */
function PlanningCard({
  prompt,
  index,
  onSelect,
  onMenu,
}: {
  prompt: PlanningPrompt;
  index: number;
  onSelect: () => void;
  onMenu: (request: AgentMenuRequest) => void;
}) {
  const triggers = agentMenuTriggers<HTMLButtonElement>(
    { kind: 'planning', promptId: prompt.promptId, sessionId: prompt.session?.id ?? null },
    onMenu,
  );
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-disabled={prompt.session === null}
      {...triggers}
      title={prompt.preview}
      data-testid="planning-card"
      data-flight-key={`prompt:${prompt.promptId}`}
      data-lane="planned"
      data-index={index}
      className={`company-card w-full border-dashed border-l-4 p-2 text-left ${prompt.session === null ? 'cursor-default' : 'cursor-pointer'} ${ROLE_EDGE_CLASS.director}`}
    >
      <span className="line-clamp-2 break-normal text-sm font-medium leading-[1.3] text-text">
        {prompt.preview}
      </span>
      <span className="mt-0.5 block truncate text-2xs text-text-muted">
        Giám đốc đang lập kế hoạch
        {prompt.session && (
          <>
            {' '}
            &middot; <span className="font-mono">{prompt.session.code}</span> &middot;{' '}
            {prompt.session.effectiveModel ?? prompt.session.requestedModel}
          </>
        )}
      </span>
    </button>
  );
}

function FlowStrip({ flow }: { flow: BoardFlow }) {
  const limit = flow.runningLimit === null ? '?' : String(flow.runningLimit);
  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-3 py-1.5 text-2xs"
      data-testid="board-flow"
    >
      <span className="text-text">
        đang chạy <span className="text-accent-bright">{flow.running}</span> / {limit}
      </span>
      <span className="text-text-muted">xếp hàng {flow.ready}</span>
      <span className="text-text-muted">bị chặn {flow.blocked}</span>
      <span className={flow.awaitingAnswer > 0 ? 'text-warning' : 'text-text-muted'}>
        chờ bạn {flow.awaitingAnswer}
      </span>
      <span className="text-text-muted">xong {flow.done}</span>
      <span className={flow.failed > 0 ? 'text-warning' : 'text-text-muted'}>
        thất bại {flow.failed}
      </span>
      {flow.queuedBehindWip && (
        <span className="text-warning" data-testid="flow-queued-behind-wip">
          đang xếp hàng vì cột đang chạy đã đầy
        </span>
      )}
    </div>
  );
}

/**
 * The one meta line under a task's title. It names what holds the card: sent back,
 * the reviewer it waits on, or why it is not moving. A card that nothing holds
 * shows its contract and phase instead. Everything else reads from the tooltip.
 */
function TaskMeta({ card }: { card: BoardCard }) {
  if (!card.sentBack && card.reviewOwner === null && !card.waitReason) {
    return (
      <span className="mt-0.5 block truncate text-2xs text-text-muted">
        {card.contractCode} &middot; {card.phaseTitle}
      </span>
    );
  }
  return (
    <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-2xs">
      {card.sentBack && <span className="shrink-0 text-warning">trả lại</span>}
      {card.reviewOwner !== null && (
        <span
          className={`shrink-0 ${card.reviewOwner === 'QA' ? 'text-status-active' : 'text-orchid'}`}
        >
          chờ {card.reviewOwner}
        </span>
      )}
      {card.waitReason && (
        <span className="min-w-0 truncate text-warning" data-testid={`wait-${card.code}`}>
          {card.waitReason === 'blocked_by_dependencies'
            ? `${WAIT_REASON_LABELS[card.waitReason]} (${card.blockedByCodes.join(', ')})`
            : WAIT_REASON_LABELS[card.waitReason]}
        </span>
      )}
    </span>
  );
}

function TaskCard({
  card,
  index,
  onSelect,
  onMenu,
}: {
  card: BoardCard;
  index: number;
  onSelect: () => void;
  onMenu: (request: AgentMenuRequest) => void;
}) {
  const edge = card.session ? ROLE_EDGE_CLASS[card.session.role] : 'border-l-border';
  const triggers = agentMenuTriggers<HTMLButtonElement>(
    { kind: 'task', taskId: card.taskId, sessionId: card.session?.id ?? null, drawer: null },
    onMenu,
  );
  const actions = useTerminalPreview();
  return (
    <button
      type="button"
      onClick={onSelect}
      {...triggers}
      {...(card.session
        ? previewTriggers(actions, { kind: 'session', sessionId: card.session.id })
        : {})}
      aria-pressed={card.selected}
      title={taskDetail(card)}
      data-testid={`task-card-${card.code}`}
      data-task-id={card.taskId}
      data-flight-key={`task:${card.taskId}`}
      data-lane={card.lane}
      data-index={index}
      className={`company-card w-full cursor-pointer border-l-4 p-2 text-left ${edge} ${card.sentBack ? 'company-sent-back' : ''}`}
    >
      <span className="line-clamp-2 break-normal text-sm font-medium leading-[1.3] text-text">
        <span className="font-mono text-2xs text-text-muted">{card.code}</span> {card.title}
      </span>
      <TaskMeta card={card} />
    </button>
  );
}

/**
 * An agent with work of its own and no task card: a herdr pane or a company
 * session. Its card is dashed, so it never reads as the company's own work. The
 * lane already names its status, so the card shows only the repo and the title.
 */
function AgentCard({
  card,
  index,
  selected,
  onOpen,
  onMenu,
}: {
  card: AgentBoardCard;
  index: number;
  selected: boolean;
  onOpen: () => void;
  onMenu: (request: AgentMenuRequest) => void;
}) {
  const { subject } = card;
  const triggers = agentMenuTriggers<HTMLButtonElement>(
    subject.kind === 'herdr'
      ? { kind: 'herdr', paneId: subject.paneId, drawer: null }
      : { kind: 'session', sessionId: subject.sessionId, drawer: null },
    onMenu,
  );
  const target: PreviewTarget =
    subject.kind === 'herdr'
      ? { kind: 'herdr', paneId: subject.paneId }
      : { kind: 'session', sessionId: subject.sessionId };
  const actions = useTerminalPreview();
  return (
    <button
      type="button"
      onClick={onOpen}
      {...triggers}
      {...previewTriggers(actions, target)}
      aria-pressed={selected}
      title={`${card.tag} · ${card.project} · ${card.title} · ${card.statusLabel}`}
      data-testid="agent-card"
      data-agent-kind={subject.kind}
      data-flight-key={card.key}
      data-lane={card.lane}
      data-index={index}
      className="company-card flex w-full cursor-pointer items-start gap-1.5 border-dashed p-2 text-left"
    >
      <span className="mt-1 flex shrink-0">
        <StatusDot tone={card.tone} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-2xs text-text-muted">{card.project}</span>
        <span className="block truncate text-sm font-medium text-text">{card.title}</span>
      </span>
    </button>
  );
}

/**
 * An empty lane folded to a strip: its mark, its count and its name, read top to
 * bottom. The lane's colour rule runs along the strip's top edge. A click opens the
 * lane. The words stay in the DOM for screen readers and text search.
 */
function LaneStrip({
  lane,
  count,
  onOpen,
}: {
  lane: BoardLane;
  count: number;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`Mở cột ${lane.label}`}
      className="flex h-full w-full cursor-pointer flex-col items-center gap-2 px-1 py-2 text-text-muted hover:bg-btn-hover hover:text-text"
    >
      <span aria-hidden="true">{COMPANY_LANE_ICONS[lane.id]}</span>
      <span className="text-2xs font-semibold text-text">{count}</span>
      <span className="flex-1 whitespace-nowrap text-xs [writing-mode:vertical-rl]">
        {lane.label}
      </span>
      <span className="sr-only">Không có gì ở đây.</span>
    </button>
  );
}

/**
 * A hibernated session on the board: dashed like an agent card, with the sleep glyph and
 * when it slept. Its click opens the drawer, where it can be woken; its menu offers the wake.
 */
function SleepingCard({
  row,
  index,
  selected,
  onOpen,
  onMenu,
}: {
  row: SleepingRow;
  index: number;
  selected: boolean;
  onOpen: () => void;
  onMenu: (request: AgentMenuRequest) => void;
}) {
  const triggers = agentMenuTriggers<HTMLButtonElement>(
    { kind: 'sleeping', paneId: row.paneId, drawer: null },
    onMenu,
  );
  const actions = useTerminalPreview();
  return (
    <button
      type="button"
      onClick={onOpen}
      {...triggers}
      {...previewTriggers(actions, { kind: 'herdr', paneId: row.paneId })}
      aria-pressed={selected}
      title={sleepingTooltip(row)}
      data-testid="sleeping-card"
      data-flight-key={`sleeping:${row.paneId}`}
      data-lane="sleeping"
      data-index={index}
      className="company-card flex w-full cursor-pointer items-start gap-1.5 border-dashed p-2 text-left opacity-75"
    >
      <span aria-hidden="true" className="mt-0.5 shrink-0 text-xs">
        💤
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-2xs text-text-muted">{row.repo.label}</span>
        <span className="block truncate text-sm font-medium text-text">{row.name}</span>
        {row.sleptLabel !== null && (
          <span className="block truncate text-2xs text-text-muted">{row.sleptLabel}</span>
        )}
      </span>
    </button>
  );
}

/**
 * The sleeping lane, after the board's lanes. It folds to a strip while it holds nothing and
 * its reader has not opened it, the same rule as an empty task lane.
 */
function SleepingLane({
  sleeping,
  selectedPaneId,
  onOpen,
  onMenu,
}: {
  sleeping: readonly SleepingRow[];
  selectedPaneId: string | null;
  onOpen: (paneId: string) => void;
  onMenu: (request: AgentMenuRequest) => void;
}) {
  const [opened, setOpened] = useState(false);
  const count = sleeping.length;
  const collapsed = isLaneCollapsed(count, opened);
  return (
    <section
      aria-label="Ngủ đông"
      data-testid="company-lane-sleeping"
      data-lane="sleeping"
      data-collapsed={collapsed}
      className="company-lane"
      style={laneColumnStyle(collapsed)}
    >
      {collapsed ? (
        <button
          type="button"
          onClick={() => setOpened(true)}
          title="Mở cột Ngủ đông"
          className="flex h-full w-full cursor-pointer flex-col items-center gap-2 px-1 py-2 text-text-muted hover:bg-btn-hover hover:text-text"
        >
          <span aria-hidden="true">💤</span>
          <span className="text-2xs font-semibold text-text">{count}</span>
          <span className="flex-1 whitespace-nowrap text-xs [writing-mode:vertical-rl]">
            Ngủ đông
          </span>
          <span className="sr-only">Không có phiên nào ngủ đông.</span>
        </button>
      ) : (
        <>
          <header className="company-lane-head flex flex-col gap-0.5 px-2 py-1">
            <h3 className="flex items-baseline justify-between gap-2 text-sm font-semibold text-text">
              <span className="min-w-0">💤 Ngủ đông</span>
              <span className="shrink-0 text-xs font-normal text-text-muted">{count}</span>
            </h3>
            <p className="truncate text-xs text-text-muted">Mở một phiên để đánh thức</p>
          </header>
          <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-1">
            {count === 0 && (
              <div className="flex flex-col items-start gap-1 px-1">
                <p className="text-xs text-text-muted">Không có phiên nào ngủ đông.</p>
                <button
                  type="button"
                  onClick={() => setOpened(false)}
                  className="cursor-pointer text-2xs text-text-muted hover:text-text"
                >
                  Thu gọn cột
                </button>
              </div>
            )}
            {sleeping.map((row, index) => (
              <SleepingCard
                key={row.paneId}
                row={row}
                index={index}
                selected={row.paneId === selectedPaneId}
                onOpen={() => onOpen(row.paneId)}
                onMenu={onMenu}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

export function CompanyBoard({
  lanes,
  flow,
  planning,
  onSelectTask,
  onSelectSession,
  onOpenHerdr,
  onOpenSleeping,
  sleeping,
  selectedPaneId,
  selectedSessionId,
  onMenu,
}: CompanyBoardProps) {
  const boardRef = useRef<HTMLDivElement>(null);
  useFlightLayout(boardRef);
  // Empty lanes the reader opened from their strip. A lane with cards is open whatever this holds.
  const [openedLanes, setOpenedLanes] = useState<ReadonlySet<CompanyLaneId>>(() => new Set());

  function toggleLane(laneId: CompanyLaneId): void {
    setOpenedLanes((current) => {
      const next = new Set(current);
      if (next.has(laneId)) next.delete(laneId);
      else next.add(laneId);
      return next;
    });
  }

  function openAgent(subject: AgentCardSubject): void {
    if (subject.kind === 'herdr') onOpenHerdr(subject.paneId);
    else onSelectSession(subject.sessionId);
  }

  return (
    <div
      ref={boardRef}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="company-board"
    >
      <FlowStrip flow={flow} />
      <div className="company-lanes flex min-h-0 flex-1 gap-1.5 overflow-x-auto p-1.5">
        {lanes.map((lane) => {
          const drafts = lane.id === 'planned' ? planning : [];
          const count = lane.cards.length + drafts.length + lane.agents.length;
          const collapsed = isLaneCollapsed(count, openedLanes.has(lane.id));
          return (
            <section
              key={lane.id}
              aria-label={lane.label}
              data-testid={`company-lane-${lane.id}`}
              data-lane={lane.id}
              data-collapsed={collapsed}
              className="company-lane"
              style={laneColumnStyle(collapsed)}
            >
              {collapsed ? (
                <LaneStrip lane={lane} count={count} onOpen={() => toggleLane(lane.id)} />
              ) : (
                <>
                  <header className="company-lane-head flex flex-col gap-0.5 px-2 py-1">
                    <h3 className="flex items-baseline justify-between gap-2 text-sm font-semibold text-text">
                      <span className="min-w-0">
                        {COMPANY_LANE_ICONS[lane.id]} {lane.label}
                      </span>
                      <span className="shrink-0 text-xs font-normal text-text-muted">{count}</span>
                    </h3>
                    <p className="truncate text-xs text-status-active">
                      {COMPANY_LANE_OWNERS[lane.id]}
                    </p>
                  </header>
                  <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-1">
                    {count === 0 && (
                      <div className="flex flex-col items-start gap-1 px-1">
                        <p className="text-xs text-text-muted">Không có gì ở đây.</p>
                        <button
                          type="button"
                          onClick={() => toggleLane(lane.id)}
                          className="cursor-pointer text-2xs text-text-muted hover:text-text"
                        >
                          Thu gọn cột
                        </button>
                      </div>
                    )}
                    {drafts.map((prompt, index) => (
                      <PlanningCard
                        key={prompt.promptId}
                        prompt={prompt}
                        index={index}
                        onSelect={() => prompt.session && onSelectSession(prompt.session.id)}
                        onMenu={onMenu}
                      />
                    ))}
                    {lane.cards.map((card, index) => (
                      <TaskCard
                        key={card.taskId}
                        card={card}
                        index={index}
                        onSelect={() => onSelectTask(card.taskId)}
                        onMenu={onMenu}
                      />
                    ))}
                    {lane.agents.map((agent, index) => (
                      <AgentCard
                        key={agent.key}
                        card={agent}
                        index={lane.cards.length + drafts.length + index}
                        selected={
                          agent.subject.kind === 'herdr'
                            ? agent.subject.paneId === selectedPaneId
                            : agent.subject.sessionId === selectedSessionId
                        }
                        onOpen={() => openAgent(agent.subject)}
                        onMenu={onMenu}
                      />
                    ))}
                  </div>
                </>
              )}
            </section>
          );
        })}
        <SleepingLane
          sleeping={sleeping}
          selectedPaneId={selectedPaneId}
          onOpen={onOpenSleeping}
          onMenu={onMenu}
        />
      </div>
    </div>
  );
}
