import type {
  CompanyArchitectureIssue,
  CompanyEvent,
  CompanyState,
  Contract,
} from '../../../core/src/company.js';
import { CompanyError } from './companyError.js';

export interface ArchitectureReviewInput {
  contractId: string;
  revision: number;
  verdict: 'approve' | 'changes_requested';
  issues: CompanyArchitectureIssue[];
  advisorNotes: string[];
  now: string;
  newEvent: { id: string };
}

export interface ContractWorkflowResult {
  events: CompanyEvent[];
}

/**
 * Persist one Advisor result and enforce the bounded architecture-review loop.
 * Critical findings return to the Director; minor findings remain visible while
 * the Contract waits for the user's explicit approval.
 */
export function recordArchitectureReview(
  state: CompanyState,
  input: ArchitectureReviewInput,
): ContractWorkflowResult {
  const contract = state.contracts[input.contractId];
  if (!contract) {
    throw new CompanyError('contract_not_found', `Unknown Contract: ${input.contractId}`);
  }
  if (contract.revision !== input.revision) {
    throw new CompanyError(
      'company_revision_conflict',
      `Contract ${contract.code} is at revision ${contract.revision}, not ${input.revision}.`,
    );
  }
  if (contract.status !== 'architecture_review') {
    throw new CompanyError(
      'contract_review_invalid',
      `Contract ${contract.code} is ${contract.status}, not in architecture review.`,
    );
  }

  validateReviewPayload(contract, input);

  const reviews = contract.architectureReviews ?? [];
  if (reviews.some((review) => review.revision === input.revision)) {
    throw new CompanyError(
      'contract_review_duplicate',
      `Contract ${contract.code} revision ${input.revision} already has an Advisor review.`,
    );
  }

  const blocking = input.issues.some((issue) => issue.severity === 'P0' || issue.severity === 'P1');
  const previousBlockingReviews = reviews.filter(
    (review) =>
      review.verdict === 'changes_requested' &&
      review.issues.some((issue) => issue.severity === 'P0' || issue.severity === 'P1'),
  ).length;
  const nextStatus: Contract['status'] = blocking
    ? previousBlockingReviews >= 2
      ? 'blocked'
      : 'architecture_review'
    : 'awaiting_approval';
  const updated: Contract = {
    ...contract,
    status: nextStatus,
    architectureReviews: [
      ...reviews,
      {
        revision: input.revision,
        verdict: input.verdict,
        issues: input.issues,
        advisorNotes: input.advisorNotes,
        reviewedAt: input.now,
      },
    ],
  };

  return {
    events: [
      makeEvent(state, input.newEvent.id, input.now, [
        { entity: 'contract', op: 'put', id: contract.id, value: updated },
      ]),
    ],
  };
}

function validateReviewPayload(contract: Contract, input: ArchitectureReviewInput): void {
  const requirementIds = new Set(contract.requirements.map((requirement) => requirement.id));
  for (const issue of input.issues) {
    if (
      issue.fix.trim().length === 0 ||
      issue.evidence.length === 0 ||
      issue.evidence.some((item) => item.trim().length === 0) ||
      issue.requirementIds.some((id) => !requirementIds.has(id))
    ) {
      throw new CompanyError(
        'contract_review_invalid',
        'Advisor issues require a fix, evidence, and only Contract requirement IDs.',
      );
    }
  }
  if (input.advisorNotes.some((note) => note.trim().length === 0)) {
    throw new CompanyError('contract_review_invalid', 'Advisor notes cannot be empty.');
  }
  const hasCriticalIssue = input.issues.some(
    (issue) => issue.severity === 'P0' || issue.severity === 'P1',
  );
  if (input.verdict === 'approve' && hasCriticalIssue) {
    throw new CompanyError(
      'contract_review_invalid',
      'An Advisor cannot approve a Contract with P0 or P1 findings.',
    );
  }
}

function makeEvent(
  state: CompanyState,
  id: string,
  at: string,
  changes: CompanyEvent['changes'],
): CompanyEvent {
  return {
    id,
    sequence: state.revision + 1,
    at,
    baseRevision: state.revision,
    changes,
  } as CompanyEvent;
}
