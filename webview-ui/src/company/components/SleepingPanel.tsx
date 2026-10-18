/**
 * SleepingPanel: one hibernated omp session, seen from the drawer and woken from it.
 *
 * Its pane is still held in herdr, but no agent runs in it. Waking it is the one action
 * here: the optional prompt goes with the wake. The draft clears only when the server
 * confirms the wake, and the session leaves the sleeping list only when the server says
 * so, so this panel never removes the session on its own.
 */

import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';

import { sleepingRowFor } from '../agentSidebarView.js';
import { failureNotice } from '../commandResults.js';
import type { CompanyClient } from '../companyClient.js';
import type { CompanyViewState } from '../companyState.js';
import { useNow } from '../useNow.js';
import { CompanyButton } from './CompanyButton.js';
import { Icon } from './Icon.js';

/** The server's limit on a wake prompt, in characters. */
const WAKE_PROMPT_MAX_CHARS = 4000;

export interface SleepingPanelProps {
  client: CompanyClient;
  state: CompanyViewState;
  paneId: string;
}

export function SleepingPanel({ client, state, paneId }: SleepingPanelProps) {
  const now = useNow();
  const session = state.herdr.sleeping.find((entry) => entry.paneId === paneId);
  const [draft, setDraft] = useState('');
  const [wakeRequest, setWakeRequest] = useState<string | null>(null);
  const [localNotice, setLocalNotice] = useState<string | null>(null);

  // The draft is cleared only when the server confirms the wake, so a refused wake keeps
  // its prompt there to be fixed and sent again.
  const wakeOutcome = wakeRequest === null ? undefined : state.commandResults[wakeRequest];
  useEffect(() => {
    if (wakeOutcome?.ok !== true) return;
    setDraft('');
    setWakeRequest(null);
  }, [wakeOutcome]);

  const waking = wakeRequest !== null && wakeOutcome === undefined;
  const notice = localNotice ?? failureNotice(wakeOutcome, 'Máy chủ từ chối lệnh này.');

  if (session === undefined) {
    return (
      <p className="p-2 text-2xs text-text-muted">Phiên ngủ đông này không còn trong herdr.</p>
    );
  }

  const row = sleepingRowFor(session, now);
  const sleptAt = new Date(row.sleptAt).toLocaleString('vi-VN');

  function wake(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const text = draft.trim();
    const handle = client.herdrWake(paneId, text === '' ? undefined : text);
    setLocalNotice(failureNotice(handle, 'Không đánh thức được.'));
    setWakeRequest(handle.ok ? handle.requestId : null);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2" data-testid="sleeping-panel">
      <div className="flex flex-col gap-1 text-2xs text-text-muted">
        <p>
          <Icon name="moon" className="mr-0.5" /> Ngủ đông · {row.repo.label}
        </p>
        <p className="truncate text-text">{row.name}</p>
        {row.sleptLabel !== null && <p>{row.sleptLabel}</p>}
        <p>Thời điểm ngủ đông: {sleptAt}</p>
        {row.branch !== null && (
          <p>
            Nhánh: <span className="font-mono text-status-active">{row.branch}</span>
          </p>
        )}
        {row.worktreeRoot !== null && (
          <p className="truncate" title={row.worktreeRoot}>
            {row.worktreeRoot}
          </p>
        )}
        {row.cwd !== null && (
          <p className="truncate" title={row.cwd}>
            {row.cwd}
          </p>
        )}
        <p className="truncate" title={row.sessionFile}>
          Tệp phiên: {row.sessionFile}
        </p>
      </div>

      {notice && (
        <p
          role="alert"
          className="rounded-(--company-radius-sm) bg-warning/12 px-2 py-1 text-2xs text-warning"
        >
          {notice}
        </p>
      )}

      <form onSubmit={wake} className="flex gap-1">
        <input
          aria-label="Lời nhắc khi đánh thức"
          value={draft}
          maxLength={WAKE_PROMPT_MAX_CHARS}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Lời nhắc khi đánh thức (không bắt buộc)"
          className="min-w-0 flex-1 rounded-(--company-radius-sm) bg-raised px-2 py-1 text-2xs text-text"
        />
        <CompanyButton type="submit" size="sm" disabled={waking}>
          {waking ? 'Đang đánh thức…' : 'Đánh thức'}
        </CompanyButton>
      </form>
    </div>
  );
}
