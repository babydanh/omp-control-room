/**
 * promptSubmission: the composer's draft, kept until the server accepts it.
 *
 * The one behaviour this exists to guarantee: a prompt the server REFUSED is
 * still the user's text. Submission is a two-step exchange -- send, then wait
 * for the `companyCommandResult` -- and the draft is cleared only when that
 * result says `ok`. A disconnect, a rejected prompt, a stale contract, an
 * unapproved decision: every one of them keeps what was typed, because in every
 * one of them the user's request never ran.
 *
 * Pure: the client applies these transitions while reducing server messages.
 */

import type { SubmitPromptInput } from '../../../core/src/company.js';
import type { CommandResultView } from './commandResults.js';
import { COMPANY_MAX_PROMPT_BYTES } from './constants.js';

export interface PromptError {
  requestId: string;
  errorCode: string;
  message?: string;
}

export interface PromptDraftState {
  text: string;
  /** The submit awaiting its result; null when nothing is in flight. */
  pendingSubmit: { requestId: string } | null;
  error: PromptError | null;
}

export const EMPTY_PROMPT_DRAFT: PromptDraftState = {
  text: '',
  pendingSubmit: null,
  error: null,
};

/**
 * Where a prompt goes. `chat` is omp's own conversation: it lands in the target
 * session, or opens a new chat session when there is none. `company` hands the
 * prompt to the Company workflow (Director, Contract, approval, workers).
 */
export interface PromptRoute {
  mode: 'chat' | 'company';
  delivery: SubmitPromptInput['delivery'];
  /** The session the prompt is for; null lets the server pick or open one. */
  targetSessionId: string | null;
}

export interface SubmitPlan {
  state: PromptDraftState;
  input: SubmitPromptInput;
}

/**
 * Build the message to send and mark the draft in flight. The text stays in the
 * draft until the result says otherwise.
 */
export function planSubmit(
  state: PromptDraftState,
  requestId: string,
  route: PromptRoute,
): SubmitPlan {
  return {
    state: {
      ...state,
      pendingSubmit: { requestId },
      error: null,
    },
    input: promptSubmitInput(requestId, state.text, route),
  };
}

/** The wire message for a prompt sent along a route, under the requestId that answers it. */
export function promptSubmitInput(
  requestId: string,
  text: string,
  route: PromptRoute,
): SubmitPromptInput {
  return {
    requestId,
    text,
    mode: route.mode,
    delivery: route.delivery,
    ...(route.targetSessionId === null ? {} : { targetSessionId: route.targetSessionId }),
  };
}

/**
 * Fold a command result into the draft. Only the result of the submit in flight
 * speaks for the draft: another command's answer (a folder switch, a herdr
 * prompt) leaves it alone. Only an `ok` clears the text.
 */
export function applySubmitResult(
  state: PromptDraftState,
  result: CommandResultView,
): PromptDraftState {
  if (state.pendingSubmit?.requestId !== result.requestId) return state;
  if (result.ok) {
    return { ...state, text: '', error: null, pendingSubmit: null };
  }
  return {
    ...state,
    pendingSubmit: null,
    error: {
      requestId: result.requestId,
      errorCode: result.errorCode ?? 'company_command_failed',
      message: result.message,
    },
  };
}

/**
 * Whether the draft can be sent right now. An over-budget prompt is refused
 * here with the same number the server would refuse it with, rather than after
 * a round trip.
 */
export function promptBlockReason(state: PromptDraftState): string | null {
  if (state.text.trim().length === 0) return 'Hãy nhập điều bạn muốn gửi.';
  if (new TextEncoder().encode(state.text).length > COMPANY_MAX_PROMPT_BYTES) {
    return `Nội dung yêu cầu vượt quá giới hạn ${COMPANY_MAX_PROMPT_BYTES} byte.`;
  }
  return null;
}

/** The keys a composer chord reads. */
export interface ChordEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/**
 * Ctrl/Cmd+Shift+Enter: send the prompt to the Company workflow. Bound to the
 * composer's own textarea, so a keypress typed into a terminal never reaches it.
 */
export function isCompanyChord(event: ChordEvent): boolean {
  return (event.ctrlKey || event.metaKey) && event.shiftKey && event.key === 'Enter';
}

/**
 * Ctrl/Cmd+Enter: a follow-up into the current session, as OMP's Ctrl+Enter
 * sends it. It never dispatches a slash command.
 */
export function isFollowUpChord(event: ChordEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key === 'Enter';
}
