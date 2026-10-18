/**
 * promptTargets: where a line typed in the hover preview or the composer goes, and how
 * its send is reported. Pure: components read the board and call these; the client sends.
 *
 * A herdr agent takes the text straight into its pane. A live company session takes it as
 * a chat prompt on its own route. Neither send touches the composer's draft, so a preview
 * can send without disturbing what the user is writing below.
 */

import type { CompanySessionSummary, HerdrAgent } from '../../../core/src/company.js';
import type { HerdrSleepingSession } from '../../../core/src/messages.js';
import { type CommandResultView, failureNotice } from './commandResults.js';
import type { CompanyClient, CompanyCommandHandle } from './companyClient.js';
import { chatRoute } from './composerRouting.js';
import type { PromptRoute } from './promptSubmission.js';
import { terminalPolicy } from './sessionActions.js';
import type { PreviewTarget } from './terminalPreview.js';

/** Where a typed line goes. */
export type PromptTarget =
  | { readonly kind: 'herdr'; readonly paneId: string }
  | { readonly kind: 'session'; readonly route: PromptRoute };

/** What a preview row's input does right now. */
export type PreviewInput =
  | { readonly kind: 'none' }
  /** The row takes no input, for `reason`. `wakePane` names a sleeping pane that can be woken. */
  | { readonly kind: 'off'; readonly reason: string; readonly wakePane: string | null }
  /** `choices` is true when the agent waits on a choice, so the keys row is offered. */
  | { readonly kind: 'ready'; readonly target: PromptTarget; readonly choices: boolean };

export const UNPRIVILEGED_REASON = 'Kết nối này không được phép gửi lời nhắc.';
export const SLEEPING_REASON = 'Agent đang ngủ. Đánh thức để gửi lời nhắc.';
export const SEND_FAILED_FALLBACK = 'Không gửi được.';

/** The part of a session the routes read. */
type RouteView = Pick<CompanySessionSummary, 'id' | 'role' | 'status'>;

/** The board state the preview reads, plus whether this connection may send at all. */
export interface PromptView {
  readonly herdrAgents: readonly HerdrAgent[];
  readonly herdrSleeping: readonly HerdrSleepingSession[];
  readonly sessions: Readonly<Record<string, RouteView>>;
  readonly privileged: boolean;
}

/** The agent in herdr for a pane id, or null when none is selected or the agent is gone. */
export function herdrAgentFor(
  paneId: string | null,
  agents: readonly HerdrAgent[],
): HerdrAgent | null {
  if (paneId === null) return null;
  return agents.find((agent) => agent.paneId === paneId) ?? null;
}

const NO_INPUT: PreviewInput = { kind: 'none' };

function off(reason: string, wakePane: string | null): PreviewInput {
  return { kind: 'off', reason, wakePane };
}

/** What the hover preview's input does for `target`. */
export function previewInputOf(target: PreviewTarget, view: PromptView): PreviewInput {
  if (target.kind === 'herdr') {
    const agent = view.herdrAgents.find((candidate) => candidate.paneId === target.paneId);
    if (agent === undefined) {
      // A hibernated pane has no live agent; it can be woken, which is the only thing offered.
      const sleeping = view.herdrSleeping.some((pane) => pane.paneId === target.paneId);
      if (!sleeping) return NO_INPUT;
      if (!view.privileged) return off(UNPRIVILEGED_REASON, null);
      return off(SLEEPING_REASON, target.paneId);
    }
    if (!view.privileged) return off(UNPRIVILEGED_REASON, null);
    return {
      kind: 'ready',
      target: { kind: 'herdr', paneId: agent.paneId },
      choices: agent.status === 'blocked',
    };
  }
  const session = view.sessions[target.sessionId];
  if (session === undefined || !terminalPolicy(session.status).attach) return NO_INPUT;
  if (!view.privileged) return off(UNPRIVILEGED_REASON, null);
  return {
    kind: 'ready',
    target: { kind: 'session', route: chatRoute(session) },
    choices: false,
  };
}

/** The client calls a send goes through; a fake client need only provide these two. */
export type PromptSender = Pick<CompanyClient, 'herdrPrompt' | 'sendSessionPrompt'>;

/**
 * Sends `text` to `target`, trimmed. Returns null for an empty line: nothing is sent.
 * Otherwise returns the handle the verdict will be read from.
 */
export function sendPrompt(
  client: PromptSender,
  target: PromptTarget,
  text: string,
): CompanyCommandHandle | null {
  const line = text.trim();
  if (line === '') return null;
  return target.kind === 'herdr'
    ? client.herdrPrompt(target.paneId, line)
    : client.sendSessionPrompt(target.route, line);
}

/** A line sent from a surface, with the handle its send returned. */
export interface SentLine {
  readonly text: string;
  readonly handle: CompanyCommandHandle;
}

export type SendStatus =
  | { readonly kind: 'sending' }
  | { readonly kind: 'sent' }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * Where a sent line stands: refused at once, still waiting for the server's verdict, or
 * answered. The verdict is looked up by the handle's requestId in the command results.
 */
export function sendStatus(
  line: SentLine,
  results: Readonly<Record<string, CommandResultView | undefined>>,
): SendStatus {
  if (!line.handle.ok) {
    const refused = failureNotice(line.handle, SEND_FAILED_FALLBACK);
    return { kind: 'failed', message: refused ?? SEND_FAILED_FALLBACK };
  }
  const verdict = results[line.handle.requestId];
  if (verdict === undefined) return { kind: 'sending' };
  if (verdict.ok) return { kind: 'sent' };
  const rejected = failureNotice(verdict, SEND_FAILED_FALLBACK);
  return { kind: 'failed', message: rejected ?? SEND_FAILED_FALLBACK };
}

/**
 * The draft once a send of `sent` is confirmed: cleared when it still holds that text, and
 * left alone when the user has typed something else since.
 */
export function draftAfterSend(draft: string, sent: string): string {
  return draft.trim() === sent.trim() ? '' : draft;
}
