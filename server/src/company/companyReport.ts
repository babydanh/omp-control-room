/**
 * companyReport: the run's result, assembled from evidence.
 *
 * The report is the only place the product states that work finished, so it is
 * built backwards from what was actually proven:
 *
 *  - A requirement is `satisfied` only when every task covering it is done AND
 *    every required acceptance criterion mapped to those tasks has a command
 *    that exited 0. A model saying "done" changes nothing here.
 *  - A requirement with no task at all is `blocked`, never `satisfied`.
 *  - Failing evidence makes the requirement `failed` even when the task status
 *    looks optimistic.
 *  - The related files come from attempts' recorded changes, not from prose.
 *
 * Everything it needs is already in `CompanyState`, so a report can be rebuilt
 * after a crash without a model having to remember anything.
 */

import type {
  AcceptanceCriterion,
  CompanyReport,
  CompanyState,
  Requirement,
  SessionLifecycleSummary,
  Task,
  UsageRecord,
  VerificationEvidence,
} from '../../../core/src/company.js';
import { CompanyError } from './companyError.js';
import { evaluateVerification } from './companyWorkflow.js';

export type RequirementOutcome = 'satisfied' | 'failed' | 'in_progress' | 'blocked';

type AttemptRecord = NonNullable<CompanyState['attempts'][string]>;
type ContractShape = Pick<CompanyState['contracts'][string], 'tasks' | 'acceptance'>;

/** Criteria declared by the given tasks, resolved against the Contract. */
function criteriaForTasks(
  contractCriteria: AcceptanceCriterion[],
  tasks: Task[],
): AcceptanceCriterion[] {
  const wanted = new Set(tasks.flatMap((task) => task.acceptance));
  return contractCriteria.filter((criterion) => wanted.has(criterion.id));
}

function evidenceForAttempts(
  state: CompanyState,
  tasks: Task[],
): { attempts: AttemptRecord[]; evidence: VerificationEvidence[]; evidenceIds: string[] } {
  const attempts = tasks
    .flatMap((task) => task.attemptIds.map((id) => state.attempts[id]))
    .filter((attempt): attempt is AttemptRecord => attempt !== undefined);
  const evidenceIds = [...new Set(attempts.flatMap((attempt) => attempt.evidenceIds))];
  const evidence = evidenceIds
    .map((id) => state.evidence[id])
    .filter((entry): entry is VerificationEvidence => entry !== undefined);
  return { attempts, evidence, evidenceIds };
}

export function buildCompanyReport(
  state: CompanyState,
  contractId: string,
  criterionCommands: ReadonlyMap<string, readonly string[]> = new Map(),
): CompanyReport {
  const contract = state.contracts[contractId];
  if (!contract) {
    throw new CompanyError('contract_not_found', `Unknown contract: ${contractId}`);
  }

  const requirements = contract.requirements.map((requirement) =>
    summariseRequirement(state, contract, requirement, criterionCommands),
  );

  const relatedChanges = new Map<string, CompanyReport['relatedChanges'][number]>();
  const evidenceIds = new Set<string>();
  const sessionIds = new Set<string>();

  for (const task of contract.tasks) {
    if (task.sessionId) sessionIds.add(task.sessionId);
    for (const attemptId of task.attemptIds) {
      const attempt = state.attempts[attemptId];
      if (!attempt) continue;
      for (const change of attempt.changes) {
        relatedChanges.set(`${change.kind}:${change.path}`, change);
      }
      for (const evidenceId of attempt.evidenceIds) evidenceIds.add(evidenceId);
    }
  }

  const sessions: SessionLifecycleSummary[] = [...sessionIds]
    .map((sessionId) => state.sessions[sessionId])
    .filter((session): session is NonNullable<typeof session> => session !== undefined)
    .map((session) => ({
      sessionId: session.id,
      role: session.role,
      requestedModel: session.requestedModel,
      ...(session.effectiveModel === undefined ? {} : { effectiveModel: session.effectiveModel }),
      runEpoch: session.runEpoch,
      status: session.status,
    }));

  const usage: UsageRecord[] = [...sessionIds].flatMap(
    (sessionId) => state.usageIndex[sessionId] ?? [],
  );

  return {
    contractId,
    revision: contract.revision,
    requirements,
    relatedChanges: [...relatedChanges.values()],
    verificationEvidenceIds: [...evidenceIds],
    advisorNotes: [],
    usage,
    sessions,
  };
}

function summariseRequirement(
  state: CompanyState,
  contract: ContractShape,
  requirement: Requirement,
  criterionCommands: ReadonlyMap<string, readonly string[]>,
): CompanyReport['requirements'][number] {
  const covering = contract.tasks.filter((task) => task.requirementIds.includes(requirement.id));
  const attemptIds = covering.flatMap((task) => task.attemptIds);
  const { attempts, evidence, evidenceIds } = evidenceForAttempts(state, covering);

  // "Nothing planned for it" is blocked, never satisfied.
  if (covering.length === 0) {
    return {
      requirementId: requirement.id,
      taskIds: [],
      attemptIds,
      evidenceIds,
      result: 'blocked',
    };
  }

  const criteria = criteriaForTasks(contract.acceptance, covering);
  const verdict = evaluateVerification(criteria, criterionCommands, evidence);
  const anyFailedAttempt = attempts.some((attempt) => attempt.status === 'failed');

  let result: RequirementOutcome;
  if ((criteria.some((criterion) => criterion.required) && !verdict.passed) || anyFailedAttempt) {
    result = 'failed';
  } else if (covering.every((task) => task.status === 'done')) {
    result = 'satisfied';
  } else {
    result = 'in_progress';
  }

  return {
    requirementId: requirement.id,
    taskIds: covering.map((task) => task.id),
    attemptIds,
    evidenceIds,
    result,
  };
}
