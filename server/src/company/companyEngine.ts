/**
 * companyEngine: the lifecycle transitions, as pure state -> events.
 *
 * Everything a Company run does to its durable state goes through this module,
 * and it returns `CompanyEvent`s rather than mutating anything. The caller
 * commits them through the store, so a half-applied lifecycle step is not
 * representable: the attempt, the task status change and the counters all land
 * in one journal record or none of them do.
 *
 * The rules it enforces are the ones the plan treats as non-negotiable:
 *  - The raw prompt is stored as an artifact; the snapshot keeps only a
 *    grapheme-safe preview, so a 2 MiB prompt never enters React or a model
 *    context by accident.
 *  - A Contract cannot be approved while its plan has a hole (cycle, empty
 *    acceptance, criterion mapping to nothing).
 *  - A task that is already running cannot be started again; attempts are
 *    appended, never replaced.
 *  - "Done" is earned from evidence: every required criterion needs a command
 *    that exited 0. Prose from a model is never sufficient.
 *  - Repairs are bounded, so a failing task cannot loop on a model forever.
 */

import { randomUUID } from 'node:crypto';

import type {
  AcceptanceCriterion,
  Attempt,
  CompanyChange,
  CompanyEvent,
  CompanyPrompt,
  CompanyState,
  Question,
  QuestionAnswerInput,
  SubmitPromptInput,
  Task,
  VerificationCommand,
  VerificationEvidence,
  WorkspaceChange,
} from '../../../core/src/company.js';
import type { TransitionAction } from './companyCoordinator.js';
import { CompanyError } from './companyError.js';
import type { VerificationVerdict } from './companyWorkflow.js';
import { evaluateVerification, nextAttemptOutcome, validateContract } from './companyWorkflow.js';
import { fragmentPrompt } from './promptIntake.js';

const PREVIEW_MAX_GRAPHEMES = 240;

export interface EngineEvent {
  /** Identifies the commit; its sequence is derived from the current state. */
  id: string;
}

export interface PromptSubmission {
  prompt: SubmitPromptInput;
  rawTextArtifactId: string;
  now: string;
}

export interface AttemptStart {
  taskId: string;
  sessionId: string;
  runEpoch: number;
  attemptId: string;
  now: string;
  newEvent: EngineEvent;
}

export interface AttemptOutcome {
  attemptId: string;
  criterionCommands: ReadonlyMap<string, readonly string[]>;
  evidence: readonly VerificationEvidence[];
  now: string;
  newEvent: EngineEvent;
}

export interface EngineResult {
  events: CompanyEvent[];
}

/** Grapheme-safe preview: a cut emoji must not leave a lone surrogate behind. */
export function buildPreview(text: string, limit = PREVIEW_MAX_GRAPHEMES): string {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let count = 0;
  let preview = '';
  for (const { segment } of segmenter.segment(text)) {
    if (count >= limit) break;
    preview += segment;
    count += 1;
  }
  return preview;
}

