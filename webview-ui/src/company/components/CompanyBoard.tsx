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
 * When a card changes lane it arcs there, and a card that moves within its lane
 * glides (flip.ts); reduced motion skips both. A lane with no cards folds to a strip
 * that a click opens. Its width eases open or shut while its body fades in after it
 * (or out before it), so a card that lands in an empty lane opens that lane first.
 *
 * A card is a button, not a draggable: the only thing clicking does is select,
 * because status is the server's to change.
 *
 * An agent with work of its own and no task card (a herdr pane, or a company
 * session) shows as a card after the task cards. Clicking it opens that
 * agent; hovering previews its terminal, and right-click opens its menu.
 */

import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useRef,
  useState,
} from 'react';

import type { AgentBoardCard, AgentCardSubject } from '../agentBoard.js';
import type { AgentMenuRequest } from '../agentMenu.js';
import { relativeTimeVi } from '../agentSidebarView.js';
import type { BoardCard, BoardFlow, BoardLane, PlanningPrompt } from '../boardView.js';
import { WAIT_REASON_LABELS } from '../boardView.js';
import type { CompanyClient } from '../companyClient.js';
import {
  COMPANY_LANE_ICONS,
  COMPANY_LANE_OWNERS,
  COMPANY_MOTION,
  type CompanyLaneId,
} from '../constants.js';
import type { FolderIdentity } from '../folderIdentity.js';
import { packLanes } from '../laneLayout.js';
import {
  defaultActiveLane,
  LANE_SWIPE_THRESHOLD_PX,
  stepActiveLane,
  swipeStep,
} from '../layoutMode.js';
import { companyRoleLabel, ROLE_EDGE_CLASS } from '../roleProfiles.js';
import { type SquadRef, squadRunKey } from '../squadView.js';
import { taskStatusLabel } from '../statusLabels.js';
import type { PreviewTarget } from '../terminalPreview.js';
import { previewTriggers, useTerminalPreview } from '../terminalPreviewActions.js';
import { useAgentMenuGestures } from '../useAgentMenuGestures.js';
import { useElementWidth } from '../useElementWidth.js';
import { useFlightLayout } from '../useFlightLayout.js';
import { useLayoutMode } from '../useLayoutMode.js';
import { useNow } from '../useNow.js';
import { workItemKey,type WorkItemRef } from '../workItemView.js';
import { FolderTag } from './FolderTag.js';
import { Icon } from './Icon.js';
import { SquadRunCard } from './SquadRunCard.js';
import { StatusDot } from './StatusDot.js';
import { WorkItemCard } from './WorkItemCard.js';

