/**
 * HerdrPanel: one herdr agent, seen and driven from the board.
 *
 * The screen is the agent's own terminal as herdr shows it. It is read on open,
 * on every status change, and every couple of seconds while the agent works.
 * The choice keys appear only while the agent waits on a choice. The prompt box
 * sends text the agent reads as typed input, and clears only after the server
 * confirms it went through.
 */

import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';

import type { HerdrKey } from '../../../../core/src/messages.js';
import type { CompanyClient, CompanyCommandHandle } from '../companyClient.js';
import type { CompanyViewState } from '../companyState.js';
import { HERDR_SCREEN_POLL_MS } from '../constants.js';
import {
  HERDR_CHOICE_KEYS,
  HERDR_TONE_LABELS,
  herdrNeedsScreenPolling,
  herdrToneFor,
} from '../herdrView.js';
import { formatLogTime } from '../sessionLogView.js';
import { CompanyButton } from './CompanyButton.js';

export interface HerdrPanelProps {
  client: CompanyClient;
  state: CompanyViewState;
  paneId: string;
}

/** The notice for a command the board could not send, or null when it went out. */
function sendFailure(handle: CompanyCommandHandle): string | null {
  if (handle.ok) return null;
  return handle.message ?? handle.errorCode ?? 'Không gửi được.';
}

export function HerdrPanel({ client, state, paneId }: HerdrPanelProps) {
  const agent = state.herdr.agents.find((entry) => entry.paneId === paneId);
  const status = agent?.status;
  const screen = state.herdr.screens[paneId];
  const [draft, setDraft] = useState('');
  const [sentPrompt, setSentPrompt] = useState<string | null>(null);
  const [lastRequest, setLastRequest] = useState<string | null>(null);
  const [localNotice, setLocalNotice] = useState<string | null>(null);
  const polling = status !== undefined && herdrNeedsScreenPolling(status);

  // Read the screen when the panel opens and whenever the agent's status moves.
  useEffect(() => {
    const handle = client.herdrRead(paneId);
    setLocalNotice(sendFailure(handle));
  }, [client, paneId, status]);

  useEffect(() => {
    if (!polling) return undefined;
    const timer = window.setInterval(() => {
      client.herdrRead(paneId);
    }, HERDR_SCREEN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [client, paneId, polling]);

  // The draft is cleared only when the server confirms the prompt was sent, so
  // a rejected prompt is still there to be fixed and sent again.
  const promptOutcome = sentPrompt === null ? undefined : state.commandResults[sentPrompt];
  useEffect(() => {
    if (promptOutcome?.ok !== true) return;
    setDraft('');
    setSentPrompt(null);
  }, [promptOutcome]);

  const lastOutcome = lastRequest === null ? undefined : state.commandResults[lastRequest];
  const notice =
    localNotice ??
    (lastOutcome && !lastOutcome.ok
      ? (lastOutcome.message ?? lastOutcome.errorCode ?? 'Máy chủ từ chối lệnh này.')
      : null);

  function track(handle: CompanyCommandHandle): void {
    setLastRequest(handle.requestId);
    setLocalNotice(sendFailure(handle));
  }

  function sendKey(key: HerdrKey): void {
    track(client.herdrKeys(paneId, [key]));
  }

  function sendPrompt(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const text = draft.trim();
    if (text === '') return;
    const handle = client.herdrPrompt(paneId, text);
    track(handle);
    setSentPrompt(handle.ok ? handle.requestId : null);
  }

  if (agent === undefined) {
    return <p className="p-2 text-2xs text-text-muted">Agent này không còn trong herdr.</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2" data-testid="herdr-panel">
      <div className="flex flex-col gap-1 text-2xs text-text-muted">
        <p>
          {agent.kind} &middot; {HERDR_TONE_LABELS[herdrToneFor(agent.status)]}
        </p>
        {agent.title && <p className="truncate text-text">{agent.title}</p>}
        {agent.cwd && (
          <p className="truncate" title={agent.cwd}>
            {agent.cwd}
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-1">
        <CompanyButton size="sm" onClick={() => track(client.herdrFocus(paneId))}>
          Mở trong herdr
        </CompanyButton>
        <CompanyButton size="sm" onClick={() => track(client.herdrRead(paneId))}>
          Đọc lại màn hình
        </CompanyButton>
      </div>

      {agent.status === 'blocked' && (
        <div className="flex flex-wrap gap-1" role="group" aria-label="Phím gửi tới agent">
          {HERDR_CHOICE_KEYS.map((choice) => (
            <CompanyButton key={choice.key} size="sm" onClick={() => sendKey(choice.key)}>
              {choice.label}
            </CompanyButton>
          ))}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-1">
        {screen && (
          <p className="text-2xs text-text-muted">màn hình lúc {formatLogTime(screen.at)}</p>
        )}
        <pre
          data-testid="herdr-screen"
          className="min-h-0 flex-1 overflow-auto whitespace-pre rounded-[6px] border border-border bg-bg p-2 text-2xs text-text"
        >
          {screen ? screen.text : 'Chưa đọc màn hình.'}
        </pre>
      </div>

      {notice && (
        <p role="alert" className="text-2xs text-warning">
          {notice}
        </p>
      )}

      <form onSubmit={sendPrompt} className="flex gap-1">
        <input
          aria-label="Gửi lời nhắc tới agent"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Gửi lời nhắc tới agent…"
          className="min-w-0 flex-1 rounded-[5px] border border-border bg-bg px-2 py-1 text-2xs text-text"
        />
        <CompanyButton type="submit" size="sm" disabled={draft.trim() === ''}>
          Gửi
        </CompanyButton>
      </form>
    </div>
  );
}
