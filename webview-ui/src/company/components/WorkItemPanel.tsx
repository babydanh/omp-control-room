/**
 * WorkItemPanel: one work item, read from the server's copy and acted on from the drawer.
 *
 * The panel names what the server holds: the status, who holds the item, why it waits, its text,
 * its result and its history. Its actions follow the status, and each one is a command. The
 * item moves only when the server says so; the verdict decides the notice shown.
 */

import { type FormEvent, useEffect, useState } from 'react';

import type { WorkItemEvent } from '../../../../core/src/messages.js';
import { relativeTimeVi } from '../agentSidebarView.js';
import { assigneeOptionsFor } from '../assigneeOptions.js';
import { failureNotice } from '../commandResults.js';
import type { CompanyClient, CompanyCommandHandle } from '../companyClient.js';
import type { CompanyViewState } from '../companyState.js';
import { useNow } from '../useNow.js';
import {
  assigneeLabel,
  findWorkItem,
  queuePosition,
  queueWaitText,
  statusWordVi,
  workItemEventLabelVi,
  workItemFolderIdentity,
  workItemsOf,
} from '../workItemView.js';
import { AssignWorkDialog } from './AssignWorkDialog.js';
import { CompanyButton } from './CompanyButton.js';
import { FolderTag } from './FolderTag.js';

/** The commands a panel sends. Each one falls back to its own notice when the server gives none. */
type PanelAction = 'verdict' | 'cancel' | 'followUp' | 'assign';

const FALLBACK_NOTICE: Readonly<Record<PanelAction, string>> = {
  verdict: 'Không đánh dấu được việc này.',
  cancel: 'Không huỷ được việc này.',
  followUp: 'Không gửi tiếp được.',
  assign: 'Không giao lại được việc này.',
};

/** A command the panel sent and is waiting on, by the requestId the client minted. */
interface SentCommand {
  requestId: string;
  action: PanelAction;
}

export interface WorkItemPanelProps {
  client: CompanyClient;
  state: CompanyViewState;
  workspacePath: string;
  id: string;
}

