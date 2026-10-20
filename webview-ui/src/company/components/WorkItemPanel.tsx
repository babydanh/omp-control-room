/**
 * WorkItemPanel: one work item, read from the server's copy and acted on from the drawer.
 *
 * The panel names what the server holds: the status, who holds the item, why it waits, its text,
 * its result and its history. Its actions follow the status, and each one is a command. The
 * item moves only when the server says so; the verdict decides the notice shown.
 */

import { type FormEvent, useEffect, useState } from 'react';

import type { WorkItem, WorkItemEvent } from '../../../../core/src/messages.js';
import { priorityLabel } from '../../../../core/src/workItemGraph.js';
import { relativeTimeVi } from '../agentSidebarView.js';
import { assigneeOptionsFor } from '../assigneeOptions.js';
import { claudeInterruptedNote, claudeProgressLine } from '../claudeCodeView.js';
import { failureNotice } from '../commandResults.js';
import type { CompanyClient, CompanyCommandHandle } from '../companyClient.js';
import type { CompanyViewState } from '../companyState.js';
import { useNow } from '../useNow.js';
import {
  conflictText,
  isParkedAssignee,
  judgeChipFor,
  worktreeOffer,
} from '../workItemReviewView.js';
import {
  assigneeLabel,
  blockerSentence,
  dependencyChoices,
  dependencyRefusal,
  dependencyRefusalText,
  findWorkItem,
  queuePosition,
  queueWaitText,
  statusWordVi,
  type WaitingOn,
  waitingOn,
  waitingOnLabel,
  workItemEventLabelVi,
  workItemFolderIdentity,
  workItemsOf,
} from '../workItemView.js';
import { AssignWorkDialog } from './AssignWorkDialog.js';
import { CompanyButton } from './CompanyButton.js';
import { FolderTag } from './FolderTag.js';
import { WorkItemReviewChips } from './WorkItemReviewChips.js';

/** The commands a panel sends. Each one falls back to its own notice when the server gives none. */
type PanelAction =
  | 'verdict'
  | 'cancel'
  | 'followUp'
  | 'assign'
  | 'dependencies'
  | 'squad'
  | 'judge'
  | 'cleanWorktree';

