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
    tab: sessionId === null ? null : 'activity',
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
