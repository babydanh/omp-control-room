/**
 * TerminalTab: the session's live terminal, attached only while the session's
 * status says a process is there to attach to.
 *
 * A terminal stays attached only while this tab or a hover preview holds it, so a
 * session nobody is looking at keeps no lease. A parked or stopped session shows
 * why there is no terminal and, where the server accepts it, offers to resume.
 */

import { useCallback, useEffect, useState } from 'react';

import type { CompanyClient } from '../companyClient.js';
import type { CompanyViewState } from '../companyState.js';
import { terminalPolicy } from '../sessionActions.js';
import { CompanyButton } from './CompanyButton.js';
import { TerminalConsole, type TerminalJump } from './TerminalConsole.js';

export interface TerminalTabProps {
  client: CompanyClient;
  state: CompanyViewState;
  sessionId: string;
  /** A command the Lệnh tab asked to find; null when none is pending. */
  jump: TerminalJump | null;
}

export function TerminalTab({ client, state, sessionId, jump }: TerminalTabProps) {
  const session = state.sessions[sessionId];
  const policy = terminalPolicy(session?.status ?? '');
  // The epoch the terminal is attached to; null while there is no process to
  // attach to. A status change that keeps the same process keeps the lease.
  const liveEpoch = policy.attach && session !== undefined ? session.runEpoch : null;
  const runEpoch = session?.runEpoch;
  /** The jump request the console could not find in its buffer. */
  const [missedSeq, setMissedSeq] = useState<number | null>(null);

  useEffect(() => {
    if (liveEpoch === null) return undefined;
    return client.holdTerminal(sessionId, 'drawer');
  }, [client, sessionId, liveEpoch]);

  const onInput = useCallback(
    (data: string) => {
      if (runEpoch !== undefined) client.writeTerminal(sessionId, runEpoch, data);
    },
    [client, sessionId, runEpoch],
  );
  const onResize = useCallback(
    (cols: number, rows: number) => {
      if (runEpoch !== undefined) client.resizeTerminal(sessionId, runEpoch, cols, rows);
    },
    [client, sessionId, runEpoch],
  );
  const onOverflow = useCallback(() => client.attachTerminal(sessionId), [client, sessionId]);
  const onJumpMissed = useCallback((seq: number) => setMissedSeq(seq), []);

  if (session === undefined || !policy.attach) {
    return (
      <div className="flex flex-col gap-2 p-2">
        <p className="text-2xs text-text-muted">
          {policy.message ?? 'Phiên đó không còn thuộc công ty nữa.'}
        </p>
        {policy.resume && (
          <CompanyButton size="sm" onClick={() => client.controlSession(sessionId, 'resume')}>
            Tiếp tục
          </CompanyButton>
        )}
      </div>
    );
  }

  const terminal = state.terminals[sessionId];
  return (
    <div className="flex h-full min-h-0 flex-col">
      {jump !== null && missedSeq === jump.seq && <JumpMissNote output={jump.output} />}
      <div className="min-h-0 flex-1">
        <TerminalConsole
          sessionId={sessionId}
          attached={terminal?.attached ?? false}
          runEpoch={session.runEpoch}
          frames={terminal?.frames ?? []}
          overflow={terminal?.overflow ?? false}
          closedReason={terminal?.closedReason ?? null}
          onInput={onInput}
          onResize={onResize}
          onOverflow={onOverflow}
          jump={jump}
          onJumpMissed={onJumpMissed}
        />
      </div>
    </div>
  );
}

/** Shown when the jumped command has scrolled out of the terminal's buffer. */
function JumpMissNote({ output }: { output: string | null }) {
  return (
    <div className="shrink-0 border-b border-border px-3 py-2 text-2xs text-text-muted">
      <p>Lệnh này không còn trong bộ đệm terminal.</p>
      {output ? (
        <pre className="mt-1 max-h-40 overflow-auto font-mono whitespace-pre-wrap">{output}</pre>
      ) : (
        <p className="mt-1">Nhật ký không có kết quả của lệnh này.</p>
      )}
    </div>
  );
}
