/**
 * ContractPanel: the plan the user reads before approving, wired to the wire.
 *
 * The explanation itself is `ContractPlanPanel` -- the presenter that knows what
 * a Contract covers and refuses to say "approve" when it does not. This
 * wrapper adds exactly two things: the evidence and verification commands the
 * company actually holds, and the decision round trip.
 *
 * The approve callback re-checks `canSendContractApproval` before sending. The
 * panel already disables its button; this is the second line, for the paths
 * that do not go through the button at all.
 */

import type {
  Contract,
  VerificationEvidence,
  VerificationProfile,
} from '../../../../core/src/company.js';
import { buildContractPlanView } from '../contractPlanView.js';
import { canSendContractApproval } from '../selection.js';
import { commandsByCriterion } from '../verificationView.js';
import { ContractPlanPanel } from './ContractPlanPanel.js';

export interface ContractPanelProps {
  contract: Contract;
  verificationProfiles: Record<string, VerificationProfile>;
  evidence: readonly VerificationEvidence[];
  onApprove?: (revision: number) => void;
  onReject?: (revision: number) => void;
}

export function ContractPanel({
  contract,
  verificationProfiles,
  evidence,
  onApprove,
  onReject,
}: ContractPanelProps) {
  const criteria = commandsByCriterion(verificationProfiles);
  const view = buildContractPlanView(contract, criteria, evidence);

  return (
    <ContractPlanPanel
      contract={contract}
      commandsByCriterion={criteria}
      evidence={evidence}
      onApprove={
        onApprove === undefined
          ? undefined
          : (revision) => {
              if (!canSendContractApproval(contract, view)) return;
              onApprove(revision);
            }
      }
      onReject={onReject}
    />
  );
}
