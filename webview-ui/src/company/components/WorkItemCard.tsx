/**
 * WorkItemCard: one work item on the board. The card reads what the server holds for the item:
 * its heading, who holds it, why it waits, and where a queued item stands. A click opens the
 * drawer on the item, which carries the actions.
 */

import { relativeTimeVi } from '../agentSidebarView.js';
import type { BoardWorkItem } from '../boardView.js';
import { queueWaitText, statusWordVi, workItemKey } from '../workItemView.js';
import { FolderTag } from './FolderTag.js';

export interface WorkItemCardProps {
  card: BoardWorkItem;
  /** The card's place in the board's flight order, after the cards above it. */
  index: number;
  now: number;
  selected: boolean;
  onOpen: () => void;
}

export function WorkItemCard({ card, index, now, selected, onOpen }: WorkItemCardProps) {
  const updated = relativeTimeVi(card.updatedAt, now);
  const waiting =
    card.status === 'queued' ? queueWaitText(card.assignee, card.queuePosition) : null;
  const needsAttention = card.status === 'needs_input' || card.status === 'failed';
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-pressed={selected}
      title={`${statusWordVi(card.status)} · ${card.assignee}`}
      data-testid="work-item-card"
      data-work-item-id={card.id}
      data-flight-key={`work:${workItemKey(card)}`}
      data-lane={card.lane}
      data-index={index}
      className="company-card company-work-card w-full cursor-pointer p-2 text-left"
    >
      <span className="line-clamp-2 break-normal text-sm font-medium leading-[1.3] text-text">
        {card.head === '' ? 'Việc chưa có nội dung' : card.head}
      </span>
      {card.folder !== null && <FolderTag identity={card.folder} />}
      <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-2xs text-text-muted">
        <span className="min-w-0 max-w-full truncate rounded-full bg-well px-1.5 text-text">
          {card.assignee}
        </span>
        {card.squadRunId !== null && (
          <span className="shrink-0 rounded-full bg-well px-1.5 text-text">Đội</span>
        )}
        {updated !== null && <span className="shrink-0">{updated}</span>}
      </span>
      {card.reason !== null && (
        <span
          className={`line-clamp-2 break-words text-2xs ${needsAttention ? 'text-warning' : 'text-text-muted'}`}
        >
          {card.reason}
        </span>
      )}
      {waiting !== null && <span className="line-clamp-1 text-2xs text-text-muted">{waiting}</span>}
    </button>
  );
}
