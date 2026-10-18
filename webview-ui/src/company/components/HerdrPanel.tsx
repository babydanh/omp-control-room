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
import { useEffect, useMemo, useState } from 'react';

import type { HerdrKey } from '../../../../core/src/messages.js';
import { failureNotice } from '../commandResults.js';
import type { CompanyClient, CompanyCommandHandle } from '../companyClient.js';
import type { CompanyViewState } from '../companyState.js';
import { HERDR_SCREEN_POLL_MS } from '../constants.js';
import {
  HERDR_CHOICE_KEYS,
  HERDR_DRAWER_TAB_LABELS,
  HERDR_TONE_LABELS,
  type HerdrDrawerTab,
  herdrNeedsScreenPolling,
  herdrToneFor,
} from '../herdrView.js';
import { formatLogTime } from '../sessionLogView.js';
import { parseAnsiScreen } from '../terminalScreen.js';
import { HerdrInfoTab } from './AgentInfoTab.js';
import { CompanyButton } from './CompanyButton.js';
import { ScreenView } from './ScreenView.js';

const HERDR_TABS = ['screen', 'info'] as const satisfies readonly HerdrDrawerTab[];

export interface HerdrPanelProps {
  client: CompanyClient;
  state: CompanyViewState;
  paneId: string;
  /** The tab the panel shows. The drawer owns it, so a request for the info tab survives. */
  tab: HerdrDrawerTab;
  onTabChange: (tab: HerdrDrawerTab) => void;
}

export function HerdrPanel({ client, state, paneId, tab, onTabChange }: HerdrPanelProps) {
  const agent = state.herdr.agents.find((entry) => entry.paneId === paneId);
  const status = agent?.status;
  const screen = state.herdr.screens[paneId];
  const [draft, setDraft] = useState('');
  const [sentPrompt, setSentPrompt] = useState<string | null>(null);
  const [lastRequest, setLastRequest] = useState<string | null>(null);
  const [localNotice, setLocalNotice] = useState<string | null>(null);
  const polling = tab === 'screen' && status !== undefined && herdrNeedsScreenPolling(status);
  const screenLines = useMemo(() => parseAnsiScreen(screen?.text ?? ''), [screen?.text]);

  // Read the screen while the screen tab is open, and whenever the agent's status moves.
  useEffect(() => {
    if (tab !== 'screen') return undefined;
    const handle = client.herdrRead(paneId);
    setLocalNotice(failureNotice(handle, 'Không gửi được.'));
  }, [client, paneId, status, tab]);

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
  const notice = localNotice ?? failureNotice(lastOutcome, 'Máy chủ từ chối lệnh này.');

  function track(handle: CompanyCommandHandle): void {
    setLastRequest(handle.requestId);
    setLocalNotice(failureNotice(handle, 'Không gửi được.'));
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

      <nav aria-label="Phần của agent herdr" className="flex gap-1 border-b border-border">
        {HERDR_TABS.map((entry) => (
          <button
            key={entry}
            type="button"
            onClick={() => onTabChange(entry)}
            aria-current={tab === entry}
            className={`-mb-px cursor-pointer border-b-2 px-2 py-1.5 text-2xs ${
              tab === entry
                ? 'border-accent text-text'
                : 'border-transparent text-text-muted hover:text-text'
            }`}
          >
            {HERDR_DRAWER_TAB_LABELS[entry]}
          </button>
        ))}
      </nav>

      {tab === 'info' ? (
        <HerdrInfoTab
          client={client}
          state={state}
          paneId={paneId}
          fallbackCwd={agent.cwd ?? null}
        />
      ) : (
        <>
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
            {screen ? (
              <ScreenView
                testId="herdr-screen"
                lines={screenLines}
                className="min-h-0 flex-1 overflow-auto rounded-[6px] border border-border p-2"
              />
            ) : (
              <p className="rounded-[6px] border border-border bg-bg p-2 text-2xs text-text-muted">
                Chưa đọc màn hình.
              </p>
            )}
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
        </>
      )}
    </div>
  );
}
