/**
 * commandResults: what the server said about a command we sent.
 *
 * Every company command answers with one of these, keyed by the requestId the
 * client minted. It is the only place a failure is visible, so the UI shows
 * the server's own code and message rather than a local guess -- and it is why
 * a failed prompt keeps its text instead of vanishing.
 */

import type { ServerMessage } from '../../../core/src/messages.js';

export interface CommandResultView {
  requestId: string;
  ok: boolean;
  errorCode?: string;
  message?: string;
  revision?: number;
}

export function viewCommandResult(
  message: Extract<ServerMessage, { type: 'companyCommandResult' }>,
): CommandResultView {
  return {
    requestId: message.requestId,
    ok: message.ok,
    errorCode: message.errorCode,
    message: message.message,
    revision: message.revision,
  };
}

/**
 * The notice for a command the board could not send or the server refused, or
 * null when it went through. The server's own message is shown before its code.
 */
export function failureNotice(
  outcome: Pick<CommandResultView, 'ok' | 'errorCode' | 'message'> | undefined,
  fallback: string,
): string | null {
  if (outcome === undefined || outcome.ok) return null;
  return outcome.message ?? outcome.errorCode ?? fallback;
}
