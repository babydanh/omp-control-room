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
 * A card is a button, not a draggable: the only thing clicking does is select,
 * because status is the server's to change.
 */

import type { BoardCard, BoardFlow, BoardLane } from '../boardView.js';
import { WAIT_REASON_LABELS } from '../boardView.js';
import { companyRoleLabel, ROLE_EDGE_CLASS } from '../roleProfiles.js';
import { taskStatusLabel } from '../statusLabels.js';

export interface CompanyBoardProps {
  lanes: readonly BoardLane[];
  flow: BoardFlow;
  onSelectTask: (taskId: string) => void;
}

function FlowStrip({ flow }: { flow: BoardFlow }) {
  const limit = flow.runningLimit === null ? '?' : String(flow.runningLimit);
  return (
    <div
      className="flex flex-wrap gap-3 border-b-2 border-border px-2 py-1 text-2xs"
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

function TaskCard({ card, onSelect }: { card: BoardCard; onSelect: () => void }) {
  const edge = card.session ? ROLE_EDGE_CLASS[card.session.role] : 'border-l-border';
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={card.selected}
      data-testid={`task-card-${card.code}`}
      className={
        card.selected
          ? `w-full cursor-pointer border-2 border-l-4 border-accent bg-bg-dark p-2 text-left ${edge}`
          : `w-full cursor-pointer border-2 border-l-4 border-border bg-bg-dark p-2 text-left hover:border-accent ${edge}`
      }
    >
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-sm text-text">
          <span className="text-text-muted">{card.code}</span> {card.title}
        </span>
      </span>
      <span className="mt-1 block text-2xs uppercase tracking-wide text-text-muted">
        {taskStatusLabel(card.status)}
      </span>
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

export function CompanyBoard({ lanes, flow, onSelectTask }: CompanyBoardProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="company-board">
      <FlowStrip flow={flow} />
      <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto p-2">
        {lanes.map((lane) => (
          <section
            key={lane.id}
            aria-label={lane.label}
            data-testid={`company-lane-${lane.id}`}
            className="flex min-w-48 flex-1 flex-col gap-2 overflow-y-auto border-2 border-border bg-bg p-2"
          >
            <h3 className="text-xs uppercase tracking-wide text-text-muted">
              {lane.label} ({lane.cards.length})
            </h3>
            {lane.cards.length === 0 && (
              <p className="text-2xs text-text-muted">Không có gì ở đây.</p>
            )}
            {lane.cards.map((card) => (
              <TaskCard key={card.taskId} card={card} onSelect={() => onSelectTask(card.taskId)} />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
