/**
 * WorkItemReviewChips: the review-stage chips a work item shows on its board card, its drawer and
 * its squad row: the judge's state, the items it overlaps, and whether its assignee is parked.
 * Each chip reads what the server holds; a chip the server does not send is left out.
 */

import { type JudgeChip, PARKED_BADGE_TEXT, type ReviewChipTone } from '../workItemReviewView.js';

/** The text colour of each judge tone, from the existing company tokens. */
const TONE_CLASS: Readonly<Record<ReviewChipTone, string>> = {
  muted: 'text-text-muted',
  warning: 'text-warning',
  danger: 'text-danger',
  success: 'text-status-success',
};

export interface WorkItemReviewChipsProps {
  /** The judge's chip, or null when the judge shows nothing on this item. */
  judge: JudgeChip | null;
  /** The conflict chip's words, or null when the item overlaps nothing. */
  conflictText: string | null;
  /** Whether the item's assignee is a squad session the server reports as parked. */
  parked: boolean;
  className?: string;
}

export function WorkItemReviewChips({
  judge,
  conflictText,
  parked,
  className,
}: WorkItemReviewChipsProps) {
  if (judge === null && conflictText === null && !parked) return null;
  return (
    <span
      data-testid="work-item-review-chips"
      className={`flex min-w-0 flex-wrap items-center gap-1 ${className ?? ''}`}
    >
      {judge !== null && (
        <span
          data-testid="work-item-judge"
          className={`max-w-full truncate rounded-full bg-well px-1.5 text-2xs ${TONE_CLASS[judge.tone]}`}
        >
          {judge.text}
        </span>
      )}
      {conflictText !== null && (
        <span
          data-testid="work-item-conflicts"
          className="max-w-full truncate rounded-full bg-well px-1.5 text-2xs text-warning"
        >
          {conflictText}
        </span>
      )}
      {parked && (
        <span
          data-testid="work-item-parked"
          className="shrink-0 rounded-full bg-well px-1.5 text-2xs text-text-muted"
        >
          {PARKED_BADGE_TEXT}
        </span>
      )}
    </span>
  );
}
