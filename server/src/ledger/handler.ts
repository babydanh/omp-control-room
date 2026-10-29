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
import { isOpenSpecFileName, listOpenSpecChanges, readOpenSpecFile } from './openSpecChanges.js';

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
    case 'ledgerOpenSpecRequest':
    case 'ledgerOpenSpecFileRequest':
    case 'ledgerTimelineRequest':
    case 'ledgerFileDiffRequest':
    case 'ledgerFileHistoryRequest':
    case 'ledgerCoordinationRequest':
    case 'ledgerToolUsageRequest':
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
    case 'ledgerOpenSpecRequest': {
      const view = await ledger.getView();
      const sources = view.repos.flatMap((repo) =>
        repo.worktrees.map((worktree) => ({
          repo: repo.repo,
          repoName: repo.name,
          worktree: worktree.path,
          worktreeName: worktree.name,
          branch: worktree.branch,
        })),
      );
      const changes = await listOpenSpecChanges(sources);
      send({ type: 'ledgerOpenSpecSnapshot', requestId, changes });
      return;
    }
    case 'ledgerOpenSpecFileRequest': {
      const worktree = typeof msg.worktree === 'string' ? msg.worktree : '';
      const changeId = typeof msg.changeId === 'string' ? msg.changeId : '';
      const file = isOpenSpecFileName(msg.file) ? msg.file : null;
      if (worktree === '' || changeId === '' || file === null) {
        send(commandResult(requestId, false, 'Yêu cầu mở tệp OpenSpec không hợp lệ.'));
        return;
      }
      const view = await ledger.getView();
      const tracked = view.repos.some((repo) => repo.worktrees.some((entry) => entry.path === worktree));
      if (!tracked) {
        send({
          type: 'ledgerOpenSpecFile',
          requestId,
          worktree,
          changeId,
          file,
          ok: false,
          content: '',
          reason: 'Worktree không còn được theo dõi.',
        });
        return;
      }
      const content = await readOpenSpecFile(worktree, changeId, file);
      send({
        type: 'ledgerOpenSpecFile',
        requestId,
        worktree,
        changeId,
        file,
        ok: content !== null,
        content: content ?? '',
        ...(content === null ? { reason: 'Không đọc được tệp OpenSpec.' } : {}),
      });
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
    case 'ledgerCoordinationRequest': {
      const result = await ledger.coordination(requestId);
      send(result);
      return;
    }
    case 'ledgerToolUsageRequest': {
      const result = await ledger.toolUsage(requestId, msg.refresh === true);
      send(result);
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
    case 'ledgerFileHistoryRequest': {
      const path = typeof msg.path === 'string' ? msg.path : '';
      if (path.length === 0) {
        send({
          type: 'ledgerFileHistory',
          requestId,
          path,
          entries: [],
          reason: 'Đường dẫn tệp không hợp lệ.',
        });
        return;
      }
      const outcome = await ledger.fileHistory(path);
      send({
        type: 'ledgerFileHistory',
        requestId,
        path,
        entries: outcome.entries,
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
