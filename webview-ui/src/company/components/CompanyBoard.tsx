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
 * When a card changes lane, it flies there (flip.ts); reduced motion skips it.
 *
 * A card is a button, not a draggable: the only thing clicking does is select,
 * because status is the server's to change.
 *
 * An agent with work of its own and no task card (a herdr pane, or a company
 * session) shows as a dashed card after the task cards. Clicking it opens that
 * agent; hovering previews its terminal, and right-click opens its menu.
 */

import { useRef } from 'react';

import type { AgentBoardCard, AgentCardSubject } from '../agentBoard.js';
import { type AgentMenuRequest, agentMenuTriggers } from '../agentMenu.js';
import type { BoardCard, BoardFlow, BoardLane, PlanningPrompt } from '../boardView.js';
import { WAIT_REASON_LABELS } from '../boardView.js';
import {
  COMPANY_LANE_EMPTY_WIDTH_PX,
  COMPANY_LANE_ICONS,
  COMPANY_LANE_MIN_WIDTH_PX,
  COMPANY_LANE_OWNERS,
} from '../constants.js';
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
  /** The herdr pane and session the drawer shows, so their agent cards read as pressed. */
  selectedPaneId: string | null;
  selectedSessionId: string | null;
  onMenu: (request: AgentMenuRequest) => void;
}

/** How loud a card's status line is. Red marks a card that needs the user or failed. */
type CardTone = 'live' | 'ok' | 'alert' | 'plain';

const CARD_TONE_CLASS: Readonly<Record<CardTone, string>> = {
  live: 'text-accent',
  ok: 'text-status-success',
  alert: 'text-warning',
  plain: 'text-text-muted',
};

/** The chip shape the owner and sent-back tags share. */
const PILL_CLASS = 'mt-1 inline-block rounded-full bg-btn-bg px-2 text-2xs';

/** The status line an agent card prints, in the colour of the lane it sits in. */
const AGENT_STATUS_CLASS: Readonly<Record<AgentBoardCard['lane'], string>> = {
  planned: 'text-text-muted',
  ready: 'text-text-muted',
  running: 'text-accent',
  needs_input: 'text-warning',
  review: 'text-text-muted',
  done: 'text-status-success',
  failed: 'text-warning',
};

function cardTone(card: BoardCard): CardTone {
  if (card.sentBack || card.lane === 'needs_input' || card.lane === 'failed') return 'alert';
  if (card.lane === 'done') return 'ok';
  if (card.lane === 'running') return 'live';
  return 'plain';
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
      className={`company-card w-full border-dashed border-l-4 px-2.5 py-2 text-left ${prompt.session === null ? 'cursor-default' : 'cursor-pointer'} ${ROLE_EDGE_CLASS.director}`}
    >
      <span className="line-clamp-3 break-normal text-base font-medium leading-[1.35] text-text">
        {prompt.preview}
      </span>
      <span className="mt-1 block text-xs text-text-muted">Giám đốc đang lập kế hoạch</span>
      {prompt.session && (
        <span className="mt-1 block text-xs text-text-muted">
          <span className="font-mono">{prompt.session.code}</span> &middot;{' '}
          {prompt.session.effectiveModel ?? prompt.session.requestedModel}
        </span>
      )}
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

function EvidenceBadges({ card }: { card: BoardCard }) {
  if (card.evidence.total === 0 && card.pendingQuestions === 0) return null;
  return (
    <p className="mt-1 flex flex-wrap gap-2 text-2xs text-text-muted">
      {card.evidence.total > 0 && (
        <span>
          bằng chứng {card.evidence.passed}/{card.evidence.total}
          {card.evidence.failed > 0 && (
            <span className="text-warning"> ({card.evidence.failed} thất bại)</span>
          )}
        </span>
      )}
    </p>
  );
}

/** Who a card in review waits on, as a chip; nothing for other lanes. */
function OwnerChip({ card }: { card: BoardCard }) {
  if (card.reviewOwner === null) return null;
  const tone = card.reviewOwner === 'QA' ? 'text-status-active' : 'text-orchid';
  return <span className={`${PILL_CLASS} ${tone}`}>chờ {card.reviewOwner}</span>;
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
      title={`${card.code} ${card.title}`}
      data-testid={`task-card-${card.code}`}
      data-task-id={card.taskId}
      data-flight-key={`task:${card.taskId}`}
      data-lane={card.lane}
      data-index={index}
      className={`company-card w-full cursor-pointer border-l-4 px-2.5 py-2 text-left ${edge} ${card.sentBack ? 'company-sent-back' : ''}`}
    >
      <span className="line-clamp-3 break-normal text-base font-medium leading-[1.35] text-text">
        <span className="font-mono text-xs text-text-muted">{card.code}</span> {card.title}
      </span>
      <span className={`mt-1 block text-xs ${CARD_TONE_CLASS[cardTone(card)]}`}>
        {taskStatusLabel(card.status)}
      </span>
      {card.sentBack && <span className={`${PILL_CLASS} text-warning`}>trả lại</span>}
      <OwnerChip card={card} />
      {card.waitReason && (
        <span className="mt-1 block text-xs text-warning" data-testid={`wait-${card.code}`}>
          {card.waitReason === 'blocked_by_dependencies'
            ? `${WAIT_REASON_LABELS[card.waitReason]} (${card.blockedByCodes.join(', ')})`
            : WAIT_REASON_LABELS[card.waitReason]}
        </span>
      )}
      <span className="mt-1 block text-xs text-text-muted">
        {card.contractCode} &middot; {card.phaseTitle}
      </span>
      {card.session && (
        <span className="mt-1 block text-xs text-text-muted">
          <span className="font-mono">{card.session.code}</span> &middot;{' '}
          {companyRoleLabel(card.session.role)} &middot;{' '}
          {card.session.effectiveModel ?? card.session.requestedModel}
          {card.session.effectiveModel !== null &&
            card.session.effectiveModel !== card.session.requestedModel && (
              <span className="text-warning"> (khác với mô hình đã yêu cầu)</span>
            )}
        </span>
      )}
      {card.routeReason && (
        <span className="mt-1 block text-xs italic text-text-muted">{card.routeReason}</span>
      )}
      <EvidenceBadges card={card} />
    </button>
  );
}

