/**
 * SquadRunCard: one squad run on the board. The card names what the server holds for the run: its
 * request, its status, its progress and, while a proposal waits, the proposal's rows. Its actions
 * are commands the server answers; the card moves only when the server says so.
 */

import type { WorkItemStatus } from '../../../../core/src/messages.js';
import type { BoardSquad } from '../boardView.js';
import type { CompanyClient } from '../companyClient.js';
import {
  type EpicChild,
  epicChildren,
  openSequencesOf,
  rowsFromProposal,
  squadProgressView,
  squadRunKey,
  squadStatusLabel,
  validateRows,
} from '../squadView.js';
import { useCommandDialog } from '../useCommandDialog.js';
import { conflictText } from '../workItemReviewView.js';
import { blockerChip, blockerSentence } from '../workItemView.js';
import { CompanyButton } from './CompanyButton.js';
import { FolderTag } from './FolderTag.js';
import { WorkItemReviewChips } from './WorkItemReviewChips.js';

const APPROVE_FALLBACK = 'Chưa duyệt được đề xuất này.';
const DISMISS_FALLBACK = 'Chưa bỏ được đề xuất này.';
const RETRY_FALLBACK = 'Chưa thử lại được việc này.';
const CARD_HEAD_FALLBACK = 'Đội chưa có nội dung';

/** The tone of each work item status on a child row; the status word is the label. */
const CHILD_STATUS_TONE: Readonly<Record<WorkItemStatus, string>> = {
  queued: 'text-text',
  running: 'text-text',
  needs_input: 'text-warning',
  review: 'text-text',
  done: 'text-text-muted',
  failed: 'text-danger',
};

/** A child row's blocker: what holds the item, as a chip and a sentence. */
function ChildBlocker({ child }: { child: EpicChild }) {
  const chip = blockerChip(child);
  const sentence = blockerSentence(child.blocker);
  if (chip === null || sentence === null) return null;
  return (
    <span
      data-testid="squad-child-blocker"
      className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-text-muted"
    >
      <span
        className={`shrink-0 rounded-full bg-well px-1.5 ${chip.tone === 'danger' ? 'text-danger' : ''}`}
      >
        {chip.text}
      </span>
      <span className="line-clamp-2 break-words">{sentence}</span>
    </span>
  );
}

export interface SquadRunCardProps {
  card: BoardSquad;
  /** The card's place in the board's flight order, after the cards above it. */
  index: number;
  selected: boolean;
  client: CompanyClient;
  /** Opens the drawer on the run, where its proposal can be edited. */
  onOpen: () => void;
}

