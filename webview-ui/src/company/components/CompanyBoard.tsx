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
import { COMPANY_LANE_ICONS, COMPANY_LANE_OWNERS, type CompanyLaneId } from '../constants.js';
import type { FolderIdentity } from '../folderIdentity.js';
import { isLaneCollapsed, packLanes } from '../laneLayout.js';
import {
  defaultActiveLane,
  LANE_SWIPE_THRESHOLD_PX,
  stepActiveLane,
  swipeStep,
} from '../layoutMode.js';
import { companyRoleLabel, ROLE_EDGE_CLASS } from '../roleProfiles.js';
import { taskStatusLabel } from '../statusLabels.js';
import type { PreviewTarget } from '../terminalPreview.js';
import { previewTriggers, useTerminalPreview } from '../terminalPreviewActions.js';
import { useAgentMenuGestures } from '../useAgentMenuGestures.js';
import { useElementWidth } from '../useElementWidth.js';
import { useFlightLayout } from '../useFlightLayout.js';
import { useLayoutMode } from '../useLayoutMode.js';
import { useNow } from '../useNow.js';
import { FolderTag } from './FolderTag.js';
import { Icon } from './Icon.js';
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
  /** The herdr pane and session the drawer shows, so their agent cards read as pressed. */
  selectedPaneId: string | null;
  selectedSessionId: string | null;
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

/**
 * An empty lane folded to a strip: its mark, its count and its name, read top to
 * bottom. The lane's colour tints its mark. A click opens the
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
      className="flex h-full w-full cursor-pointer flex-col items-center gap-2 px-1 py-2 text-text-muted hover:bg-hover hover:text-text"
    >
      <Icon name={COMPANY_LANE_ICONS[lane.id]} className="text-sm text-[var(--lane-color)]" />
      <span className="text-2xs font-semibold text-text">{count}</span>
      <span className="flex-1 whitespace-nowrap text-xs [writing-mode:vertical-rl]">
        {lane.label}
      </span>
      <span className="sr-only">Không có gì ở đây.</span>
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

/** One lane as the board draws it: its drafts, its card count and whether it folds to a strip. */
interface LaneView {
  lane: BoardLane;
  drafts: readonly PlanningPrompt[];
  count: number;
  collapsed: boolean;
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
  onMenu,
  identityOf,
}: CompanyBoardProps) {
  const boardRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  useFlightLayout(boardRef);
  const now = useNow();
  const mode = useLayoutMode();
  const lanesWidth = useElementWidth(lanesRef, mode);
  // Empty lanes the reader opened from their strip. A lane with cards is open whatever this holds.
  const [openedLanes, setOpenedLanes] = useState<ReadonlySet<CompanyLaneId>>(() => new Set());
  // The lane a phone shows, once the reader has picked one; until then the attention default.
  const [pickedLane, setPickedLane] = useState<CompanyLaneId | null>(null);
  const swipeStart = useRef<{ pointerId: number; x: number; y: number } | null>(null);

  const views: LaneView[] = lanes.map((lane) => {
    const drafts = lane.id === 'planned' ? planning : [];
    const count = lane.cards.length + drafts.length + lane.agents.length;
    // A phone shows its one lane open, so an empty lane is never folded there.
    const collapsed = mode !== 'phone' && isLaneCollapsed(count, openedLanes.has(lane.id));
    return { lane, drafts, count, collapsed };
  });
  const shownLane =
    pickedLane ??
    defaultActiveLane(
      views.map(({ lane, count }) => ({ id: lane.id, count })),
      LANE_ATTENTION_ORDER,
    );
  const packing = packLanes(
    views.map((view) => ({ collapsed: view.collapsed })),
    lanesWidth - 2 * LANES_PADDING_PX,
  );

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
    const { lane, drafts, count, collapsed } = view;
    return (
      <section
        key={lane.id}
        aria-label={lane.label}
        data-testid={`company-lane-${lane.id}`}
        data-lane={lane.id}
        data-collapsed={collapsed}
        className={`company-lane min-h-0 min-w-0 ${fill ? 'flex-1' : ''}`}
        style={style}
      >
        {collapsed ? (
          <LaneStrip lane={lane} count={count} onOpen={() => toggleLane(lane.id)} />
        ) : (
          <>
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
                <div className="flex flex-col items-start gap-1 px-1">
                  <p className="text-xs text-text-muted">Chưa có việc nào ở cột này.</p>
                  {mode !== 'phone' && (
                    <button
                      type="button"
                      onClick={() => toggleLane(lane.id)}
                      className="company-icon-btn touch-target px-1 text-2xs"
                    >
                      Thu gọn cột
                    </button>
                  )}
                </div>
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
              {lane.agents.map((agent, index) => (
                <AgentCard
                  key={agent.key}
                  card={agent}
                  index={lane.cards.length + drafts.length + index}
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
          </>
        )}
      </section>
    );
  }

  return (
    <div
      ref={boardRef}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
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
                const width = packing.widths[index];
                if (view === undefined || width === undefined) return null;
                return renderLane(view, false, { flex: `0 0 ${width}px`, width });
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
