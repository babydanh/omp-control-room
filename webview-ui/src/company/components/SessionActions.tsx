/**
 * SessionActions: a session's lifecycle buttons, for the drawer.
 *
 * Interrupt stops the running turn like Esc and keeps the session. Kill stops its
 * process. Delete removes the session from the board and deletes its omp session file
 * and board log. Each command waits for the server's verdict and shows it; a refusal
 * reads as the server's own message. Delete is held back, with its reason, while the
 * session still holds work.
 *
 * ConfirmAction is the small confirm that kill, delete and withdrawing a prompt share.
 */

import { useState } from 'react';

import { pendingQuestionSessionIds } from '../agentSidebarView.js';
import { failureNotice } from '../commandResults.js';
import type { CompanyClient } from '../companyClient.js';
import type { CompanyViewState } from '../companyState.js';
import {
  DELETE_CONFIRM_DETAIL,
  HOLDS_WORK_REASON,
  REFUSED_NOTICE,
  sessionControls,
  sessionHoldsWork,
} from '../sessionActions.js';
import { deleteSession } from '../sessionRemoval.js';
import { CompanyButton } from './CompanyButton.js';

export interface SessionActionsProps {
  client: CompanyClient;
  state: CompanyViewState;
  sessionId: string;
}

type Command = 'interrupt' | 'kill' | 'delete';

interface Notice {
  text: string;
  failed: boolean;
}

const DONE_TEXT: Record<Command, string> = {
  interrupt: 'Đã dừng lượt đang chạy; phiên vẫn còn.',
  kill: 'Đã tắt phiên.',
  delete: 'Đã xoá phiên.',
};

export function SessionActions({ client, state, sessionId }: SessionActionsProps) {
  const [confirming, setConfirming] = useState<'kill' | 'delete' | null>(null);
  const [pending, setPending] = useState<Command | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const session = state.sessions[sessionId];
  if (session === undefined) return null;

  const controls = sessionControls(session.status);
  const holdsWork = sessionHoldsWork(session, pendingQuestionSessionIds(state).has(sessionId));
  const busy = pending !== null;

  async function run(command: Command): Promise<void> {
    setConfirming(null);
    setPending(command);
    setNotice(null);
    const verdict =
      command === 'delete'
        ? await deleteSession(client, sessionId)
        : await client.waitForCommand(client.controlSession(sessionId, command));
    setPending(null);
    const failure = failureNotice(verdict, REFUSED_NOTICE);
    setNotice(
      failure === null
        ? { text: DONE_TEXT[command], failed: false }
        : { text: failure, failed: true },
    );
  }

  return (
    <div data-testid="session-actions" className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1">
        {controls.interrupt && (
          <CompanyButton size="sm" disabled={busy} onClick={() => void run('interrupt')}>
            Dừng lượt
          </CompanyButton>
        )}
        {controls.kill && (
          <CompanyButton
            size="sm"
            className="text-warning"
            disabled={busy}
            onClick={() => setConfirming('kill')}
          >
            Tắt phiên
          </CompanyButton>
        )}
        <CompanyButton
          size="sm"
          className="text-warning"
          disabled={busy || holdsWork}
          title={holdsWork ? HOLDS_WORK_REASON : undefined}
          onClick={() => setConfirming('delete')}
        >
          Xoá phiên…
        </CompanyButton>
      </div>
      {holdsWork && <p className="text-2xs text-text-muted">{HOLDS_WORK_REASON}</p>}
      {confirming === 'kill' && (
        <ConfirmAction
          message={`Tắt phiên ${session.code}? Phiên đang chạy sẽ bị dừng ngay.`}
          confirmLabel="Tắt phiên"
          danger
          disabled={busy}
          onConfirm={() => void run('kill')}
          onCancel={() => setConfirming(null)}
        />
      )}
      {confirming === 'delete' && (
        <ConfirmAction
          message={`Xoá phiên ${session.code}? ${DELETE_CONFIRM_DETAIL}`}
          confirmLabel="Xoá phiên"
          danger
          disabled={busy}
          onConfirm={() => void run('delete')}
          onCancel={() => setConfirming(null)}
        />
      )}
      {notice !== null && (
        <p role="status" className={notice.failed ? 'text-warning' : 'text-text-muted'}>
          {notice.text}
        </p>
      )}
    </div>
  );
}

export interface ConfirmActionProps {
  message: string;
  confirmLabel: string;
  danger?: boolean;
  disabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A question with two answers: the action's own label, or "Quay lại", which backs out.
 * Shared by the drawer, the agent menu and the planning card.
 */
export function ConfirmAction({
  message,
  confirmLabel,
  danger = false,
  disabled = false,
  onConfirm,
  onCancel,
}: ConfirmActionProps) {
  return (
    <div role="group" aria-label="Xác nhận" className="flex flex-col gap-2">
      <p className="text-text">{message}</p>
      <div className="flex gap-1">
        <CompanyButton
          size="sm"
          className={danger ? 'text-warning' : undefined}
          disabled={disabled}
          onClick={onConfirm}
        >
          {confirmLabel}
        </CompanyButton>
        <CompanyButton size="sm" disabled={disabled} onClick={onCancel}>
          Quay lại
        </CompanyButton>
      </div>
    </div>
  );
}
