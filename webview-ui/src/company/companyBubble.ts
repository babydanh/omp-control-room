/**
 * companyBubble: what a company session says over its own head.
 *
 * The rules live here, apart from the component, because they are decisions
 * about company state rather than about pixels — and because the drawer tab a
 * bubble opens is the same `CompanyDrawerTab` the drawer itself uses.
 *
 * Priority is the whole point of this module:
 *
 *  1. A session BLOCKED on a pending clarification or approval says so, and it
 *     does not fade. A question that quietly disappeared is a question the user
 *     never answers and the company never finishes.
 *  2. A session that is TYPING shows the tail of its public assistant output —
 *     an excerpt, not a transcript. It fades a few seconds after the output
 *     stops, so a working office is not a wall of text.
 *  3. A session the user selected or hovered shows a panel with its role and
 *     status.
 *
 * What never appears here: thinking, tool arguments, credentials. The excerpt
 * comes from `streams[sessionId].excerpt`, which the server builds from public
 * assistant output. Nothing parses a terminal for text and nothing is scraped
 * out of ANSI — a bubble is a signpost to the drawer, not a second copy of it.
 */

import type { Question } from '../../../core/src/company.js';
import { companyRoleLabel } from './companyCharacters.js';
import type { CompanyDrawerTab, SessionView, TextStreamView } from './companyState.js';
import { sessionStatusLabel } from './statusLabels.js';

/** What a bubble is saying, and how loudly. */
export type CompanyBubbleTone = 'blocked' | 'approval' | 'output' | 'running' | 'idle';

export interface CompanyBubbleView {
  label: string;
  detail: string;
  tone: CompanyBubbleTone;
  /** Drawer tab this bubble opens when clicked. */
  tab: CompanyDrawerTab;
}

export const COMPANY_BUBBLE_TONE_COLOR: Record<CompanyBubbleTone, string> = {
  blocked: 'var(--color-warning)',
  approval: 'var(--color-warning)',
  output: 'var(--color-status-active)',
  running: 'var(--color-status-active)',
  idle: 'var(--color-text-muted)',
};

/**
 * The bubble for one session, or null when it has nothing to say.
 *
 * Pending input outranks output: a session waiting on an answer shows what it
 * is blocked on, not the last thing it typed before asking. Only an
 * UNANSWERED question blocks — the check lives here rather than at the call
 * site so a resolved question can never keep a permanent "waiting on you"
 * bubble over a character that has moved on.
 */
export function companyBubbleView(
  session: SessionView,
  stream: TextStreamView | undefined,
  question: Question | null,
  textVisible: boolean,
  showPanel: boolean,
): CompanyBubbleView | null {
  const label = companyRoleLabel(session.role);
  if (question?.status === 'pending') {
    return {
      label,
      detail: question.title,
      tone: question.kind === 'approval' ? 'approval' : 'blocked',
      tab: 'questions',
    };
  }
  const excerpt = textVisible ? (stream?.excerpt ?? '') : '';
  if (excerpt) return { label, detail: excerpt, tone: 'output', tab: 'terminal' };
  if (!showPanel) return null;
  return {
    label,
    detail: session.activeTaskId ?? sessionStatusLabel(session.status),
    tone:
      session.status === 'crashed'
        ? 'blocked'
        : session.status === 'busy' || session.status === 'starting'
          ? 'running'
          : 'idle',
    tab: 'terminal',
  };
}
