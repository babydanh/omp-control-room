/**
 * selection: the ONE selection the board and its detail pane share.
 *
 * A card click and a session row both end up here, so the two cannot disagree
 * about what is open. The rule that matters:
 *
 *  - A Contract is approved only through its plan panel, and only when that
 *    panel's presenter found no gap. The panel disables the button; this guard
 *    exists so no other path (a stale render, a keyboard shortcut, a scripted
 *    click) can send an approval the plan cannot justify.
 */

import type { Contract } from '../../../core/src/company.js';
import type { CompanySelection, CompanyViewState } from './companyState.js';
import type { ContractPlanView } from './contractPlanView.js';

/** Selection for a task card: its task, and the session running it if any. */
export function selectionForTask(state: CompanyViewState, taskId: string): CompanySelection {
  const sessionId = state.tasks[taskId]?.sessionId ?? null;
  return {
    taskId,
    sessionId,
    // A card is about the work, not about a transcript: open what it is doing.
    tab: sessionId === null ? null : 'log',
  };
}

/** Selection for a session row: the session and whatever it is working on. */
export function selectionForSession(state: CompanyViewState, sessionId: string): CompanySelection {
  return { taskId: state.sessions[sessionId]?.activeTaskId ?? null, sessionId, tab: null };
}

/** The contract waiting on the user's decision, if there is one. */
export function pendingContract(state: CompanyViewState): Contract | null {
  const awaiting = Object.values(state.contracts).filter(
    (contract) => contract.status === 'awaiting_approval',
  );
  if (awaiting.length === 0) return null;
  return awaiting.reduce((newest, contract) =>
    contract.revision > newest.revision ? contract : newest,
  );
}

/**
 * Whether an approval may be sent for this contract. The presenter found the
 * plan complete; the server re-validates the decision, but the client refuses
 * to send one it cannot justify.
 */
export function canSendContractApproval(contract: Contract, view: ContractPlanView): boolean {
  return contract.status === 'awaiting_approval' && view.canApprove;
}

/**
 * What the detail drawer shows. A board subject (a task or a session) comes
 * from the shared selection; the rest is something the user opened from the
 * board or the sidebar.
 */
export type DrawerSubject =
  | { kind: 'task'; taskId: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'herdr'; paneId: string }
  | { kind: 'contract' }
  | { kind: 'question'; questionId: string }
  | { kind: 'files' };

/** Something the user explicitly opened. A board subject is never opened this way. */
export type OpenedSubject = Exclude<DrawerSubject, { kind: 'task' } | { kind: 'session' }>;

/**
 * The subject the drawer shows: what the user opened wins; otherwise the
 * shared selection's task (when the server still has it), else its session.
 */
export function drawerSubjectFor(
  state: CompanyViewState,
  opened: OpenedSubject | null,
): DrawerSubject | null {
  if (opened !== null) return opened;
  const { taskId, sessionId } = state.selection;
  if (taskId !== null && state.tasks[taskId] !== undefined) return { kind: 'task', taskId };
  if (sessionId !== null && state.sessions[sessionId] !== undefined) {
    return { kind: 'session', sessionId };
  }
  return null;
}

/** A stable identity for a drawer subject, so a retained subject can be compared. */
export function drawerSubjectKey(subject: DrawerSubject): string {
  switch (subject.kind) {
    case 'task':
      return `task:${subject.taskId}`;
    case 'session':
      return `session:${subject.sessionId}`;
    case 'herdr':
      return `herdr:${subject.paneId}`;
    case 'question':
      return `question:${subject.questionId}`;
    case 'contract':
    case 'files':
      return subject.kind;
  }
}
