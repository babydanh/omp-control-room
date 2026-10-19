/**
 * SquadRunCard: one squad run on the board. The card names what the server holds for the run: its
 * request, its status, its progress and, while a proposal waits, the proposal's rows. Its actions
 * are commands the server answers; the card moves only when the server says so.
 */

import type { BoardSquad } from '../boardView.js';
import type { CompanyClient } from '../companyClient.js';
import {
  progressLabel,
  rowsFromProposal,
  squadRunKey,
  squadStatusLabel,
  validateRows,
} from '../squadView.js';
import { useCommandDialog } from '../useCommandDialog.js';
import { CompanyButton } from './CompanyButton.js';
import { FolderTag } from './FolderTag.js';

const APPROVE_FALLBACK = 'Chưa duyệt được đề xuất này.';
const DISMISS_FALLBACK = 'Chưa bỏ được đề xuất này.';
const RETRY_FALLBACK = 'Chưa thử lại được việc này.';
const CARD_HEAD_FALLBACK = 'Đội chưa có nội dung';

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
  const verdict = proposal === undefined ? null : validateRows(rowsFromProposal(proposal));
  const progress = progressLabel(run.progress);
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
          {progress !== null && <span className="shrink-0 tabular-nums">{progress}</span>}
        </span>
        <span className="line-clamp-2 break-normal text-sm font-medium leading-[1.3] text-text">
          {head}
        </span>
      </button>
      {card.folder !== null && <FolderTag identity={card.folder} />}
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
