/**
 * PreviewPrompt: the line under a hover preview that sends a prompt to the row's agent.
 *
 * It types into a herdr pane or a live company session through promptTargets.ts and
 * never touches the composer's draft. Its text lives only as long as the preview: a
 * closed preview drops it. While the input has focus or holds text, the preview is
 * pinned open (see terminalPreview.ts). Enter sends, Shift+Enter starts a new line, and
 * Escape closes the preview from the provider.
 */

import { type KeyboardEvent, useEffect, useState } from 'react';

import type { HerdrKey } from '../../../../core/src/messages.js';
import { isBrowserRuntime } from '../../runtime.js';
import { serverToken } from '../../transport/serverToken.js';
import type { CompanyClient } from '../companyClient.js';
import type { CompanyViewState } from '../companyState.js';
import { HERDR_CHOICE_KEYS } from '../herdrView.js';
import {
  draftAfterSend,
  previewInputOf,
  sendPrompt,
  type SendStatus,
  sendStatus,
  type SentLine,
} from '../promptTargets.js';
import type { PreviewTarget } from '../terminalPreview.js';
import { CompanyButton } from './CompanyButton.js';

/**
 * A browser tab without the server token is not a privileged connection, and the server
 * refuses its company commands. The extension host and a token-bearing tab may send.
 */
const CONNECTION_PRIVILEGED = !isBrowserRuntime || serverToken !== null;

export interface PreviewPromptProps {
  client: CompanyClient;
  state: CompanyViewState;
  target: PreviewTarget;
  /** Reports whether the input holds the preview open. */
  onPinChange: (pinned: boolean) => void;
}

export function PreviewPrompt({ client, state, target, onPinChange }: PreviewPromptProps) {
  const input = previewInputOf(target, {
    herdrAgents: state.herdr.agents,
    herdrSleeping: state.herdr.sleeping,
    sessions: state.sessions,
    privileged: CONNECTION_PRIVILEGED,
  });
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);
  const [sent, setSent] = useState<SentLine | null>(null);
  const [keyed, setKeyed] = useState<SentLine | null>(null);
  const [woken, setWoken] = useState<SentLine | null>(null);

  // The input holds the preview open while it has focus or text.
  const pinned = focused || draft !== '';
  useEffect(() => {
    onPinChange(pinned);
  }, [pinned, onPinChange]);

  const sentStatus = sent === null ? null : sendStatus(sent, state.commandResults);
  const keyStatus = keyed === null ? null : sendStatus(keyed, state.commandResults);
  const wakeStatus = woken === null ? null : sendStatus(woken, state.commandResults);
  const confirmed = sentStatus?.kind === 'sent';
  // A confirmed send clears the text it sent, unless the user has typed something since.
  useEffect(() => {
    if (sent === null || !confirmed) return;
    setDraft((current) => draftAfterSend(current, sent.text));
  }, [sent, confirmed]);

  if (input.kind === 'none') return null;
  const ready = input.kind === 'ready';
  const busy = sentStatus?.kind === 'sending';
  const herdrPane =
    input.kind === 'ready' && input.target.kind === 'herdr' ? input.target.paneId : null;
  const wakePane = input.kind === 'off' ? input.wakePane : null;

  function send(): void {
    if (input.kind !== 'ready' || busy) return;
    const handle = sendPrompt(client, input.target, draft);
    if (handle !== null) setSent({ text: draft.trim(), handle });
  }

  function sendKey(key: HerdrKey): void {
    if (herdrPane !== null) setKeyed({ text: '', handle: client.herdrKeys(herdrPane, [key]) });
  }

  function wake(paneId: string): void {
    setWoken({ text: '', handle: client.herdrWake(paneId) });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // Enter sends. Shift+Enter keeps its line break, and an IME's Enter only confirms a candidate.
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  }

  return (
    <div className="flex shrink-0 flex-col gap-1 p-2" data-testid="preview-prompt">
      {input.kind === 'ready' && input.choices && (
        <div role="group" aria-label="Phím gửi tới agent" className="flex flex-wrap gap-1">
          {HERDR_CHOICE_KEYS.map((choice) => (
            <CompanyButton key={choice.key} size="sm" onClick={() => sendKey(choice.key)}>
              {choice.label}
            </CompanyButton>
          ))}
        </div>
      )}
      {input.kind === 'off' && <p className="text-2xs text-text-muted">{input.reason}</p>}
      <div className="flex items-end gap-1">
        <textarea
          rows={1}
          value={draft}
          disabled={!ready}
          aria-label="Lời nhắc tới agent"
          placeholder={ready ? 'Gửi lời nhắc tới agent · Esc để đóng' : undefined}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
          className="max-h-20 min-h-0 min-w-0 flex-1 resize-none rounded-(--company-radius-sm) bg-well px-2 py-1 text-2xs text-text disabled:opacity-60"
        />
        {ready && (
          <CompanyButton
            size="sm"
            className="shrink-0"
            disabled={draft.trim() === '' || busy}
            onClick={send}
          >
            {busy ? 'Đang gửi…' : 'Gửi'}
          </CompanyButton>
        )}
        {wakePane !== null && (
          <CompanyButton
            size="sm"
            className="shrink-0"
            disabled={wakeStatus?.kind === 'sending'}
            onClick={() => {
              if (wakePane !== null) wake(wakePane);
            }}
          >
            Đánh thức
          </CompanyButton>
        )}
      </div>
      <SendNote status={sentStatus} sendingText="Đang gửi…" sentText="Đã gửi." />
      <SendNote status={keyStatus} sendingText="Đang gửi phím…" sentText="Đã gửi phím." />
      <SendNote status={wakeStatus} sendingText="Đang đánh thức…" sentText="Đã đánh thức." />
    </div>
  );
}

function SendNote({
  status,
  sendingText,
  sentText,
}: {
  status: SendStatus | null;
  sendingText: string;
  sentText: string;
}) {
  if (status === null) return null;
  if (status.kind === 'failed') {
    return (
      <p role="alert" className="text-2xs text-danger">
        {status.message}
      </p>
    );
  }
  return (
    <p role="status" className="text-2xs text-text-muted">
      {status.kind === 'sending' ? sendingText : sentText}
    </p>
  );
}
