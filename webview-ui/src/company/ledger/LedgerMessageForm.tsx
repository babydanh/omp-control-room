/**
 * LedgerMessageForm: sends one text to a chosen session through the ledger. The result
 * line follows the store's send record for this form's latest request, so a refusal
 * shows its reason and a delivery shows how many sessions received it.
 */

import { useState } from 'react';

import { Icon } from '../components/Icon.js';
import { ledgerStore } from './ledgerClient.js';
import { LEDGER_MESSAGE_MAX_LENGTH, ledgerMessageProblem } from './ledgerFormat.js';
import type { LedgerSendView } from './ledgerStore.js';

export interface LedgerMessageTarget {
  sessionId: string;
  label: string;
}

export interface LedgerMessageFormProps {
  targets: readonly LedgerMessageTarget[];
  sends: readonly LedgerSendView[];
}

export function LedgerMessageForm({ targets, sends }: LedgerMessageFormProps) {
  const [chosen, setChosen] = useState('');
  const [text, setText] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);

  if (targets.length === 0) {
    return <p className="text-2xs text-text-muted">Không có phiên nào để nhắn tin.</p>;
  }

  const target = targets.some((item) => item.sessionId === chosen)
    ? chosen
    : (targets[0]?.sessionId ?? '');
  const problem = ledgerMessageProblem(text);
  const blocked = problem !== null;
  const result =
    requestId === null ? null : (sends.find((item) => item.requestId === requestId) ?? null);

  function send(): void {
    if (blocked) return;
    setRequestId(ledgerStore.sendMessage(target, text.trim()));
    setText('');
  }

  return (
    <form
      aria-label="Gửi tin nhắn"
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <label className="flex flex-col gap-1 text-2xs text-text-muted">
        Gửi tới
        <select
          value={target}
          onChange={(event) => setChosen(event.target.value)}
          className="rounded-(--company-radius-sm) bg-raised px-1 py-0.5 text-sm text-text"
        >
          {targets.map((item) => (
            <option key={item.sessionId} value={item.sessionId}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-2xs text-text-muted">
        Nhắn tin
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={3}
          className="w-full rounded-(--company-radius-sm) bg-raised p-1 text-sm text-text"
        />
      </label>
      <div className="flex items-center justify-between gap-2 text-2xs text-text-muted">
        <span>
          {[...text].length}/{LEDGER_MESSAGE_MAX_LENGTH}
        </span>
        <button
          type="submit"
          disabled={blocked}
          className="company-btn company-btn-md company-btn-accent touch-target"
        >
          <Icon name="send" /> Gửi
        </button>
      </div>
      {text !== '' && problem !== null && <p className="text-2xs text-warning">{problem}</p>}
      {result !== null && <SendResult result={result} />}
    </form>
  );
}

function SendResult({ result }: { result: LedgerSendView }) {
  if (result.status === 'sending') {
    return (
      <p role="status" className="text-2xs text-text-muted">
        Đang gửi…
      </p>
    );
  }
  if (result.status === 'delivered') {
    return (
      <p role="status" className="text-2xs text-status-success">
        Đã gửi tới {result.delivered.length} phiên.
      </p>
    );
  }
  return (
    <p role="alert" className="text-2xs text-danger">
      {result.reason ?? 'Không gửi được tin nhắn.'}
    </p>
  );
}