export function WorkItemPanel({ client, state, workspacePath, id }: WorkItemPanelProps) {
  const now = useNow();
  const item = findWorkItem(state, { id, workspacePath });
  const [draft, setDraft] = useState('');
  const [sent, setSent] = useState<SentCommand | null>(null);
  const [localNotice, setLocalNotice] = useState<string | null>(null);
  const [reassigning, setReassigning] = useState(false);

  const outcome = sent === null ? undefined : state.commandResults[sent.requestId];
  const busy = sent !== null && outcome === undefined;
  const sentAction = sent?.action ?? null;
  const followUpText = draft.trim();

  // A follow-up the server accepted has said what it had to say, so the field empties.
  useEffect(() => {
    if (outcome?.ok === true && sentAction === 'followUp') setDraft('');
  }, [outcome, sentAction]);

  // An accepted reassignment closes its dialog; a refused one keeps it open with the reason.
  useEffect(() => {
    if (outcome?.ok === true && sentAction === 'assign') setReassigning(false);
  }, [outcome, sentAction]);

  if (item === undefined) {
    return <p className="p-3 text-2xs text-text-muted">Việc này không còn trong công ty nữa.</p>;
  }

  const notice =
    localNotice ?? failureNotice(outcome, sent === null ? '' : FALLBACK_NOTICE[sent.action]);

  function send(action: PanelAction, handle: CompanyCommandHandle): void {
    setLocalNotice(failureNotice(handle, FALLBACK_NOTICE[action]));
    setSent(handle.ok ? { requestId: handle.requestId, action } : null);
  }

  // Reassign starts from a clean slate: a notice left by an earlier action does not carry over.
  function openReassign(): void {
    setLocalNotice(null);
    setSent(null);
    setReassigning(true);
  }

  function followUp(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (busy || followUpText === '') return;
    send('followUp', client.followUpWorkItem(workspacePath, id, followUpText));
  }

  const status = item.status;
  const holder = assigneeLabel(item.assignee, state, workspacePath);
  const position = queuePosition(item, workItemsOf(state, workspacePath).items);
  const folder = workItemFolderIdentity(state, workspacePath);
  const updated = relativeTimeVi(item.updatedAt, now);
  const reason = item.reason?.trim() ? item.reason : null;
  const needsAttention = status === 'needs_input' || status === 'failed';

  // The actions a status allows. The server still decides; these only hide refused moves.
  const canFinish = status !== 'done';
  const canFail =
    status === 'queued' || status === 'running' || status === 'needs_input' || status === 'review';
  const canCancel = status === 'queued';
  const canFollowUp = status === 'review' || status === 'failed';
  const canReassign = status === 'queued' || status === 'review' || status === 'failed';
  const hasActions = canFinish || canFail || canCancel || canReassign;

  return (
    <div
      data-testid="work-item-panel"
      data-status={status}
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto py-2"
    >
      <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-2.5 text-2xs">
        <dt className="text-text-muted">Trạng thái</dt>
        <dd className="text-text">{statusWordVi(status)}</dd>
        <dt className="text-text-muted">Giao cho</dt>
        <dd className="min-w-0 truncate text-text" data-testid="work-item-assignee">
          {holder}
        </dd>
        <dt className="text-text-muted">Thư mục</dt>
        <dd className="min-w-0">
          <FolderTag identity={folder} />
        </dd>
        {reason !== null && (
          <>
            <dt className="text-text-muted">Lý do</dt>
            <dd className={needsAttention ? 'text-warning' : 'text-text'}>{reason}</dd>
          </>
        )}
        {status === 'queued' && (
          <>
            <dt className="text-text-muted">Đang chờ</dt>
            <dd className="text-text">{queueWaitText(holder, position)}</dd>
          </>
        )}
        <dt className="text-text-muted">Cập nhật</dt>
        <dd className="text-text">{updated ?? '—'}</dd>
      </dl>

      <p
        data-testid="work-item-text"
        className="whitespace-pre-wrap break-words px-2.5 text-sm text-text"
      >
        {item.text}
      </p>

      {item.result !== undefined && item.result.trim() !== '' && (
        <section aria-label="Kết quả" className="flex flex-col gap-1 px-2.5">
          <p className="text-2xs text-text-muted">Kết quả</p>
          <pre
            data-testid="work-item-result"
            className="company-work-result whitespace-pre-wrap break-words rounded-(--company-radius-sm) bg-well p-2 font-mono text-2xs text-text"
          >
            {item.result}
          </pre>
        </section>
      )}

      {hasActions && (
        <div role="group" aria-label="Thao tác" className="flex flex-wrap gap-1.5 px-2.5">
          {canFinish && (
            <CompanyButton
              variant="accent"
              size="sm"
              disabled={busy}
              onClick={() => send('verdict', client.markWorkItem(workspacePath, id, 'done'))}
            >
              Xong
            </CompanyButton>
          )}
          {canFail && (
            <CompanyButton
              size="sm"
              className="text-danger"
              disabled={busy}
              onClick={() => send('verdict', client.markWorkItem(workspacePath, id, 'failed'))}
            >
              Hỏng
            </CompanyButton>
          )}
          {canCancel && (
            <CompanyButton
              size="sm"
              className="text-danger"
              disabled={busy}
              onClick={() => send('cancel', client.cancelWorkItem(workspacePath, id))}
            >
              Huỷ
            </CompanyButton>
          )}
          {canReassign && (
            <CompanyButton size="sm" disabled={busy} onClick={openReassign}>
              Giao lại
            </CompanyButton>
          )}
        </div>
      )}

      {canFollowUp && (
        <form aria-label="Gửi tiếp" onSubmit={followUp} className="flex flex-col gap-1.5 px-2.5">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={3}
            placeholder="Điều cần làm tiếp…"
            aria-label="Nội dung gửi tiếp"
            className="company-work-field w-full rounded-(--company-radius-sm) bg-raised px-2 py-1.5 text-2xs text-text"
          />
          <div className="flex justify-end">
            <CompanyButton type="submit" size="sm" disabled={busy || followUpText === ''}>
              Gửi tiếp
            </CompanyButton>
          </div>
        </form>
      )}

      {notice !== null && !reassigning && (
        <p
          role="alert"
          data-testid="work-item-notice"
          className="mx-2.5 rounded-(--company-radius-sm) bg-warning/12 px-2 py-1 text-2xs text-warning"
        >
          {notice}
        </p>
      )}

      <section aria-label="Lịch sử" className="flex flex-col gap-1.5 px-2.5">
        <p className="text-2xs text-text-muted">Lịch sử</p>
        <ol className="flex flex-col gap-1.5">
          {item.history.map((event, index) => (
            <HistoryRow key={`${event.at}:${event.kind}:${index}`} event={event} now={now} />
          ))}
        </ol>
      </section>

      {reassigning && (
        <AssignWorkDialog
          title="Giao lại việc"
          submitLabel="Giao lại"
          initialText={item.text}
          textEditable={false}
          currentAssignee={item.assignee}
          options={assigneeOptionsFor(state, workspacePath)}
          pending={busy}
          notice={notice}
          onSubmit={(assignee) =>
            send('assign', client.assignWorkItem(workspacePath, id, assignee))
          }
          onClose={() => setReassigning(false)}
        />
      )}
    </div>
  );
}

function HistoryRow({ event, now }: { event: WorkItemEvent; now: number }) {
  const when = relativeTimeVi(event.at, now);
  return (
    <li className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 text-2xs">
      <span className="text-text">{workItemEventLabelVi(event.kind)}</span>
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