export interface CompanyBoardProps {
  lanes: readonly BoardLane[];
  flow: BoardFlow;
  /** Prompts a Director is still planning; shown in the planned lane. */
  planning: readonly PlanningPrompt[];
  onSelectTask: (taskId: string) => void;
  onSelectSession: (sessionId: string) => void;
  /** Opens the drawer on a herdr pane's agent card. */
  onOpenHerdr: (paneId: string) => void;
  /** The herdr pane and session the drawer shows, so their agent cards read as pressed. */
  selectedPaneId: string | null;
  selectedSessionId: string | null;
  /** The work item the drawer shows, so its card reads as pressed. */
  selectedWorkItem: WorkItemRef | null;
  /** Opens the drawer on a work item card. */
  onOpenWorkItem: (ref: WorkItemRef) => void;
  /** The squad run the drawer shows, so its card reads as pressed. */
  selectedSquad: SquadRef | null;
  /** Opens the drawer on a squad run card. */
  onOpenSquad: (ref: SquadRef) => void;
  /** The client a squad card sends its approve, dismiss and retry commands through. */
  client: CompanyClient;
  onMenu: (request: AgentMenuRequest) => void;
  /** The folder a card's id belongs to, shown as a tag in all mode; null outside it. */
  identityOf: (id: string) => FolderIdentity | null;
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
  folder,
}: {
  prompt: PlanningPrompt;
  index: number;
  onSelect: () => void;
  onMenu: (request: AgentMenuRequest) => void;
  folder: FolderIdentity | null;
}) {
  const triggers = useAgentMenuGestures<HTMLButtonElement>(
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
      className={`company-card w-full p-2 text-left ${prompt.session === null ? 'cursor-default' : 'cursor-pointer'} ${ROLE_EDGE_CLASS.director}`}
    >
      <span className="line-clamp-2 break-normal text-sm font-medium leading-[1.3] text-text">
        {prompt.preview}
      </span>
      {folder !== null && <FolderTag identity={folder} className="mt-0.5" />}
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
      className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-1.5 text-2xs"
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
  folder,
}: {
  card: BoardCard;
  index: number;
  onSelect: () => void;
  onMenu: (request: AgentMenuRequest) => void;
  folder: FolderIdentity | null;
}) {
  const edge = card.session ? ROLE_EDGE_CLASS[card.session.role] : '';
  const actions = useTerminalPreview();
  const previewTarget: PreviewTarget | null = card.session
    ? { kind: 'session', sessionId: card.session.id }
    : null;
  const triggers = useAgentMenuGestures<HTMLButtonElement>(
    { kind: 'task', taskId: card.taskId, sessionId: card.session?.id ?? null, drawer: null },
    onMenu,
    previewTarget === null ? undefined : () => actions.press(previewTarget),
  );
  return (
    <button
      type="button"
      onClick={onSelect}
      {...(previewTarget === null ? {} : previewTriggers(actions, previewTarget))}
      {...triggers}
      aria-pressed={card.selected}
      title={taskDetail(card)}
      data-testid={`task-card-${card.code}`}
      data-task-id={card.taskId}
      data-flight-key={`task:${card.taskId}`}
      data-lane={card.lane}
      data-index={index}
      className={`company-card w-full cursor-pointer p-2 text-left ${edge} ${card.sentBack ? 'company-sent-back' : ''}`}
    >
      <span className="line-clamp-2 break-normal text-sm font-medium leading-[1.3] text-text">
        <span className="font-mono text-2xs text-text-muted">{card.code}</span> {card.title}
      </span>
      {folder !== null && <FolderTag identity={folder} />}
      <TaskMeta card={card} />
    </button>
  );
}

/**
 * An agent with work of its own and no task card: a herdr pane or a company
 * session. Its status dot and project line set it apart from the company's own work. The
 * lane already names its status, so the card prints no status word. It shows the
 * project and branch, the title, the newest activity, and when it last changed.
 */
function AgentCard({
  card,
  index,
  selected,
  onOpen,
  onMenu,
  now,
  folder,
}: {
  card: AgentBoardCard;
  index: number;
  selected: boolean;
  onOpen: () => void;
  onMenu: (request: AgentMenuRequest) => void;
  now: number;
  folder: FolderIdentity | null;
}) {
  const { subject } = card;
  const target: PreviewTarget =
    subject.kind === 'herdr'
      ? { kind: 'herdr', paneId: subject.paneId }
      : { kind: 'session', sessionId: subject.sessionId };
  const actions = useTerminalPreview();
  const triggers = useAgentMenuGestures<HTMLButtonElement>(
    subject.kind === 'herdr'
      ? { kind: 'herdr', paneId: subject.paneId, drawer: null }
      : { kind: 'session', sessionId: subject.sessionId, drawer: null },
    onMenu,
    () => actions.press(target),
  );
  const updated = card.updatedAt === null ? null : relativeTimeVi(card.updatedAt, now);
  return (
    <button
      type="button"
      onClick={onOpen}
      {...previewTriggers(actions, target)}
      {...triggers}
      aria-pressed={selected}
      title={`${card.tag} · ${card.project} · ${card.title} · ${card.statusLabel}`}
      data-testid="agent-card"
      data-agent-kind={subject.kind}
      data-flight-key={card.key}
      data-lane={card.lane}
      data-index={index}
      className="company-card flex w-full cursor-pointer flex-col gap-1 p-2 text-left"
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="flex shrink-0">
          <StatusDot tone={card.tone} />
        </span>
        <span className="min-w-0 flex-1 truncate text-2xs text-text-muted">{card.project}</span>
        {card.branch !== null && (
          <span className="min-w-0 max-w-[45%] truncate rounded-full bg-panel px-1.5 text-2xs text-text-muted">
            {card.branch}
          </span>
        )}
      </span>
      <span className="line-clamp-3 break-normal text-sm font-medium leading-[1.3] text-text">
        {card.title}
      </span>
      {folder !== null && <FolderTag identity={folder} />}
      {card.activity !== null && (
        <span className="line-clamp-2 break-words text-2xs text-text-muted">{card.activity}</span>
      )}
      {updated !== null && <span className="text-2xs text-text-muted">cập nhật {updated}</span>}
    </button>
  );
}