export function SquadRunCard({ card, index, selected, client, onOpen }: SquadRunCardProps) {
  const { run } = card;
  const command = useCommandDialog(client);
  const busy = command.pending;
  const proposal = run.status === 'proposed' ? run.proposal : undefined;
  const verdict =
    proposal === undefined
      ? null
      : validateRows(rowsFromProposal(proposal), openSequencesOf(card.items), {
          repos: card.repos,
          agents: card.agents,
        });
  const progress = squadProgressView(run.progress);
  const children = epicChildren(run, card.items, card.parkedSessionIds);
  const head = card.head === '' ? CARD_HEAD_FALLBACK : card.head;
  const note = (proposal?.note ?? run.note ?? '').trim();
  const error = run.status === 'failed' ? run.error?.trim() || 'Đội gặp lỗi.' : null;

  function approve(): void {
    if (proposal === undefined || verdict === null || !verdict.ok) return;
    void command.run(
      client.approveSquad(card.workspacePath, card.runId, proposal.id, verdict.rows),
      APPROVE_FALLBACK,
    );
  }

  function dismiss(): void {
    if (proposal === undefined) return;
    void command.run(
      client.dismissSquad(card.workspacePath, card.runId, proposal.id),
      DISMISS_FALLBACK,
    );
  }

  function retry(): void {
    void command.run(client.retrySquad(card.workspacePath, card.runId), RETRY_FALLBACK);
  }

  return (
    <article
      data-testid="squad-card"
      data-squad-run-id={card.runId}
      data-flight-key={`squad:${squadRunKey(card)}`}
      data-lane={card.lane}
      data-index={index}
      className="company-card company-work-card flex w-full min-w-0 flex-col gap-1 p-2"
    >
      <button
        type="button"
        onClick={onOpen}
        aria-pressed={selected}
        className="flex w-full min-w-0 cursor-pointer flex-col gap-1 text-left"
      >
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-2xs text-text-muted">
          <span className="rounded-full bg-well px-1.5 text-text">Đội</span>
          <span className="shrink-0">{squadStatusLabel(run.status)}</span>
        </span>
        <span className="line-clamp-2 break-normal text-sm font-medium leading-[1.3] text-text">
          {head}
        </span>
      </button>
      {card.folder !== null && <FolderTag identity={card.folder} />}
      {progress.total > 0 && (
        <div className="flex min-w-0 items-center gap-2 text-2xs tabular-nums text-text-muted">
          <span
            role="progressbar"
            aria-label="Tiến độ đội"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.done}
            aria-valuetext={`${progress.label} xong`}
            className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-well"
          >
            <span
              className="block h-full rounded-full bg-accent transition-[width] duration-300 ease-out motion-reduce:transition-none"
              style={{ width: `${Math.round(progress.fraction * 100)}%` }}
            />
          </span>
          <span className="shrink-0">{progress.label}</span>
        </div>
      )}
      {children.length > 0 && (
        <ul aria-label="Việc của đội" className="flex flex-col gap-1.5">
          {children.map((child) => (
            <li
              key={child.id}
              data-testid="squad-child"
              className="flex min-w-0 flex-col gap-0.5 text-2xs"
            >
              <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
                <span className="shrink-0 tabular-nums text-text-muted">#{child.sequence}</span>
                <span
                  className={`shrink-0 rounded-full bg-well px-1.5 ${CHILD_STATUS_TONE[child.status]}`}
                >
                  {child.statusLabel}
                </span>
                {child.waits.map((wait, waitIndex) => (
                  <span key={`${child.id}:${waitIndex}`} className="shrink-0 text-text-muted">
                    {wait.text}
                  </span>
                ))}
              </span>
              {child.head !== '' && (
                <span className="line-clamp-2 break-words text-text">{child.head}</span>
              )}
              <ChildBlocker child={child} />
              <WorkItemReviewChips
                judge={null}
                conflictText={conflictText(child.conflicts)}
                parked={child.parked}
              />
            </li>
          ))}
        </ul>
      )}
      {run.status === 'planning' && (
        <p className="text-2xs text-text-muted motion-safe:animate-pulse">
          Đội trưởng đang xem xét…
        </p>
      )}
      {note !== '' && <p className="line-clamp-3 break-words text-2xs text-text-muted">{note}</p>}
      {proposal !== undefined && (
        <ul className="flex flex-col gap-0.5">
          {card.rows.map((row, rowIndex) => (
            <li
              key={`${proposal.id}:${rowIndex}`}
              className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-2 text-2xs"
            >
              <span className="line-clamp-2 break-words text-text">{row.text}</span>
              <span className="max-w-[9rem] truncate text-text-muted">{row.assignee}</span>
            </li>
          ))}
        </ul>
      )}
      {verdict !== null && !verdict.ok && <p className="text-2xs text-warning">{verdict.reason}</p>}
      {error !== null && <p className="line-clamp-3 break-words text-2xs text-warning">{error}</p>}
      {command.notice !== null && <p className="text-2xs text-warning">{command.notice}</p>}
      {proposal !== undefined && (
        <div className="flex flex-wrap gap-1.5">
          <CompanyButton
            size="sm"
            variant="accent"
            disabled={busy || verdict === null || !verdict.ok}
            onClick={approve}
          >
            Duyệt
          </CompanyButton>
          <CompanyButton size="sm" disabled={busy} onClick={dismiss}>
            Bỏ
          </CompanyButton>
          <CompanyButton size="sm" disabled={busy} onClick={onOpen}>
            Sửa
          </CompanyButton>
        </div>
      )}
      {run.status === 'failed' && (
        <div className="flex flex-wrap gap-1.5">
          <CompanyButton size="sm" disabled={busy} onClick={retry}>
            Thử lại
          </CompanyButton>
        </div>
      )}
    </article>
  );
}