/**
 * An agent with work of its own and no task card: a herdr pane or a company
 * session. Its card is dashed, so it never reads as the company's own work.
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
      title={card.title}
      data-testid="agent-card"
      data-agent-kind={subject.kind}
      data-flight-key={card.key}
      data-lane={card.lane}
      data-index={index}
      className="company-card w-full cursor-pointer border-dashed px-2.5 py-2 text-left"
    >
      <span className="flex min-w-0 items-center gap-1.5 text-2xs">
        <StatusDot tone={card.tone} />
        <span className="shrink-0 rounded-[3px] border border-border px-1 font-mono text-text-muted">
          {card.tag}
        </span>
        <span className="min-w-0 flex-1 truncate text-text-muted">{card.project}</span>
      </span>
      <span className="mt-1 line-clamp-3 break-normal text-sm font-medium leading-[1.35] text-text">
        {card.title}
      </span>
      <span className={`mt-1 block text-xs ${AGENT_STATUS_CLASS[card.lane]}`}>
        {card.statusLabel}
      </span>
    </button>
  );
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
}: CompanyBoardProps) {
  const boardRef = useRef<HTMLDivElement>(null);
  useFlightLayout(boardRef);

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
          return (
            <section
              key={lane.id}
              aria-label={lane.label}
              data-testid={`company-lane-${lane.id}`}
              data-lane={lane.id}
              className={`company-lane ${count === 0 ? 'flex-none' : 'flex-1'}`}
              style={
                count === 0
                  ? { width: COMPANY_LANE_EMPTY_WIDTH_PX }
                  : { minWidth: COMPANY_LANE_MIN_WIDTH_PX }
              }
            >
              <header className="company-lane-head flex flex-col gap-0.5 px-2 py-1.5">
                <h3 className="flex items-baseline justify-between gap-2 text-base font-semibold text-text">
                  <span className="min-w-0">
                    {COMPANY_LANE_ICONS[lane.id]} {lane.label}
                  </span>
                  <span className="shrink-0 text-xs font-normal text-text-muted">{count}</span>
                </h3>
                <p className="truncate text-xs text-status-active">
                  {COMPANY_LANE_OWNERS[lane.id]}
                </p>
              </header>
              <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-1.5">
                {count === 0 && <p className="px-1 text-xs text-text-muted">Không có gì ở đây.</p>}
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
            </section>
          );
        })}
      </div>
    </div>
  );
}
