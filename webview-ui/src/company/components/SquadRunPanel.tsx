/**
 * SquadRunPanel: one squad run, read from the server's copy and acted on from the drawer. The
 * panel names the request, the status, the progress and the history. A proposal waiting for an
 * answer is editable: its rows can be reworded, reassigned, removed or added to before the team
 * starts. Each action is a command, and the run moves only when the server says so.
 */

import { useRef, useState } from 'react';

import type { SquadDependency, SquadEvent, SquadProposal } from '../../../../core/src/messages.js';
import { priorityLabel } from '../../../../core/src/workItemGraph.js';
import { relativeTimeVi } from '../agentSidebarView.js';
import type { AssigneeOption } from '../assigneeOptions.js';
import { assigneeKeyOf, assigneeOptionsFor } from '../assigneeOptions.js';
import type { CompanyClient } from '../companyClient.js';
import type { CompanyViewState } from '../companyState.js';
import {
  blankDraftRow,
  findSquadRun,
  openSequencesOf,
  PRIORITY_CHOICES,
  progressLabel,
  proposalRowDepsOptions,
  removeDraftRow,
  rowsFromProposal,
  SQUAD_MAX_ROWS,
  type SquadDraftRow,
  squadEventLabel,
  squadStatusLabel,
  toggleRowDependency,
  validateRows,
} from '../squadView.js';
import { useCommandDialog } from '../useCommandDialog.js';
import { useNow } from '../useNow.js';
import { assigneeLabel, workItemsOf } from '../workItemView.js';
import { CompanyButton } from './CompanyButton.js';

const APPROVE_FALLBACK = 'Chưa duyệt được đề xuất này.';
const DISMISS_FALLBACK = 'Chưa bỏ được đề xuất này.';
const RETRY_FALLBACK = 'Chưa thử lại được việc này.';

export interface SquadRunPanelProps {
  client: CompanyClient;
  state: CompanyViewState;
  workspacePath: string;
  runId: string;
}

export function SquadRunPanel({ client, state, workspacePath, runId }: SquadRunPanelProps) {
  const now = useNow();
  const command = useCommandDialog(client);
  const run = findSquadRun(state, { runId, workspacePath });
  if (run === undefined) {
    return <p className="text-xs text-text-muted">Đội này không còn trong thư mục.</p>;
  }
  const proposal = run.status === 'proposed' ? run.proposal : undefined;
  const progress = progressLabel(run.progress);
  const note = (run.note ?? '').trim();
  const error = run.status === 'failed' ? run.error?.trim() || 'Đội gặp lỗi.' : null;

  const retry = (): void => {
    void command.run(client.retrySquad(workspacePath, run.id), RETRY_FALLBACK);
  };

  return (
    <div className="flex flex-col gap-3 text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-text-muted">
        <span className="rounded-full bg-well px-1.5 text-text">
          {squadStatusLabel(run.status)}
        </span>
        {progress !== null && <span className="tabular-nums">{progress}</span>}
      </div>
      <p className="whitespace-pre-wrap break-words text-text">{run.request}</p>
      {proposal !== undefined && (
        <ProposalEditor
          key={proposal.id}
          client={client}
          state={state}
          workspacePath={workspacePath}
          runId={run.id}
          proposal={proposal}
        />
      )}
      {proposal === undefined && note !== '' && (
        <p className="whitespace-pre-wrap break-words text-text-muted">{note}</p>
      )}
      {error !== null && <p className="whitespace-pre-wrap break-words text-warning">{error}</p>}
      {command.notice !== null && <p className="text-2xs text-warning">{command.notice}</p>}
      {run.status === 'failed' && (
        <div className="flex flex-wrap gap-1.5">
          <CompanyButton size="sm" disabled={command.pending} onClick={retry}>
            Thử lại
          </CompanyButton>
        </div>
      )}
      <section aria-label="Lịch sử">
        <h3 className="mb-1 text-2xs font-semibold text-text-muted">Lịch sử</h3>
        <ol className="flex flex-col gap-1.5">
          {run.history.map((event, index) => (
            <HistoryRow key={`${index}:${event.at}`} event={event} now={now} />
          ))}
        </ol>
      </section>
    </div>
  );
}

