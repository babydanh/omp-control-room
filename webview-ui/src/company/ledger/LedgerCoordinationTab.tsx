import { useEffect, useMemo, useState } from 'react';

import { ledgerStore } from './ledgerClient.js';
import { formatLedgerStamp } from './ledgerFormat.js';
import type { LedgerState } from './ledgerStore.js';

export function LedgerCoordinationTab({ ledger }: { ledger: LedgerState }) {
  const [session, setSession] = useState('');
  useEffect(() => {
    ledgerStore.requestCoordination();
    const timer = window.setInterval(() => ledgerStore.requestCoordination(), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  const messages = useMemo(() => ledger.coordination?.messages ?? [], [ledger.coordination]);
  // Every session that sent or received a message, with the label the list shows for it.
  const sessions = useMemo(() => {
    const labels = new Map<string, string>();
    for (const message of messages) {
      if (message.fromSession !== null) {
        labels.set(
          message.fromSession,
          sessionLabel(message.fromSession, message.fromKind, message.fromCwd),
        );
      }
      labels.set(message.toSession, sessionLabel(message.toSession, message.toKind, message.toCwd));
    }
    return [...labels].sort((a, b) => a[1].localeCompare(b[1]));
  }, [messages]);
  const filtered = messages.filter(
    (message) => session === '' || message.fromSession === session || message.toSession === session,
  );
  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-lg border border-border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-text">Tin nhắn giữa agent</h3>
          <label className="text-xs text-text-muted">
            Lọc phiên
            <select
              className="ml-2 rounded border border-border bg-panel px-2 py-1"
              value={session}
              onChange={(event) => setSession(event.target.value)}
            >
              <option value="">Tất cả phiên</option>
              {sessions.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="company-btn company-btn-sm company-btn-ghost"
            onClick={() => ledgerStore.requestCoordination()}
          >
            Làm mới
          </button>
        </div>
        {filtered.length === 0 ? (
          <p className="mt-3 text-sm text-text-muted">Chưa có tin nhắn trong 7 ngày gần đây.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {filtered.map((message) => (
              <li key={message.id} className="rounded bg-raised p-2 text-sm">
                <div className="flex flex-wrap gap-x-2 text-xs text-text-muted">
                  <time>{formatLedgerStamp(message.ts)}</time>
                  <span>
                    {sessionLabel(message.fromSession, message.fromKind, message.fromCwd)} →{' '}
                    {sessionLabel(message.toSession, message.toKind, message.toCwd)}
                  </span>
                  <span>{message.delivered ? 'Đã giao' : 'Chưa giao'}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap break-words text-text">{message.content}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="rounded-lg border border-border p-3">
        <h3 className="text-sm font-semibold text-text">File bàn giao</h3>
        {(ledger.coordination?.handoffs.length ?? 0) === 0 ? (
          <p className="mt-3 text-sm text-text-muted">
            Không tìm thấy file bàn giao trong các worktree đang theo dõi.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {ledger.coordination!.handoffs.map((handoff) => (
              <li
                key={`${handoff.worktree}:${handoff.path}`}
                className="rounded bg-raised p-2 text-sm"
              >
                <div className="flex flex-wrap justify-between gap-2">
                  <strong>{handoff.worktree}</strong>
                  <time className="text-xs text-text-muted">
                    {formatLedgerStamp(handoff.modifiedAt)}
                  </time>
                </div>
                <div className="text-xs text-text-muted">
                  {handoff.branch ?? 'Không rõ nhánh'} · {handoff.path}
                </div>
                {handoff.goal && (
                  <p className="mt-2">
                    <b>Mục tiêu:</b> {handoff.goal}
                  </p>
                )}
                {handoff.status && (
                  <p>
                    <b>Trạng thái:</b> {handoff.status}
                  </p>
                )}
                {handoff.openQuestions && (
                  <p>
                    <b>Câu hỏi còn mở:</b> {handoff.openQuestions}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function sessionLabel(id: string | null, kind: string | null, cwd: string | null): string {
  if (id === null || id === 'user') return 'người dùng';
  const cli = kind === 'claude' || kind === 'agy' ? kind : 'omp';
  const folder = cwd?.split(/[\\/]/).filter(Boolean).at(-1);
  return `${cli} ${id.slice(-8)}${folder ? ` (${folder})` : ''}`;
}
