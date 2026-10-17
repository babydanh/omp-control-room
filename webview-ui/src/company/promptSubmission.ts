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
  delivery: SubmitPromptInput['delivery'];
  /** The submit awaiting its result; null when nothing is in flight. */
  pendingSubmit: { requestId: string } | null;
  error: PromptError | null;
}

export const EMPTY_PROMPT_DRAFT: PromptDraftState = {
  text: '',
  delivery: 'prompt',
  pendingSubmit: null,
  error: null,
};

export interface SubmitPlan {
  state: PromptDraftState;
  input: SubmitPromptInput;
}

/**
 * Build the message to send and mark the draft in flight. The text stays in the
 * draft until the result says otherwise. A selected session is the target: the
 * prompt goes to that OMP session the way typing into it would, and steering or
 * a follow-up is refused by the server without one.
 */
export function planSubmit(
  state: PromptDraftState,
  requestId: string,
  targetSessionId: string | null = null,
): SubmitPlan {
  const text = state.text;
  return {
    state: {
      ...state,
      pendingSubmit: { requestId },
      error: null,
    },
    input: {
      requestId,
      text,
      delivery: state.delivery,
      ...(targetSessionId === null ? {} : { targetSessionId }),
    },
  };
}

/** Fold a command result into the draft. Only an `ok` clears the text. */
export function applySubmitResult(
  state: PromptDraftState,
  result: CommandResultView,
): PromptDraftState {
  if (result.ok) {
    return { ...state, text: '', error: null, pendingSubmit: null };
  }
  return {
    ...state,
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
  if (state.text.trim().length === 0) return 'Hãy nhập điều bạn muốn công ty thực hiện.';
  if (new TextEncoder().encode(state.text).length > COMPANY_MAX_PROMPT_BYTES) {
    return `Nội dung yêu cầu vượt quá giới hạn ${COMPANY_MAX_PROMPT_BYTES} byte.`;
  }
  return null;
}

/**
 * The submit chord. It is bound to the composer's own textarea, so a keypress
 * typed into a terminal never reaches it; naming it here keeps that true by
 * construction rather than by accident.
 */
export function isSubmitChord(event: { key: string; ctrlKey: boolean; metaKey: boolean }): boolean {
  return (event.ctrlKey || event.metaKey) && event.key === 'Enter';
}
