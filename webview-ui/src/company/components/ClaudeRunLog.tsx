/**
 * ClaudeRunLog: what a Claude Code run did, step by step, read from its own transcript. A run on
 * `claude -p` has no terminal and no board session, so this is the only window onto it. The log
 * reloads every few seconds while the run is going, then once more when it ends.
 */

import { useEffect } from 'react';

import type { CompanyClient } from '../companyClient.js';
import type { CompanyViewState } from '../companyState.js';
import { SessionActivityTab } from './SessionLog.js';

const RELOAD_MS = 5000;

export interface ClaudeRunLogProps {
  client: CompanyClient;
  state: CompanyViewState;
  /** The Claude Code session id of the run. */
  sessionId: string;
  running: boolean;
}

export function ClaudeRunLog({ client, state, sessionId, running }: ClaudeRunLogProps) {
  useEffect(() => {
    client.requestSessionLog(sessionId);
    if (!running) return undefined;
    const timer = setInterval(() => client.requestSessionLog(sessionId), RELOAD_MS);
    return () => clearInterval(timer);
  }, [client, sessionId, running]);

  return (
    <div data-testid="claude-run-log" className="mt-1 max-h-[60vh] overflow-y-auto">
      <SessionActivityTab state={state} sessionId={sessionId} taskId={null} live={false} onJump={() => {}} />
    </div>
  );
}