/** The lane a phone opens on when the reader has not picked one: where attention is needed first. */
const LANE_ATTENTION_ORDER: readonly CompanyLaneId[] = [
  'needs_input',
  'running',
  'review',
  'ready',
  'planned',
  'failed',
  'done',
];

/** The lanes row's padding on each side (p-1.5), taken out of the width the lanes pack into. */
const LANES_PADDING_PX = 6;

/** The motion custom properties the board's CSS reads (the lane rules in index.css): the ease and the lane width. */
const BOARD_MOTION_VARS: CSSProperties & Record<string, string> = {
  '--company-ease': COMPANY_MOTION.easing,
  '--company-lane-ms': `${COMPANY_MOTION.laneWidthMs}ms`,
};

/** One lane as the board draws it: its drafts and its card count. */
interface LaneView {
  lane: BoardLane;
  drafts: readonly PlanningPrompt[];
  count: number;
}

export function CompanyBoard({
  lanes,
  flow,
  planning,
  onSelectTask,
  onSelectSession,
  onOpenHerdr,
  selectedPaneId,
  selectedSessionId,
  selectedWorkItem,
  onOpenWorkItem,
  selectedSquad,
  onOpenSquad,
  client,
  onMenu,
  identityOf,
}: CompanyBoardProps) {
  const boardRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  useFlightLayout(boardRef);
  const now = useNow();
  const mode = useLayoutMode();
  const lanesWidth = useElementWidth(lanesRef, mode);
  // The lane a phone shows, once the reader has picked one; until then the attention default.
  const [pickedLane, setPickedLane] = useState<CompanyLaneId | null>(null);
  const swipeStart = useRef<{ pointerId: number; x: number; y: number } | null>(null);

  const views: LaneView[] = lanes.map((lane) => {
    const drafts = lane.id === 'planned' ? planning : [];
    const count =
      lane.cards.length +
      drafts.length +
      lane.workItems.length +
      lane.squads.length +
      lane.agents.length;
    return { lane, drafts, count };
  });
  const shownLane =
    pickedLane ??
    defaultActiveLane(
      views.map(({ lane, count }) => ({ id: lane.id, count })),
      LANE_ATTENTION_ORDER,
    );
  const packing = packLanes(views.length, lanesWidth - 2 * LANES_PADDING_PX);

  function openAgent(subject: AgentCardSubject): void {
    if (subject.kind === 'herdr') onOpenHerdr(subject.paneId);
    else onSelectSession(subject.sessionId);
  }

  // A phone's lanes move by swipe: a horizontal drag past the threshold steps one lane.
  function onSwipeStart(event: ReactPointerEvent<HTMLDivElement>): void {
    swipeStart.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  }

  function onSwipeEnd(event: ReactPointerEvent<HTMLDivElement>): void {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (start === null || start.pointerId !== event.pointerId || shownLane === null) return;
    const step = swipeStep(
      event.clientX - start.x,
      event.clientY - start.y,
      LANE_SWIPE_THRESHOLD_PX,
    );
    if (step === 0) return;
    const next = stepActiveLane(
      views.map((view) => view.lane.id),
      shownLane,
      step,
    );
    if (next !== null) setPickedLane(next);
  }

  function cancelSwipe(): void {
    swipeStart.current = null;
  }

  function renderLane(view: LaneView, fill: boolean, style?: CSSProperties) {
    const { lane, drafts, count } = view;
    return (
      <section
        key={lane.id}
        aria-label={lane.label}
        data-testid={`company-lane-${lane.id}`}
        data-lane={lane.id}
        className={`company-lane relative min-h-0 min-w-0 ${fill ? 'flex-1' : ''}`}
        style={style}
      >
        <div className="company-lane-body flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex flex-col gap-0.5 px-2 pt-2 pb-1">
            <h3 className="flex items-baseline justify-between gap-2 text-sm font-semibold text-text">
              <span className="min-w-0">
                <Icon name={COMPANY_LANE_ICONS[lane.id]} className="text-[var(--lane-color)]" />{' '}
                {lane.label}
              </span>
              <span className="shrink-0 text-xs font-normal text-text-muted">{count}</span>
            </h3>
            <p className="truncate text-xs text-status-active">{COMPANY_LANE_OWNERS[lane.id]}</p>
          </header>
          <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-1">
            {count === 0 && (
              <p className="px-1 text-xs text-text-muted">Chưa có việc nào ở cột này.</p>
            )}
            {drafts.map((prompt, index) => (
              <PlanningCard
                key={prompt.promptId}
                prompt={prompt}
                index={index}
                onSelect={() => prompt.session && onSelectSession(prompt.session.id)}
                onMenu={onMenu}
                folder={identityOf(prompt.promptId)}
              />
            ))}
            {lane.cards.map((card, index) => (
              <TaskCard
                key={card.taskId}
                card={card}
                index={index}
                onSelect={() => onSelectTask(card.taskId)}
                onMenu={onMenu}
                folder={identityOf(card.taskId)}
              />
            ))}
            {lane.workItems.map((card, index) => (
              <WorkItemCard
                key={workItemKey(card)}
                card={card}
                index={drafts.length + lane.cards.length + index}
                now={now}
                selected={
                  selectedWorkItem !== null &&
                  selectedWorkItem.id === card.id &&
                  selectedWorkItem.workspacePath === card.workspacePath
                }
                onOpen={() => onOpenWorkItem({ id: card.id, workspacePath: card.workspacePath })}
              />
            ))}
            {lane.squads.map((card, index) => (
              <SquadRunCard
                key={squadRunKey(card)}
                card={card}
                index={drafts.length + lane.cards.length + lane.workItems.length + index}
                selected={
                  selectedSquad !== null &&
                  selectedSquad.runId === card.runId &&
                  selectedSquad.workspacePath === card.workspacePath
                }
                client={client}
                onOpen={() => onOpenSquad({ runId: card.runId, workspacePath: card.workspacePath })}
              />
            ))}
            {lane.agents.map((agent, index) => (
              <AgentCard
                key={agent.key}
                card={agent}
                index={
                  drafts.length +
                  lane.cards.length +
                  lane.workItems.length +
                  lane.squads.length +
                  index
                }
                now={now}
                selected={
                  agent.subject.kind === 'herdr'
                    ? agent.subject.paneId === selectedPaneId
                    : agent.subject.sessionId === selectedSessionId
                }
                onOpen={() => openAgent(agent.subject)}
                onMenu={onMenu}
                folder={
                  agent.subject.kind === 'session' ? identityOf(agent.subject.sessionId) : null
                }
              />
            ))}
          </div>
        </div>
      </section>
    );
  }

  return (
    <div
      ref={boardRef}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      style={BOARD_MOTION_VARS}
      data-testid="company-board"
    >
      <FlowStrip flow={flow} />
      {mode === 'phone' ? (
        <>
          <div
            role="group"
            aria-label="Chọn cột việc"
            className="grid grid-flow-col auto-cols-fr gap-1 px-2 pt-1.5 pb-1"
          >
            {views.map(({ lane, count }) => (
              <button
                key={lane.id}
                type="button"
                aria-pressed={lane.id === shownLane}
                aria-label={`${lane.label}, ${count} việc`}
                onClick={() => setPickedLane(lane.id)}
                className="touch-target flex min-w-0 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-[var(--company-radius-sm)] px-1 py-1 text-2xs text-text-muted hover:bg-hover aria-pressed:bg-selected aria-pressed:text-text"
              >
                <Icon name={COMPANY_LANE_ICONS[lane.id]} className="text-sm" />
                <span className="font-semibold tabular-nums text-text">{count}</span>
              </button>
            ))}
          </div>
          <div
            className="flex min-h-0 min-w-0 flex-1 flex-col p-1.5"
            data-testid="company-lane-swipe"
            onPointerDown={onSwipeStart}
            onPointerUp={onSwipeEnd}
            onPointerCancel={cancelSwipe}
          >
            {views
              .filter((view) => view.lane.id === shownLane)
              .map((view) => renderLane(view, true))}
          </div>
        </>
      ) : (
        <div
          ref={lanesRef}
          className="company-lanes flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden p-1.5"
          data-testid="company-lanes"
          data-layout={mode}
        >
          {packing.rows.map((row) => (
            <div key={row.join(',')} className="flex min-h-0 min-w-0 flex-1 gap-1.5">
              {row.map((index) => {
                const view = views[index];
                if (view === undefined) return null;
                return renderLane(view, false, { flex: '0 0 auto', width: packing.width });
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