function event(
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

/**
 * Store one submitted prompt. The body lives in an artifact written before this
 * call; the event only references it.
 */
export function createPromptSubmission(
  state: CompanyState,
  submission: PromptSubmission,
): EngineResult {
  const id = randomUUID();
  const prompt: CompanyPrompt = {
    id,
    rawTextArtifactId: submission.rawTextArtifactId,
    preview: buildPreview(submission.prompt.text),
    createdAt: submission.now,
    fragments: fragmentPrompt(submission.prompt.text),
    ...(submission.prompt.attachments === undefined
      ? {}
      : { attachments: submission.prompt.attachments }),
    ...(submission.prompt.targetContractId === undefined
      ? {}
      : { targetContractId: submission.prompt.targetContractId }),
    ...(submission.prompt.targetSessionId === undefined
      ? {}
      : { targetSessionId: submission.prompt.targetSessionId }),
  };

  return {
    events: [
      event(state, randomUUID(), submission.now, [
        { entity: 'prompt', op: 'put', id, value: prompt },
      ]),
    ],
  };
}

/**
 * Approve a Contract revision. Runs the same validation the scheduler relies on
 * so the UI and the runtime can never disagree about what is approvable.
 */
export function approveContract(
  state: CompanyState,
  contractId: string,
  revision: number,
  now: string,
): EngineResult {
  const contract = state.contracts[contractId];
  if (!contract) {
    throw new CompanyError('contract_not_found', `Unknown contract: ${contractId}`);
  }
  if (contract.revision !== revision) {
    throw new CompanyError(
      'company_revision_conflict',
      `Contract ${contract.code} is at revision ${contract.revision}, not ${revision}.`,
    );
  }
  if (contract.status !== 'awaiting_approval') {
    throw new CompanyError(
      'contract_not_awaiting_approval',
      `Contract ${contract.code} is ${contract.status}, not awaiting approval.`,
    );
  }
  const validation = validateContract(contract);
  if (!validation.ok) {
    throw new CompanyError(
      'contract_invalid',
      `Hợp đồng ${contract.code} còn thiếu: ${validation.issues
        .map((issue) => issue.message)
        .join(' ')}`,
    );
  }

  const approved = { ...contract, status: 'approved' as const };
  return {
    events: [
      event(state, randomUUID(), now, [
        { entity: 'contract', op: 'put', id: contractId, value: approved },
      ]),
    ],
  };
}

/**
 * Begin an attempt. The attempt record and the task's new status are committed
 * together, and the task's attempt list only ever grows.
 */
export function startTaskAttempt(state: CompanyState, start: AttemptStart): EngineResult {
  const task = state.tasks[start.taskId];
  if (!task) {
    throw new CompanyError('task_not_found', `Unknown task: ${start.taskId}`);
  }
  if (task.status !== 'planned' && task.status !== 'ready') {
    throw new CompanyError('task_not_runnable', `Task ${task.code} is ${task.status}.`);
  }

  const attempt = {
    id: start.attemptId,
    taskId: task.id,
    sessionId: start.sessionId,
    runEpoch: start.runEpoch,
    startedAt: start.now,
    status: 'running' as const,
    changes: [],
    evidenceIds: [],
  };
  const updated: Task = {
    ...task,
    status: 'running',
    attemptIds: [...task.attemptIds, start.attemptId],
  };

  return {
    events: [
      event(state, start.newEvent.id, start.now, [
        { entity: 'attempt', op: 'put', id: start.attemptId, value: attempt },
        { entity: 'task', op: 'put', id: task.id, value: updated },
      ]),
    ],
  };
}

/**
 * Close an attempt from its evidence. Passing requires every required
 * criterion to have a successful command; failing either asks for one more
 * bounded repair or fails the task outright.
 */
export function recordAttemptOutcome(state: CompanyState, outcome: AttemptOutcome): EngineResult {
  const attempt = state.attempts[outcome.attemptId];
  if (!attempt) {
    throw new CompanyError('attempt_not_found', `Unknown attempt: ${outcome.attemptId}`);
  }
  const task = state.tasks[attempt.taskId];
  if (!task) {
    throw new CompanyError('task_not_found', `Unknown task: ${attempt.taskId}`);
  }
  const contract = state.contracts[task.contractId];
  const criteria: AcceptanceCriterion[] = contract
    ? contract.acceptance.filter((criterion) => task.acceptance.includes(criterion.id))
    : [];

  // No criterion means nothing can be proven, and an empty verdict would
  // vacuously "pass". Contract approval already rejects this shape; failing
  // closed here keeps a corrupted or hand-edited state from passing silently.
  if (criteria.length === 0) {
    throw new CompanyError(
      'task_has_no_acceptance',
      `Task ${task.code} has no acceptance criteria, so it cannot be verified.`,
    );
  }

  const verdict = evaluateVerification(criteria, outcome.criterionCommands, outcome.evidence);
  const priorAttempts = task.attemptIds.length;
  const nextStatus = verdict.passed
    ? ('done' as const)
    : nextAttemptOutcome(priorAttempts).status === 'failed'
      ? ('failed' as const)
      : ('changes_requested' as const);

  const closed = {
    ...attempt,
    endedAt: outcome.now,
    status: verdict.passed ? ('passed' as const) : ('failed' as const),
    evidenceIds: verdict.criteria.flatMap((entry) => entry.evidenceIds),
  };
  const updated: Task = { ...task, status: nextStatus };
  const evidenceChanges = outcome.evidence.map((evidence) => ({
    entity: 'evidence' as const,
    op: 'put' as const,
    id: evidence.id,
    value: evidence,
  }));

  return {
    events: [
      event(state, outcome.newEvent.id, outcome.now, [
        { entity: 'attempt', op: 'put', id: attempt.id, value: closed },
        ...evidenceChanges,
        { entity: 'task', op: 'put', id: task.id, value: updated },
      ]),
    ],
  };
}

// ── Delivery: Worker result, QA verdict, Judge verdict ───────────────────

export interface WorkerTaskResult {
  taskId: string;
  attemptId: string;
  sessionId: string;
  runEpoch: number;
  changes: readonly WorkspaceChange[];
  now: string;
  newEvent: EngineEvent;
}

export interface ReviewerVerdict {
  taskId: string;
  attemptId: string;
  sessionId: string;
  runEpoch: number;
  verdict: 'pass' | 'fail';
  evidenceIds: readonly string[];
  criterionIds: readonly string[];
  notes: readonly string[];
  now: string;
  newEvent: EngineEvent;
}

/** The acceptance criteria a task must satisfy, taken from its own Contract. */
export function taskAcceptanceCriteria(state: CompanyState, task: Task): AcceptanceCriterion[] {
  const contract = state.contracts[task.contractId];
  if (!contract) return [];
  return contract.acceptance.filter((criterion) => task.acceptance.includes(criterion.id));
}

/**
 * The commands a reviewer may run for a task, keyed by criterion.
 *
 * Only an approved VerificationProfile that claims one of THIS task's criteria
 * contributes, so another Contract's profile is not a shortcut around this
 * task's evidence.
 */
export function approvedCommandsByCriterion(
  state: CompanyState,
  task: Task,
): ReadonlyMap<string, readonly string[]> {
  const claims = new Set(task.acceptance);
  const commands = new Map<string, string[]>();
  for (const profile of Object.values(state.settings.verificationProfiles)) {
    const served = profile.criterionIds.filter((id) => claims.has(id));
    if (served.length === 0) continue;
    for (const criterionId of served) {
      const ids = commands.get(criterionId) ?? [];
      for (const command of profile.commands) {
        if (!ids.includes(command.id)) ids.push(command.id);
      }
      commands.set(criterionId, ids);
    }
  }
  return commands;
}

/** One approved command plus the criteria its evidence is allowed to serve. */
export function approvedVerificationCommand(
  state: CompanyState,
  task: Task,
  commandId: string,
): {
  command: VerificationCommand;
  criterionIds: string[];
  prerequisites: string[];
  profileId: string;
} | null {
  const claims = new Set(task.acceptance);
  for (const [profileId, profile] of Object.entries(state.settings.verificationProfiles)) {
    const criterionIds = profile.criterionIds.filter((id) => claims.has(id));
    if (criterionIds.length === 0) continue;
    const command = profile.commands.find((entry) => entry.id === commandId);
    if (!command) continue;
    return {
      command: command as VerificationCommand,
      criterionIds,
      prerequisites: [...profile.prerequisites],
      profileId,
    };
  }
  return null;
}

/**
 * The verdict an attempt's OWN evidence supports.
 *
 * Only evidence recorded against this attempt counts: a passing run from the
 * attempt before it cannot make this one look verified.
 */
export function evaluateTaskEvidence(
  state: CompanyState,
  task: Task,
  attempt: Attempt,
): VerificationVerdict {
  const criteria = taskAcceptanceCriteria(state, task);
  if (criteria.length === 0) {
    return {
      passed: false,
      criteria: [],
      issues: [`Task ${task.code} has no acceptance criteria, so it cannot be verified.`],
    };
  }
  const evidence: VerificationEvidence[] = [];
  for (const id of attempt.evidenceIds) {
    const entry = state.evidence[id];
    if (entry) evidence.push(entry as VerificationEvidence);
  }
  return evaluateVerification(criteria, approvedCommandsByCriterion(state, task), evidence);
}

/** A closed attempt can never be reopened, and a newer attempt always wins. */
function assertLiveAttempt(
  state: CompanyState,
  taskId: string,
  attemptId: string,
): { task: Task; attempt: Attempt } {
  const task = state.tasks[taskId];
  if (!task) throw new CompanyError('task_not_found', `Unknown task: ${taskId}`);
  const attempt = state.attempts[attemptId];
  if (!attempt) throw new CompanyError('attempt_not_found', `Unknown attempt: ${attemptId}`);
  if (attempt.taskId !== task.id) {
    throw new CompanyError(
      'attempt_task_mismatch',
      `Attempt ${attemptId} belongs to task ${attempt.taskId}, not ${task.id}.`,
    );
  }
  if (task.attemptIds[task.attemptIds.length - 1] !== attempt.id) {
    throw new CompanyError(
      'stale_task_attempt',
      `Attempt ${attemptId} is not the newest attempt of task ${task.code}.`,
    );
  }
  if (attempt.status !== 'running') {
    throw new CompanyError(
      'attempt_not_running',
      `Attempt ${attemptId} is ${attempt.status}, not running.`,
    );
  }
  return { task, attempt };
}

/**
 * Record what a Worker actually changed and hand the task to verification.
 *
 * The task moves to `verifying` in the same event as the attempt's change list,
 * so there is no window in which QA could review a task nobody has reported
 * work for, and a second report cannot land on top of the first.
 */
export function recordTaskResult(state: CompanyState, input: WorkerTaskResult): EngineResult {
  const { task, attempt } = assertLiveAttempt(state, input.taskId, input.attemptId);
  if (attempt.sessionId !== input.sessionId || attempt.runEpoch !== input.runEpoch) {
    throw new CompanyError(
      'stale_run_epoch',
      `Attempt ${attempt.id} belongs to session ${attempt.sessionId} at epoch ${attempt.runEpoch}, not ${input.sessionId} at ${input.runEpoch}.`,
    );
  }
  if (task.status !== 'running') {
    throw new CompanyError('task_not_running', `Task ${task.code} is ${task.status}, not running.`);
  }
  if (attempt.changes.length > 0) {
    throw new CompanyError(
      'task_result_already_recorded',
      `Attempt ${attempt.id} already reported a result.`,
    );
  }

  const reported: Attempt = { ...attempt, changes: input.changes.map((change) => ({ ...change })) };
  const verifying: Task = { ...task, status: 'verifying' };
  return {
    events: [
      event(state, input.newEvent.id, input.now, [
        { entity: 'attempt', op: 'put', id: attempt.id, value: reported },
        { entity: 'task', op: 'put', id: task.id, value: verifying },
      ]),
    ],
  };
}

function assertReviewerReferences(
  state: CompanyState,
  input: ReviewerVerdict,
  codes: { evidence: string; criterion: string },
  task: Task,
  attempt: Attempt,
): void {
  if (task.status !== 'verifying') {
    throw new CompanyError(
      'task_not_verifying',
      `Task ${task.code} is ${task.status}, not verifying.`,
    );
  }
  for (const evidenceId of input.evidenceIds) {
    if (!attempt.evidenceIds.includes(evidenceId) || !state.evidence[evidenceId]) {
      throw new CompanyError(
        codes.evidence,
        `Evidence ${evidenceId} was not recorded against attempt ${attempt.id}.`,
      );
    }
  }
  for (const criterionId of input.criterionIds) {
    if (!task.acceptance.includes(criterionId)) {
      throw new CompanyError(
        codes.criterion,
        `Criterion ${criterionId} is not part of task ${task.code}.`,
      );
    }
  }
}

/**
 * A `pass` is earned from the server's own evidence, never from the reviewer's
 * say-so: every required criterion needs a command that exited 0, and every
 * piece of evidence the reviewer cites has to be one of those runs.
 */
function assertPassingEvidence(
  state: CompanyState,
  task: Task,
  attempt: Attempt,
  input: ReviewerVerdict,
  code: string,
): void {
  const verdict = evaluateTaskEvidence(state, task, attempt);
  if (!verdict.passed) {
    throw new CompanyError(
      code,
      verdict.issues.length > 0
        ? verdict.issues.join(' ')
        : 'Không có tiêu chí nghiệm thu bắt buộc nào có bằng chứng đạt.',
    );
  }
  const failing = input.evidenceIds.filter((id) => state.evidence[id]?.exitCode !== 0);
  if (failing.length > 0) {
    throw new CompanyError(code, `Cited evidence did not exit 0: ${failing.join(', ')}.`);
  }
}

function verdictRecord(input: ReviewerVerdict): Record<string, unknown> {
  return {
    verdict: input.verdict,
    sessionId: input.sessionId,
    runEpoch: input.runEpoch,
    evidenceIds: [...input.evidenceIds],
    criterionIds: [...input.criterionIds],
    notes: [...input.notes],
    decidedAt: input.now,
  };
}

/**
 * Record QA's verdict.
 *
 * A pass leaves the attempt running and the task `verifying`: QA proves the
 * work, it does not close it. A failure closes the attempt and spends one of
 * the bounded repair cycles (or fails the task once they run out).
 */
export function recordQaVerdict(state: CompanyState, input: ReviewerVerdict): EngineResult {
  const codes = { evidence: 'qa_evidence_unknown', criterion: 'qa_criterion_unknown' };
  const { task, attempt } = assertLiveAttempt(state, input.taskId, input.attemptId);
  assertReviewerReferences(state, input, codes, task, attempt);
  if (attempt.qaVerdict) {
    throw new CompanyError(
      'qa_verdict_already_recorded',
      `Attempt ${attempt.id} already carries a QA verdict.`,
    );
  }

  const record = verdictRecord(input);
  const changes: CompanyChange[] = [];
  if (input.verdict === 'pass') {
    assertPassingEvidence(state, task, attempt, input, 'qa_evidence_incomplete');
    changes.push({
      entity: 'attempt',
      op: 'put',
      id: attempt.id,
      value: { ...attempt, qaVerdict: record },
    });
    return { events: [event(state, input.newEvent.id, input.now, changes)] };
  }

  changes.push({
    entity: 'attempt',
    op: 'put',
    id: attempt.id,
    value: { ...attempt, qaVerdict: record, status: 'failed', endedAt: input.now },
  });
  changes.push({
    entity: 'task',
    op: 'put',
    id: task.id,
    value: { ...task, status: nextAttemptOutcome(task.attemptIds.length).status },
  });
  return { events: [event(state, input.newEvent.id, input.now, changes)] };
}

/**
 * Record the Judge's verdict, the only transition that may mark a task `done`.
 *
 * It arrives after QA has passed and is judged against the same evidence, so
 * "the Judge said it is fine" can never substitute for a command that exited 0.
 */
export function recordJudgeVerdict(state: CompanyState, input: ReviewerVerdict): EngineResult {
  const codes = { evidence: 'judge_evidence_unknown', criterion: 'judge_criterion_unknown' };
  const { task, attempt } = assertLiveAttempt(state, input.taskId, input.attemptId);
  assertReviewerReferences(state, input, codes, task, attempt);
  if (!attempt.qaVerdict || attempt.qaVerdict['verdict'] !== 'pass') {
    throw new CompanyError(
      'judge_requires_qa_pass',
      `Task ${task.code} has no passing QA verdict on attempt ${attempt.id}.`,
    );
  }
  if (attempt.judgeVerdict) {
    throw new CompanyError(
      'judge_verdict_already_recorded',
      `Attempt ${attempt.id} already carries a Judge verdict.`,
    );
  }

  const record = verdictRecord(input);
  const changes: CompanyChange[] = [];
  if (input.verdict === 'pass') {
    assertPassingEvidence(state, task, attempt, input, 'judge_evidence_incomplete');
    changes.push({
      entity: 'attempt',
      op: 'put',
      id: attempt.id,
      value: { ...attempt, judgeVerdict: record, status: 'passed', endedAt: input.now },
    });
    changes.push({ entity: 'task', op: 'put', id: task.id, value: { ...task, status: 'done' } });
    return { events: [event(state, input.newEvent.id, input.now, changes)] };
  }

  changes.push({
    entity: 'attempt',
    op: 'put',
    id: attempt.id,
    value: { ...attempt, judgeVerdict: record, status: 'failed', endedAt: input.now },
  });
  changes.push({
    entity: 'task',
    op: 'put',
    id: task.id,
    value: { ...task, status: nextAttemptOutcome(task.attemptIds.length).status },
  });
  return { events: [event(state, input.newEvent.id, input.now, changes)] };
}

/**
 * Answer a pending question. Three things must line up before an answer is
 * accepted, and each one has bitten a real system before:
 *
  - the question must still be `pending` (one answer wins; a late second one is
    never merged),
  - the run epoch must match, so an approval queued before a restart cannot be
 *    applied to the new process, and
 *  - for an approval, the action digest must match, so "approve this exact
 *    edit" cannot become "approve whatever that call turns into".
 */
export function answerQuestion(
  state: CompanyState,
  input: QuestionAnswerInput & { now: string; newEvent: EngineEvent },
): EngineResult {
  const question = state.questions[input.questionId];
  if (!question) {
    throw new CompanyError('question_not_found', `Unknown question: ${input.questionId}`);
  }
  if (question.status !== 'pending') {
    throw new CompanyError(
      'question_not_pending',
      `Question ${question.id} is already ${question.status}.`,
    );
  }
  if (input.runEpoch !== question.runEpoch) {
    throw new CompanyError(
      'stale_run_epoch',
      `Question ${question.id} belongs to epoch ${question.runEpoch}, not ${input.runEpoch}.`,
    );
  }
  if (
    input.actionDigest !== undefined &&
    question.actionDigest !== undefined &&
    input.actionDigest !== question.actionDigest
  ) {
    throw new CompanyError(
      'approval_stale',
      'Phiếu duyệt này trỏ tới một hành động khác với hành động đang chờ.',
    );
  }

  const answered = {
    ...question,
    status: (input.decision === 'reject' ? 'rejected' : 'answered') as Question['status'],
    answer: {
      answers: input.answers,
      ...(input.decision === undefined ? {} : { decision: input.decision }),
      requestId: input.requestId,
    },
    resolvedAt: input.now,
  } as Question;

  return {
    events: [
      event(state, input.newEvent.id, input.now, [
        { entity: 'question', op: 'put', id: question.id, value: answered },
      ]),
    ],
  };
}

/**
 * Apply a lifecycle action to a managed session.
 *
 * Restart and kill bump the run epoch: everything queued against the previous
 * process (answers, approvals, terminal input) becomes invalid by construction
 * rather than by a check somewhere downstream. Archive frees a pool slot but keeps
 * the record, because the transcript and its evidence still matter.
 */
export function controlSession(
  state: CompanyState,
  sessionId: string,
  action: TransitionAction,
  runEpoch: number,
  now: string,
  newEvent: EngineEvent,
): EngineResult {
  const session = state.sessions[sessionId];
  if (!session) {
    throw new CompanyError('session_not_found', `Unknown session: ${sessionId}`);
  }
  if (session.runEpoch !== runEpoch) {
    throw new CompanyError(
      'stale_run_epoch',
      `Session ${session.code} is at epoch ${session.runEpoch}, not ${runEpoch}.`,
    );
  }

  const next: CompanyState['sessions'][string] = {
    ...session,
    ...(action === 'restart' || action === 'kill' ? { runEpoch: session.runEpoch + 1 } : {}),
    status: SESSION_STATUS_BY_ACTION[action],
  };

  return {
    events: [
      event(state, newEvent.id, now, [
        { entity: 'session', op: 'put', id: sessionId, value: next },
      ]),
    ],
  };
}

/**
 * Pause is cooperative: the session is `pausing` until the runtime confirms no
 * tool or child is still running, which is why the intermediate status exists.
 */
const SESSION_STATUS_BY_ACTION: Record<
  TransitionAction,
  CompanyState['sessions'][string]['status']
> = {
  pause: 'pausing',
  resume: 'starting',
  kill: 'stopping',
  restart: 'stopping',
  archive: 'archived',
};
