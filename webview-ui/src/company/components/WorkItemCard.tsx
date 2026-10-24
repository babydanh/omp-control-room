/**
 * WorkItemCard: one work item on the board. The card reads what the server holds for the item:
 * its heading, who holds it and in which repo, why it waits, and where a queued item stands. Its
 * folder, role, areas and squad stay in the drawer, so a card is a few words, not a row of tags.
 * A click opens the drawer on the item, which carries the actions.
 */

import type { AgentMenuRequest } from '../agentMenu.js';
import { relativeTimeVi } from '../agentSidebarView.js';
import type { BoardWorkItem } from '../boardView.js';
import { useAgentMenuGestures } from '../useAgentMenuGestures.js';
import { conflictText, judgeChipFor } from '../workItemReviewView.js';
import {
  blockerChip,
  blockerSentence,
  PANE_CLOSED_LABEL,
  repoShortName,
  statusWordVi,
  workItemInterruptedNote,
  workItemKey,
  workItemProgressLine,
} from '../workItemView.js';
import { WorkItemReviewChips } from './WorkItemReviewChips.js';

export interface WorkItemCardProps {
  card: BoardWorkItem;
  /** The card's place in the board's flight order, after the cards above it. */
  index: number;
  now: number;
  selected: boolean;
  onOpen: () => void;
  onMenu: (request: AgentMenuRequest) => void;
}

export function WorkItemCard({ card, index, now, selected, onOpen, onMenu }: WorkItemCardProps) {
  const triggers = useAgentMenuGestures<HTMLButtonElement>(
    { kind: 'workItem', id: card.id, workspacePath: card.workspacePath },
    onMenu,
  );
  const updated = relativeTimeVi(card.updatedAt, now);
  const chip = blockerChip(card);
  const sentence = blockerSentence(card.blocker);
  const repoName = card.repo === null ? '' : repoShortName(card.repo);
  const needsAttention = card.status === 'needs_input' || card.status === 'failed';
  const progress = workItemProgressLine(card);
  const interrupted = workItemInterruptedNote(card);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-pressed={selected}
      {...triggers}
      title={`${statusWordVi(card.status)} · ${card.assignee}`}
      data-testid="work-item-card"
      data-work-item-id={card.id}
      data-flight-key={`work:${workItemKey(card)}`}
      data-lane={card.lane}
      data-index={index}
      className="company-card company-work-card w-full cursor-pointer p-2 text-left"
    >
      <span className="flex min-w-0 items-center gap-1.5 text-2xs text-text-muted">
        <span className="shrink-0 tabular-nums" data-testid="work-item-sequence">
          #{card.sequence}
        </span>
      </span>
      {chip !== null && (
        <span className="flex min-w-0 flex-col items-start gap-0.5">
          <span
            data-testid="work-item-blocker"
            className={`max-w-full truncate rounded-full bg-well px-1.5 text-2xs ${chip.tone === 'danger' ? 'text-danger' : 'text-text-muted'}`}
          >
            {chip.text}
          </span>
          {sentence !== null && (
            <span
              data-testid="work-item-blocker-reason"
              className="line-clamp-2 break-words text-2xs text-text-muted"
            >
              {sentence}
            </span>
          )}
        </span>
      )}
      <WorkItemReviewChips
        judge={judgeChipFor(card)}
        conflictText={conflictText(card.conflicts)}
        parked={card.parked}
      />
      <span className="line-clamp-2 break-normal text-sm font-medium leading-[1.3] text-text">
        {card.head === '' ? 'Việc chưa có nội dung' : card.head}
      </span>
      <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-2xs text-text-muted">
        {/* A finished item's pane closing is expected: the chip would only say so on every done card. */}
        {!(card.assignee === PANE_CLOSED_LABEL && (card.status === 'done' || card.status === 'failed')) && (
          <span className="min-w-0 max-w-full truncate rounded-full bg-well px-1.5 text-text">
            {card.assignee}
          </span>
        )}
        {repoName !== '' && (
          <span
            data-testid="work-item-repo"
            title={card.repo ?? undefined}
            className="min-w-0 max-w-full truncate rounded-full bg-well px-1.5"
          >
            {repoName}
          </span>
        )}
        {updated !== null && <span className="shrink-0">{updated}</span>}
      </span>
      {progress !== null && (
        <span
          data-testid="work-item-progress"
          title={progress}
          className="block truncate text-2xs text-text-muted"
        >
          {progress}
        </span>
      )}
      {interrupted !== null && (
        <span
          data-testid="work-item-interrupted"
          className="line-clamp-2 break-words text-2xs text-warning"
        >
          {interrupted}
        </span>
      )}
      {card.reason !== null && (
        <span
          className={`line-clamp-2 break-words text-2xs ${needsAttention ? 'text-warning' : 'text-text-muted'}`}
        >
          {card.reason}
        </span>
      )}
    </button>
  );
}
