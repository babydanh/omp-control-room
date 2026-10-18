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
 */

import { useLayoutEffect, useRef, useState } from 'react';

import { type AgentMenuRequest, agentMenuTriggers } from '../agentMenu.js';
import type { BoardCard, BoardFlow, BoardLane, PlanningPrompt } from '../boardView.js';
import { WAIT_REASON_LABELS } from '../boardView.js';
import { failureNotice } from '../commandResults.js';
import type { CompanyClient } from '../companyClient.js';
import { COMPANY_LANE_ICONS, COMPANY_LANE_OWNERS } from '../constants.js';
import { type FlightMemory, flyChangedCards } from '../flip.js';
import { companyRoleLabel, ROLE_EDGE_CLASS } from '../roleProfiles.js';
import { REFUSED_NOTICE } from '../sessionActions.js';
import { taskStatusLabel } from '../statusLabels.js';
import { useMediaQuery } from '../useMediaQuery.js';
import { CompanyButton } from './CompanyButton.js';
import { ConfirmAction } from './SessionActions.js';

export interface CompanyBoardProps {
  client: CompanyClient;
  lanes: readonly BoardLane[];
  flow: BoardFlow;
  /** Prompts a Director is still planning; shown in the planned lane. */
  planning: readonly PlanningPrompt[];
  onSelectTask: (taskId: string) => void;
  onSelectSession: (sessionId: string) => void;
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
const PILL_CLASS = 'mt-1 inline-block rounded-full bg-btn-bg px-2 font-mono text-[10.5px]';

function cardTone(card: BoardCard): CardTone {
  if (card.sentBack || card.lane === 'needs_input' || card.lane === 'failed') return 'alert';
  if (card.lane === 'done') return 'ok';
  if (card.lane === 'running') return 'live';
  return 'plain';
}

/**
 * A prompt a Director is still planning. The board lists it only while no Contract holds
 * it (planningPrompts), so the cancel is offered only for a prompt the server can still
 * withdraw.
 */
function PlanningCard({
  client,
  prompt,
  onSelect,
}: {
  client: CompanyClient;
  prompt: PlanningPrompt;
  onSelect: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function cancel(): Promise<void> {
    setPending(true);
    setNotice(null);
    const verdict = await client.waitForCommand(client.cancelPrompt(prompt.promptId));
    setPending(false);
    if (verdict.ok) return;
    setConfirming(false);
    setNotice(failureNotice(verdict, REFUSED_NOTICE));
  }

  return (
    <div
      data-testid="planning-card"
      className={`company-card block w-full border-dashed border-l-4 px-2 py-[7px] ${ROLE_EDGE_CLASS.director}`}
    >
      <button
        type="button"
        onClick={onSelect}
        disabled={prompt.session === null}
        className="block w-full cursor-pointer text-left disabled:cursor-default"
      >
        <span className="block text-sm leading-snug text-text">{prompt.preview}</span>
        <span className="mt-1 block text-2xs text-text-muted">Giám đốc đang lập kế hoạch</span>
        {prompt.session && (
          <span className="mt-1 block font-mono text-2xs text-text-muted">
            {prompt.session.code} &middot;{' '}
            {prompt.session.effectiveModel ?? prompt.session.requestedModel}
          </span>
        )}
      </button>
      {confirming ? (
        <div className="mt-2">
          <ConfirmAction
            message="Huỷ prompt này? Máy chủ sẽ dừng và xoá những gì đang lập kế hoạch từ nó."
            confirmLabel="Huỷ prompt"
            danger
            disabled={pending}
            onConfirm={() => void cancel()}
            onCancel={() => setConfirming(false)}
          />
        </div>
      ) : (
        <CompanyButton
          size="sm"
          className="mt-2"
          disabled={pending}
          onClick={() => setConfirming(true)}
        >
          Huỷ prompt này
        </CompanyButton>
      )}
      {notice !== null && (
        <p role="status" className="mt-1 text-2xs text-warning">
          {notice}
        </p>
      )}
    </div>
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
    { kind: 'session', sessionId: card.session?.id ?? null },
    onMenu,
  );
  return (
    <button
      type="button"
      onClick={onSelect}
      {...triggers}
      aria-pressed={card.selected}
      data-testid={`task-card-${card.code}`}
      data-task-id={card.taskId}
      data-lane={card.lane}
      data-index={index}
      className={`company-card w-full cursor-pointer border-l-4 px-2 py-[7px] text-left ${edge} ${card.sentBack ? 'company-sent-back' : ''}`}
    >
      <span className="block text-sm leading-snug text-text">
        <span className="font-mono text-2xs text-text-muted">{card.code}</span> {card.title}
      </span>
      <span className={`mt-1 block font-mono text-2xs ${CARD_TONE_CLASS[cardTone(card)]}`}>
        {taskStatusLabel(card.status)}
      </span>
      {card.sentBack && <span className={`${PILL_CLASS} text-warning`}>trả lại</span>}
      <OwnerChip card={card} />
      {card.waitReason && (
        <span className="mt-1 block text-2xs text-warning" data-testid={`wait-${card.code}`}>
          {card.waitReason === 'blocked_by_dependencies'
            ? `${WAIT_REASON_LABELS[card.waitReason]} (${card.blockedByCodes.join(', ')})`
            : WAIT_REASON_LABELS[card.waitReason]}
        </span>
      )}
      <span className="mt-1 block text-2xs text-text-muted">
        {card.contractCode} &middot; {card.phaseTitle}
      </span>
      {card.session && (
        <span className="mt-1 block text-2xs text-text-muted">
          {card.session.code} &middot; {companyRoleLabel(card.session.role)} &middot;{' '}
          {card.session.effectiveModel ?? card.session.requestedModel}
          {card.session.effectiveModel !== null &&
            card.session.effectiveModel !== card.session.requestedModel && (
              <span className="text-warning"> (khác với mô hình đã yêu cầu)</span>
            )}
        </span>
      )}
      {card.routeReason && (
        <span className="mt-1 block text-2xs italic text-text-muted">{card.routeReason}</span>
      )}
      <EvidenceBadges card={card} />
    </button>
  );
}

/** The reduced-motion preference: when it matches, cards sit in their new place. */
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** Where every task card sits now, as one string: a change here means a move. */
function layoutSignature(lanes: readonly BoardLane[]): string {
  return lanes
    .flatMap((lane) => lane.cards.map((card, index) => `${card.taskId}:${lane.id}:${index}`))
    .join('|');
}

export function CompanyBoard({
  client,
  lanes,
  flow,
  planning,
  onSelectTask,
  onSelectSession,
  onMenu,
}: CompanyBoardProps) {
  const boardRef = useRef<HTMLDivElement>(null);
  const flightRef = useRef<ReadonlyMap<string, FlightMemory>>(new Map());
  const layout = layoutSignature(lanes);
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);

  // Cards that changed lane or slot fly from where they were. The positions are
  // read after the layout commits, so the flight starts exactly where the card
  // was on screen.
  useLayoutEffect(() => {
    if (boardRef.current === null) return;
    const cards = Array.from(boardRef.current.querySelectorAll<HTMLElement>('[data-task-id]'));
    flightRef.current = flyChangedCards(cards, flightRef.current, reducedMotion);
  }, [layout, reducedMotion]);

  return (
    <div
      ref={boardRef}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="company-board"
    >
      <FlowStrip flow={flow} />
      <div className="flex min-h-0 flex-1 gap-1.5 overflow-x-auto p-1.5">
        {lanes.map((lane) => {
          const drafts = lane.id === 'planned' ? planning : [];
          const count = lane.cards.length + drafts.length;
          return (
            <section
              key={lane.id}
              aria-label={lane.label}
              data-testid={`company-lane-${lane.id}`}
              data-lane={lane.id}
              className="company-lane min-w-[96px] flex-1"
            >
              <header className="company-lane-head flex flex-col gap-0.5 px-2 py-1.5">
                <h3 className="flex items-baseline justify-between gap-2 text-sm font-semibold text-text">
                  <span className="min-w-0">
                    {COMPANY_LANE_ICONS[lane.id]} {lane.label}
                  </span>
                  <span className="shrink-0 text-2xs font-normal text-text-muted">{count}</span>
                </h3>
                <p className="truncate font-mono text-2xs text-status-active">
                  {COMPANY_LANE_OWNERS[lane.id]}
                </p>
              </header>
              <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-1.5">
                {count === 0 && <p className="px-1 text-2xs text-text-muted">Không có gì ở đây.</p>}
                {drafts.map((prompt) => (
                  <PlanningCard
                    key={prompt.promptId}
                    client={client}
                    prompt={prompt}
                    onSelect={() => prompt.session && onSelectSession(prompt.session.id)}
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
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
