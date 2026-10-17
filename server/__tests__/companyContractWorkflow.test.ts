import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type {
  CompanyArchitectureIssue,
  CompanyArchitectureReview,
  CompanyEvent,
  CompanyState,
  Contract,
} from '../../core/src/company.js';
import { applyCompanyEvent, createInitialCompanyState } from '../src/company/companyState.js';
import { recordArchitectureReview } from '../src/company/contractWorkflow.js';

const CONTRACT_ID = randomUUID();
const PROMPT_ID = randomUUID();
const REQUIREMENT_ID = randomUUID();
const P1: CompanyArchitectureIssue = {
  severity: 'P1',
  requirementIds: [REQUIREMENT_ID],
  evidence: ['server/src/company/companyWorkflow.ts:159'],
  fix: 'Reject the proposed transition until every requirement has an evidence-backed task.',
};
const P2: CompanyArchitectureIssue = {
  severity: 'P2',
  requirementIds: [REQUIREMENT_ID],
  evidence: ['A read-only review identified a non-blocking naming mismatch.'],
  fix: 'Clarify the label in the Contract.',
};

function reviewState(reviews: CompanyArchitectureReview[] = [], revision = 2): CompanyState {
  const initial = createInitialCompanyState('C:/workspace');
  const contract: Contract = {
    id: CONTRACT_ID,
    code: 'PA-C0001',
    revision,
    promptIds: [PROMPT_ID],
    requirements: [
      {
        id: REQUIREMENT_ID,
        promptId: PROMPT_ID,
        fragmentIds: [randomUUID()],
        text: 'Implement the requested behavior.',
        kind: 'goal',
        status: 'planned',
      },
    ],
    phases: [],
    tasks: [],
    assumptions: [],
    decisions: [],
    acceptance: [],
    status: 'architecture_review',
    architectureReviews: reviews,
  };
  return { ...initial, contracts: { [CONTRACT_ID]: contract } };
}

function apply(state: CompanyState, events: CompanyEvent[]): CompanyState {
  return events.reduce(applyCompanyEvent, state);
}

function review(
  state: CompanyState,
  options: {
    verdict: 'approve' | 'changes_requested';
    issues: CompanyArchitectureIssue[];
    advisorNotes?: string[];
    revision?: number;
  },
): CompanyState {
  return apply(
    state,
    recordArchitectureReview(state, {
      contractId: CONTRACT_ID,
      revision: options.revision ?? 2,
      verdict: options.verdict,
      issues: options.issues,
      advisorNotes: options.advisorNotes ?? [],
      now: '2026-10-02T00:00:00.000Z',
      newEvent: { id: randomUUID() },
    }).events,
  );
}

describe('Contract architecture review gates', () => {
  it('refuses an Advisor approval that contains P0/P1 issues', () => {
    try {
      review(reviewState(), { verdict: 'approve', issues: [P1] });
      throw new Error('Expected the P1 review to be rejected.');
    } catch (error) {
      expect(error).toMatchObject({ code: 'contract_review_invalid' });
    }
  });

  it('returns blocking findings to the Director instead of exposing user approval', () => {
    const next = review(reviewState(), { verdict: 'changes_requested', issues: [P1] });
    const contract = next.contracts[CONTRACT_ID];

    expect(contract.status).toBe('architecture_review');
    expect(contract.architectureReviews).toEqual([
      {
        revision: 2,
        verdict: 'changes_requested',
        issues: [P1],
        advisorNotes: [],
        reviewedAt: '2026-10-02T00:00:00.000Z',
      },
    ]);
  });

  it('blocks after two failed revision cycles rather than looping indefinitely', () => {
    const previous: CompanyArchitectureReview[] = [
      {
        revision: 1,
        verdict: 'changes_requested',
        issues: [P1],
        advisorNotes: [],
        reviewedAt: '2026-10-01T00:00:00.000Z',
      },
      {
        revision: 2,
        verdict: 'changes_requested',
        issues: [P1],
        advisorNotes: [],
        reviewedAt: '2026-10-01T00:01:00.000Z',
      },
    ];

    const next = review(reviewState(previous, 3), {
      verdict: 'changes_requested',
      issues: [P1],
      revision: 3,
    });

    expect(next.contracts[CONTRACT_ID].status).toBe('blocked');
    expect(next.contracts[CONTRACT_ID].architectureReviews).toHaveLength(3);
  });

  it('records P2/P3 notes but still requires explicit user approval', () => {
    const next = review(reviewState(), {
      verdict: 'changes_requested',
      issues: [P2],
      advisorNotes: ['Use the existing pixel token for the new label.'],
    });

    expect(next.contracts[CONTRACT_ID].status).toBe('awaiting_approval');
    expect(next.contracts[CONTRACT_ID].architectureReviews?.[0]?.advisorNotes).toEqual([
      'Use the existing pixel token for the new label.',
    ]);
  });

  it('rejects an Advisor response for a stale Contract revision', () => {
    try {
      review(reviewState(), { verdict: 'approve', issues: [], revision: 1 });
      throw new Error('Expected the stale review to be rejected.');
    } catch (error) {
      expect(error).toMatchObject({ code: 'company_revision_conflict' });
    }
  });
});