const FALLBACK_NOTICE: Readonly<Record<PanelAction, string>> = {
  verdict: 'Không đánh dấu được việc này.',
  cancel: 'Không huỷ được việc này.',
  followUp: 'Không gửi tiếp được.',
  assign: 'Không giao lại được việc này.',
  dependencies: 'Không lưu được việc chờ.',
  squad: 'Không hỏi được đội trưởng.',
  judge: 'Không chấm lại được việc này.',
  cleanWorktree: 'Không dọn được worktree của việc này.',
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

  function saveDependencies(dependsOn: string[]): void {
    send('dependencies', client.setWorkItemDependencies(workspacePath, id, dependsOn));
  }

  function askLeader(): void {
    send('squad', client.requestSquadFromWorkItem(workspacePath, id));
  }

  const status = item.status;
  const holder = assigneeLabel(item.assignee, state, workspacePath);
  const folderWork = workItemsOf(state, workspacePath);
  const folderItems = folderWork.items;
  const position = queuePosition(item, folderItems);
  const waits = waitingOn(item, folderItems);
  // A queued item held by another item says so in the server's words; an agent wait keeps its place.
  const blocker = item.blocker;
  const waitText =
    blocker !== undefined && blocker.kind !== 'agent'
      ? blockerSentence(blocker)
      : queueWaitText(item.assignee.kind === 'auto' ? 'agent' : holder, position);
  const folder = workItemFolderIdentity(state, workspacePath);
  const updated = relativeTimeVi(item.updatedAt, now);
  const reason = item.reason?.trim() ? item.reason : null;
  const acceptance = item.acceptance?.trim() || null;
  const needsAttention = status === 'needs_input' || status === 'failed';
  const judge = judgeChipFor(item);
  const worktree = worktreeOffer(item);
  const parked = isParkedAssignee(item.assignee, folderWork.parkedSessionIds);
  const canRejudge = judge?.rejudge === true;
  const canCleanWorktree = worktree === 'clean';

  // The actions a status allows. The server still decides; these only hide refused moves.
  const canFinish = status !== 'done';
  const canFail =
    status === 'queued' || status === 'running' || status === 'needs_input' || status === 'review';
  const canCancel = status === 'queued';
  const canFollowUp = status === 'review' || status === 'failed';
  const canReassign = status === 'queued' || status === 'review' || status === 'failed';
  const canAskLeader = status === 'review' && item.squadRunId === undefined;
  const hasActions =
    canFinish ||
    canFail ||
    canCancel ||
    canReassign ||
    canAskLeader ||
    canRejudge ||
    canCleanWorktree;

  const progress = claudeProgressLine(item);
  const interrupted = claudeInterruptedNote(item.claudeRun);

  return (
    <div
      data-testid="work-item-panel"
      data-status={status}
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto py-2"
    >
      <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-2.5 text-2xs">
        <dt className="text-text-muted">Trạng thái</dt>
        <dd className="text-text">{statusWordVi(status)}</dd>
        <dt className="text-text-muted">Ưu tiên</dt>
        <dd className="text-text">{priorityLabel(item.priority)}</dd>
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
        {progress !== null && (
          <>
            <dt className="text-text-muted">Tiến độ</dt>
            <dd
              data-testid="work-item-claude-progress"
              className="whitespace-pre-wrap break-words text-text"
            >
              {progress}
            </dd>
          </>
        )}
        {acceptance !== null && (
          <>
            <dt className="text-text-muted">Xong khi</dt>
            <dd className="whitespace-pre-wrap break-words text-text">{acceptance}</dd>
          </>
        )}
        {status === 'queued' && (
          <>
            <dt className="text-text-muted">Đang chờ</dt>
            <dd className="text-text">{waitText}</dd>
          </>
        )}
        <dt className="text-text-muted">Cập nhật</dt>
        <dd className="text-text">{updated ?? '—'}</dd>
      </dl>
      {interrupted !== null && (
        <p data-testid="work-item-claude-interrupted" className="px-2.5 text-2xs text-warning">
          {interrupted}
        </p>
      )}
      <WorkItemReviewChips
        judge={judge}
        conflictText={conflictText(item.conflicts)}
        parked={parked}
        className="px-2.5"
      />

      <p
        data-testid="work-item-text"
        className="whitespace-pre-wrap break-words px-2.5 text-sm text-text"
      >
        {item.text}
      </p>

      {status === 'queued' && (
        <DependencyEditor
          key={item.dependsOn.join('|')}
          item={item}
          choices={dependencyChoices(item, folderItems)}
          items={folderItems}
          busy={busy}
          onSave={saveDependencies}
        />
      )}

      {status !== 'queued' && waits.length > 0 && (
        <section aria-label="Chờ việc" className="flex flex-col gap-1.5 px-2.5">
          <p className="text-2xs text-text-muted">Chờ việc</p>
          <ul className="flex flex-col gap-1">
            {waits.map((entry) => (
              <li key={entry.id} className="min-w-0 break-words text-2xs text-text">
                {waitingOnLabel(entry)}
              </li>
            ))}
          </ul>
        </section>
      )}

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
          {canRejudge && (
            <CompanyButton
              size="sm"
              disabled={busy}
              onClick={() => send('judge', client.judgeWorkItem(workspacePath, id))}
            >
              Chấm lại
            </CompanyButton>
          )}
          {canReassign && (
            <CompanyButton size="sm" disabled={busy} onClick={openReassign}>
              Giao lại
            </CompanyButton>
          )}
          {canAskLeader && (
            <CompanyButton size="sm" disabled={busy} onClick={askLeader}>
              Hỏi đội trưởng bước tiếp
            </CompanyButton>
          )}
          {canCleanWorktree && (
            <CompanyButton
              size="sm"
              disabled={busy}
              onClick={() => send('cleanWorktree', client.cleanWorkItemWorktree(workspacePath, id))}
            >
              Dọn worktree
            </CompanyButton>
          )}
        </div>
      )}
      {worktree === 'removed' && (
        <p data-testid="work-item-worktree-removed" className="px-2.5 text-2xs text-text-muted">
          Worktree đã dọn
        </p>
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
          repos={folderWork.repos}
          agents={folderWork.agents}
          initialFields={{ repo: item.repo, role: item.role, areas: item.areas, agent: item.agent }}
          pending={busy}
          notice={notice}
          onSubmit={(assignee, _text, fields) =>
            send('assign', client.assignWorkItem(workspacePath, id, assignee, fields))
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

interface DependencyEditorProps {
  item: WorkItem;
  /** The open items the list may name, plus any this item already waits for. */
  choices: readonly WaitingOn[];
  /** The folder's items; the refusal check reads each one's wait list from them. */
  items: readonly WorkItem[];
  busy: boolean;
  onSave: (dependsOn: string[]) => void;
}

/**
 * The wait-list editor a queued item shows. Picks stay put while the server answers; the panel
 * keys the editor by the stored list, so a saved list replaces the picks it started from.
 */
function DependencyEditor({ item, choices, items, busy, onSave }: DependencyEditorProps) {
  const [picked, setPicked] = useState<string[]>(item.dependsOn);
  const refusal = dependencyRefusal(item, picked, items);
  const unchanged =
    picked.length === item.dependsOn.length && picked.every((id) => item.dependsOn.includes(id));
  const saveDisabled = busy || unchanged || refusal !== null;

  function toggle(id: string, on: boolean): void {
    setPicked((current) =>
      on
        ? [...current.filter((entry) => entry !== id), id]
        : current.filter((entry) => entry !== id),
    );
  }

  return (
    <section aria-label="Chờ việc" className="flex flex-col gap-1.5 px-2.5">
      <p className="text-2xs text-text-muted">Chờ việc</p>
      {choices.length === 0 ? (
        <p className="text-2xs text-text-muted">Thư mục chưa có việc nào khác đang mở.</p>
      ) : (
        <fieldset className="flex flex-col gap-1">
          <legend className="sr-only">Việc này chờ</legend>
          {choices.map((choice) => (
            <label key={choice.id} className="flex min-w-0 items-start gap-1.5 text-2xs text-text">
              <input
                type="checkbox"
                checked={picked.includes(choice.id)}
                onChange={(event) => toggle(choice.id, event.target.checked)}
                className="mt-0.5 shrink-0"
              />
              <span className="min-w-0 break-words">{waitingOnLabel(choice)}</span>
            </label>
          ))}
        </fieldset>
      )}
      {refusal !== null && (
        <p className="text-2xs text-warning">{dependencyRefusalText(refusal)}</p>
      )}
      <div className="flex justify-end">
        <CompanyButton size="sm" disabled={saveDisabled} onClick={() => onSave(picked)}>
          Lưu việc chờ
        </CompanyButton>
      </div>
    </section>
  );
}
