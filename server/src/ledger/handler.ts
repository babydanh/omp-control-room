/**
 * Client-message dispatch for the ledger board. Every ledger request needs a
 * privileged connection: the board shows session intents, file paths and
 * notices, which a tokenless read-only connection must not see.
 */

import type { ServerMessage } from '../../../core/src/messages.js';
import {
  LEDGER_REASON_BAD_WINDOW,
  LEDGER_REASON_COMMAND_FAILED,
  LEDGER_REASON_READ_ONLY,
  LEDGER_REASON_UNAVAILABLE,
  LEDGER_TIMELINE_WINDOWS,
} from './constants.js';
import type { LedgerService } from './ledgerService.js';

/** Used when a request arrives without a usable requestId, so the reply still parses. */
const FALLBACK_REQUEST_ID = '00000000-0000-4000-8000-000000000000';

export interface LedgerCommandContext {
  /** Null when the ledger is not wired for this host. */
  readonly ledger: LedgerService | null;
  readonly privileged: boolean;
}

/**
 * Handles one ledger request. Returns false, without replying, when `msg` is not a
 * ledger request, so the caller can try its other handlers.
 */
export function handleLedgerMessage(
  msg: Record<string, unknown>,
  send: (message: ServerMessage) => void,
  context: LedgerCommandContext,
): boolean {
  switch (msg.type) {
    case 'ledgerViewRequest':
    case 'ledgerTimelineRequest':
    case 'ledgerFileDiffRequest':
    case 'ledgerSendMessage':
      break;
    default:
      return false;
  }
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : FALLBACK_REQUEST_ID;

  if (!context.privileged) {
    send(commandResult(requestId, false, LEDGER_REASON_READ_ONLY));
    return true;
  }
  if (context.ledger === null) {
    send(commandResult(requestId, false, LEDGER_REASON_UNAVAILABLE));
    return true;
  }

  const ledger = context.ledger;
  runLedgerRequest(msg, requestId, ledger, send).catch((error: unknown) => {
    console.error('[ledger] request failed', msg.type, error);
    send(commandResult(requestId, false, LEDGER_REASON_COMMAND_FAILED));
  });
  return true;
}

async function runLedgerRequest(
  msg: Record<string, unknown>,
  requestId: string,
  ledger: LedgerService,
  send: (message: ServerMessage) => void,
): Promise<void> {
  switch (msg.type) {
    case 'ledgerViewRequest': {
      const view = await ledger.getView();
      send({ type: 'ledgerSnapshot', requestId, view });
      return;
    }
    case 'ledgerTimelineRequest': {
      const windowMinutes = msg.windowMinutes;
      if (typeof windowMinutes !== 'number' || !LEDGER_TIMELINE_WINDOWS.includes(windowMinutes)) {
        send(commandResult(requestId, false, LEDGER_REASON_BAD_WINDOW));
        return;
      }
      const timeline = await ledger.timeline(windowMinutes);
      send({ type: 'ledgerTimeline', requestId, timeline });
      return;
    }
    case 'ledgerFileDiffRequest': {
      const worktree = typeof msg.worktree === 'string' ? msg.worktree : '';
      const path = typeof msg.path === 'string' ? msg.path : '';
      const outcome = await ledger.fileDiff(worktree, path);
      send({
        type: 'ledgerFileDiff',
        requestId,
        ok: outcome.ok,
        worktree,
        path,
        diff: outcome.diff,
        truncated: outcome.truncated,
        reason: outcome.reason,
      });
      return;
    }
    case 'ledgerSendMessage': {
      const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : '';
      const text = typeof msg.text === 'string' ? msg.text : '';
      const outcome = await ledger.sendMessage(sessionId, text);
      send({
        type: 'ledgerCommandResult',
        requestId,
        ok: outcome.ok,
        reason: outcome.reason,
        delivered: outcome.delivered,
      });
      return;
    }
    default:
      return;
  }
}

function commandResult(requestId: string, ok: boolean, reason: string): ServerMessage {
  return { type: 'ledgerCommandResult', requestId, ok, reason };
}
