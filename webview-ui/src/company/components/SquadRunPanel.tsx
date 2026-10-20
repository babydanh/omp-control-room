/**
 * SquadRunPanel: one squad run, read from the server's copy and acted on from the drawer. The
 * panel names the request, the status, the progress and the history. A proposal waiting for an
 * answer is editable: its rows can be reworded, reassigned, removed or added to before the team
 * starts. Each action is a command, and the run moves only when the server says so.
 */

import { useRef, useState } from 'react';

import type { SquadDependency, SquadEvent, SquadProposal } from '../../../../core/src/messages.js';
import { relativeTimeVi } from '../agentSidebarView.js';
import { assigneeOptionsFor } from '../assigneeOptions.js';
import type { CompanyClient } from '../companyClient.js';
import type { CompanyViewState } from '../companyState.js';
import { liveWarnings } from '../squadPlanCheck.js';
import { squadLayerHead, squadLayers } from '../squadPlanLayers.js';
import {
  blankDraftRow,
  findSquadRun,
  openSequencesOf,
  progressLabel,
  removeDraftRow,
  rowsFromProposal,
  SQUAD_MAX_ROWS,
  type SquadCatalog,
  type SquadDraftRow,
  squadEventLabel,
  squadRunActions,
  squadStatusLabel,
  toggleRowDependency,
  validateRows,
} from '../squadView.js';
import { useCommandDialog } from '../useCommandDialog.js';
import { useNow } from '../useNow.js';
import { workItemsOf } from '../workItemView.js';
import { CompanyButton } from './CompanyButton.js';
import { ConfirmAction } from './ConfirmAction.js';
import { SquadPlanRow, type SquadRowChange } from './SquadPlanRow.js';
const APPROVE_FALLBACK = 'Chưa duyệt được đề xuất này.';
const DISMISS_FALLBACK = 'Chưa bỏ được đề xuất này.';
const RETRY_FALLBACK = 'Chưa thử lại được việc này.';
const CANCEL_FALLBACK = 'Chưa huỷ được lượt này.';
const REMOVE_FALLBACK = 'Chưa xoá được lượt này.';

export interface SquadRunPanelProps {
  client: CompanyClient;
  state: CompanyViewState;
  workspacePath: string;
  runId: string;
  onRemoved: () => void;
}