interface ProposalEditorProps {
  client: CompanyClient;
  state: CompanyViewState;
  workspacePath: string;
  runId: string;
  proposal: SquadProposal;
}

/**
 * The rows of a proposal the server is waiting on. The draft starts as the proposal and is kept
 * here until the user approves or dismisses it; the editor remounts when a new proposal arrives.
 */
function ProposalEditor({ client, state, workspacePath, runId, proposal }: ProposalEditorProps) {
  const [rows, setRows] = useState<SquadDraftRow[]>(() => rowsFromProposal(proposal));
  const added = useRef(0);
  const command = useCommandDialog(client);
  const options = assigneeOptionsFor(state, workspacePath);
  const openItems = workItemsOf(state, workspacePath).items;
  const verdict = validateRows(rows, openSequencesOf(openItems));
  const note = proposal.note.trim();

  function editRow(
    key: string,
    change: Partial<Pick<SquadDraftRow, 'text' | 'assignee' | 'priority' | 'acceptance'>>,
  ): void {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)));
  }

  function removeRow(key: string): void {
    setRows((current) => removeDraftRow(current, key));
  }

  function toggleWait(rowIndex: number, dependency: SquadDependency): void {
    setRows((current) => toggleRowDependency(current, rowIndex, dependency));
  }

  function addRow(): void {
    added.current += 1;
    const key = `${proposal.id}:new:${added.current}`;
    setRows((current) => [...current, blankDraftRow(key)]);
  }

  function approve(): void {
    if (!verdict.ok) return;
    void command.run(
      client.approveSquad(workspacePath, runId, proposal.id, verdict.rows),
      APPROVE_FALLBACK,
    );
  }

  function dismiss(): void {
    void command.run(client.dismissSquad(workspacePath, runId, proposal.id), DISMISS_FALLBACK);
  }

  return (
    <section aria-label="Đề xuất" className="flex flex-col gap-2">
      {note !== '' && <p className="whitespace-pre-wrap break-words text-text-muted">{note}</p>}
      <ul className="flex flex-col gap-2">
        {rows.map((row, index) => {
          const waits = proposalRowDepsOptions(rows, index, openItems);
          return (
            <li
              key={row.key}
              className="flex min-w-0 flex-col gap-1.5 rounded-(--company-radius-sm) bg-raised p-2"
            >
              <textarea
                aria-label={`Nội dung dòng ${index + 1}`}
                rows={2}
                value={row.text}
                onChange={(event) => editRow(row.key, { text: event.target.value })}
                className="w-full min-w-0 resize-y rounded-(--company-radius-sm) bg-well px-2 py-1.5 text-xs text-text"
              />
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <AssigneeSelect
                  label={`Giao dòng ${index + 1}`}
                  assignee={row.assignee}
                  options={options}
                  state={state}
                  workspacePath={workspacePath}
                  onChange={(assignee) => editRow(row.key, { assignee })}
                />
                <select
                  aria-label={`Độ ưu tiên dòng ${index + 1}`}
                  value={String(row.priority)}
                  disabled={command.pending}
                  onChange={(event) => editRow(row.key, { priority: Number(event.target.value) })}
                  className="rounded-(--company-radius-sm) bg-well px-2 py-1 text-xs text-text disabled:text-text-muted"
                >
                  {PRIORITY_CHOICES.map((choice) => (
                    <option key={choice} value={String(choice)}>
                      {priorityLabel(choice)}
                    </option>
                  ))}
                </select>
                <CompanyButton size="sm" onClick={() => removeRow(row.key)}>
                  Bỏ dòng
                </CompanyButton>
              </div>
              <input
                type="text"
                aria-label={`Xong khi dòng ${index + 1}`}
                placeholder="Xong khi… (không bắt buộc)"
                value={row.acceptance}
                disabled={command.pending}
                onChange={(event) => editRow(row.key, { acceptance: event.target.value })}
                className="w-full min-w-0 rounded-(--company-radius-sm) bg-well px-2 py-1.5 text-xs text-text disabled:text-text-muted"
              />
              <div
                role="group"
                aria-label={`Chờ việc, dòng ${index + 1}`}
                className="flex min-w-0 flex-wrap gap-1"
              >
                {waits.length === 0 ? (
                  <p className="text-2xs text-text-muted">Không có việc nào để chờ.</p>
                ) : (
                  waits.map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      aria-pressed={option.selected}
                      disabled={command.pending}
                      onClick={() => toggleWait(index, option.dependency)}
                      className={`touch-target max-w-full truncate rounded-(--company-radius-sm) px-2 py-1 text-left text-2xs disabled:cursor-default ${option.selected ? 'company-selected text-text' : 'bg-well text-text-muted hover:bg-hover'}`}
                    >
                      {option.label}
                    </button>
                  ))
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap gap-1.5">
        <CompanyButton
          size="sm"
          disabled={command.pending || rows.length >= SQUAD_MAX_ROWS}
          onClick={addRow}
        >
          Thêm dòng
        </CompanyButton>
      </div>
      {!verdict.ok && <p className="text-2xs text-warning">{verdict.reason}</p>}
      {command.notice !== null && <p className="text-2xs text-warning">{command.notice}</p>}
      <div className="flex flex-wrap gap-1.5">
        <CompanyButton
          size="md"
          variant="accent"
          disabled={command.pending || !verdict.ok}
          onClick={approve}
        >
          Duyệt
        </CompanyButton>
        <CompanyButton size="md" disabled={command.pending} onClick={dismiss}>
          Bỏ đề xuất
        </CompanyButton>
      </div>
    </section>
  );
}

interface AssigneeSelectProps {
  label: string;
  assignee: SquadDraftRow['assignee'];
  options: readonly AssigneeOption[];
  state: CompanyViewState;
  workspacePath: string;
  onChange: (assignee: NonNullable<SquadDraftRow['assignee']>) => void;
}

/**
 * The row's assignee, picked from the folder's agents and sessions in the same groups the assign
 * dialog uses. A holder the folder no longer lists stays visible, marked as gone, until replaced.
 */
function AssigneeSelect({
  label,
  assignee,
  options,
  state,
  workspacePath,
  onChange,
}: AssigneeSelectProps) {
  const value = assignee === null ? '' : assigneeKeyOf(assignee);
  const listed = options.some((option) => option.key === value);
  const herdrRows = options.filter((option) => option.group === 'herdr');
  const sessionRows = options.filter((option) => option.group === 'session');
  const newRows = options.filter((option) => option.group === 'new');
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => {
        const picked = options.find((option) => option.key === event.target.value);
        if (picked !== undefined) onChange(picked.assignee);
      }}
      className="min-w-0 max-w-full rounded-(--company-radius-sm) bg-well px-2 py-1 text-xs text-text"
    >
      {assignee === null && (
        <option value="" disabled>
          Chọn người nhận
        </option>
      )}
      {assignee !== null && !listed && (
        <option value={value} disabled>
          {assigneeLabel(assignee, state, workspacePath)} (không còn trong thư mục)
        </option>
      )}
      {herdrRows.length > 0 && (
        <optgroup label="Agent herdr">
          {herdrRows.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </optgroup>
      )}
      {sessionRows.length > 0 && (
        <optgroup label="Phiên omp">
          {sessionRows.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </optgroup>
      )}
      {newRows.map((option) => (
        <option key={option.key} value={option.key}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function HistoryRow({ event, now }: { event: SquadEvent; now: number }) {
  const when = relativeTimeVi(event.at, now);
  return (
    <li className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 text-2xs">
      <span className="text-text">{squadEventLabel(event.kind)}</span>
      <span className="min-w-0 break-words text-text-muted">
        {event.message}
        {when !== null && (
          <time dateTime={event.at} className="block">
            {when}
          </time>
        )}
      </span>
    </li>
  );
}
