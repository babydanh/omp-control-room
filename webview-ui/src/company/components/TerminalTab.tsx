/**
 * TerminalTab: the session's live terminal, attached only while the session's
 * status says a process is there to attach to.
 *
 * A terminal stays attached only while this tab is mounted, so a session nobody
 * is looking at keeps no lease. A parked or stopped session shows why there is
 * no terminal and, where the server accepts it, offers to resume.
 */

import { useCallback, useEffect } from 'react';

import type { CompanyClient } from '../companyClient.js';
import type { CompanyViewState } from '../companyState.js';
import { terminalPolicy } from '../sessionActions.js';
import { CompanyButton } from './CompanyButton.js';
import { TerminalConsole } from './TerminalConsole.js';

export interface TerminalTabProps {
  client: CompanyClient;
  state: CompanyViewState;
  sessionId: string;
}

export function TerminalTab({ client, state, sessionId }: TerminalTabProps) {
  const session = state.sessions[sessionId];
  const policy = terminalPolicy(session?.status ?? '');
  // The epoch the terminal is attached to; null while there is no process to
  // attach to. A status change that keeps the same process keeps the lease.
  const liveEpoch = policy.attach && session !== undefined ? session.runEpoch : null;
  const runEpoch = session?.runEpoch;

  useEffect(() => {
    if (liveEpoch === null) return undefined;
    client.attachTerminal(sessionId);
    return () => {
      client.detachTerminal(sessionId);
    };
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
    />
  );
}