export function SquadRunPanel({ client, state, workspacePath, runId, onRemoved }: SquadRunPanelProps) {
  const now = useNow();
  const [confirming, setConfirming] = useState<'cancel' | 'remove' | null>(null);
  const command = useCommandDialog(client);
  const removeCommand = useCommandDialog(client, onRemoved);
  const run = findSquadRun(state, { runId, workspacePath });
  if (run === undefined) {
    return <p className="text-xs text-text-muted">Đội này không còn trong thư mục.</p>;
  }
  const proposal = run.status === 'proposed' ? run.proposal : undefined;
  const progress = progressLabel(run.progress);
  const note = (run.note ?? '').trim();
  const error = run.status === 'failed' ? run.error?.trim() || 'Đội gặp lỗi.' : null;
  const actions = squadRunActions(run.status);
  const cancelRun = (): void => {
    void command.run(client.cancelSquad(workspacePath, run.id), CANCEL_FALLBACK);
    setConfirming(null);
  };
  const removeRun = (): void => {
    void removeCommand.run(client.removeSquad(workspacePath, run.id), REMOVE_FALLBACK);
    setConfirming(null);
  };
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
      {removeCommand.notice !== null && (
        <p className="text-2xs text-warning">{removeCommand.notice}</p>
      )}
      {command.notice !== null && <p className="text-2xs text-warning">{command.notice}</p>}
      {run.status === 'failed' && (
        <div className="flex flex-wrap gap-1.5">
          <CompanyButton size="sm" disabled={command.pending} onClick={retry}>
            Thử lại
          </CompanyButton>
        </div>
      )}
      {(actions.cancel || actions.remove) && (
        <div className="flex flex-wrap gap-1.5">
          {actions.cancel && (
            <CompanyButton size="sm" disabled={command.pending} onClick={() => setConfirming('cancel')}>
              Huỷ lượt
            </CompanyButton>
          )}
          {actions.remove && (
            <CompanyButton
              size="sm"
              disabled={command.pending || removeCommand.pending}
              onClick={() => setConfirming('remove')}
            >
              Xoá khỏi bảng
            </CompanyButton>
          )}
        </div>
      )}
      {confirming !== null && (
        <ConfirmAction
          message={confirming === 'cancel' ? 'Huỷ lượt Đội này? Việc đã duyệt vẫn tiếp tục.' : 'Xoá lượt Đội khỏi bảng? Việc đã tạo vẫn được giữ.'}
          confirmLabel={confirming === 'cancel' ? 'Huỷ lượt' : 'Xoá khỏi bảng'}
          danger
          disabled={command.pending || removeCommand.pending}
          onConfirm={confirming === 'cancel' ? cancelRun : removeRun}
          onCancel={() => setConfirming(null)}
        />
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
 * The rows of a proposal the server is waiting on, grouped in layers: a layer runs together, and a
 * later layer waits for the one before it. The draft starts as the proposal and is kept here until
 * the user approves or dismisses it; the editor remounts when a new proposal arrives. The warnings
 * are the server's until the user edits the draft, then they are checked live. Warnings never block
 * approval; only the row check does.
 */
function ProposalEditor({ client, state, workspacePath, runId, proposal }: ProposalEditorProps) {
  const [rows, setRows] = useState<SquadDraftRow[]>(() => rowsFromProposal(proposal));
  const [edited, setEdited] = useState(false);
  const added = useRef(0);
  const command = useCommandDialog(client);
  const folder = workItemsOf(state, workspacePath);
  const options = assigneeOptionsFor(state, workspacePath);
  const catalog: SquadCatalog = { repos: folder.repos, agents: folder.agents };
  const verdict = validateRows(rows, openSequencesOf(folder.items), catalog);
  const warnings = edited ? liveWarnings(rows, folder.agents) : proposal.warnings;
  const layers = squadLayers(rows);
  const note = proposal.note.trim();

  function update(next: (current: SquadDraftRow[]) => SquadDraftRow[]): void {
    setEdited(true);
    setRows(next);
  }

  function editRow(key: string, change: SquadRowChange): void {
    update((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)));
  }

  function removeRow(key: string): void {
    update((current) => removeDraftRow(current, key));
  }

  function toggleWait(rowIndex: number, dependency: SquadDependency): void {
    update((current) => toggleRowDependency(current, rowIndex, dependency));
  }

  function addRow(): void {
    added.current += 1;
    const key = `${proposal.id}:new:${added.current}`;
    update((current) => [...current, blankDraftRow(key)]);
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
      {warnings.length > 0 && (
        <div className="flex flex-col gap-1">
          <ul aria-label="Cảnh báo đề xuất" className="flex flex-wrap gap-1.5">
            {warnings.map((warning) => (
              <li key={warning} className="rounded-full bg-well px-2 py-0.5 text-2xs text-warning">
                {warning}
              </li>
            ))}
          </ul>
          <p className="text-2xs text-text-muted">Cảnh báo chỉ là gợi ý, không chặn việc duyệt.</p>
        </div>
      )}
      <div className="flex flex-col gap-3">
        {layers.map((layer) => {
          const head = squadLayerHead(layer);
          return (
            <section key={layer.depth} aria-label={head.title} className="flex flex-col gap-1.5">
              <h4 className="flex flex-wrap items-baseline gap-x-2 text-2xs text-text-muted">
                <span className="font-semibold text-text">{head.title}</span>
                <span>{head.hint}</span>
              </h4>
              <ul className="flex flex-col gap-2">
                {layer.rows.map((index) => {
                  const row = rows[index];
                  if (row === undefined) return null;
                  return (
                    <SquadPlanRow
                      key={row.key}
                      row={row}
                      index={index}
                      rows={rows}
                      openItems={folder.items}
                      repos={folder.repos}
                      agents={folder.agents}
                      options={options}
                      state={state}
                      workspacePath={workspacePath}
                      pending={command.pending}
                      onChange={(change) => editRow(row.key, change)}
                      onRemove={() => removeRow(row.key)}
                      onToggleWait={(dependency) => toggleWait(index, dependency)}
                    />
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
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
