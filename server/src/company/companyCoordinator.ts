/**
 * CompanyCoordinator: the typed contract every Company surface talks to.
 *
 * One coordinator exists per canonical workspace (see CompanyOwnership), and
 * both the standalone server and the VS Code extension resolve the same one.
 * It owns Contracts, the task DAG, the session pool, approvals, QA and usage.
 *
 * This file declares the contract only. Every method below has an owner
 * implementation in the workflow, runtime and reporting modules wired together
 * during composition; nothing here is a stub, and a surface that exposes a
 * Company route must be backed by these behaviors.
 *
 * Delivery notes the protocol layer depends on:
 *  - Destructive controls carry the caller's expected `runEpoch`, so a restart
 *    invalidates answers and controls queued for the previous epoch instead of
 *    letting them hit a new run.
 *  - `submitPrompt` accepts at most COMPANY_MAX_PROMPT_BYTES of UTF-8 and
 *    reports an overflow instead of truncating the user's request.
 *  - `snapshot()` is the hot/warm projection: no raw prompt bodies, no full
 *    historical reports, no live handles or PIDs.
 */

import type {
  Attempt,
  CompanyDiagnostics,
  CompanyPrompt,
  CompanySnapshot,
  QuestionAnswerInput,
  RoleProfile,
  SubmitPromptInput,
  Task,
} from '../../../core/src/company.js';

// ── Task delivery: Worker result, QA verification, QA and Judge verdicts ──

/** One changed path a Worker reports. Paths are workspace-relative. */
export interface WorkspaceChangeInput {
  path: string;
  kind: 'create' | 'modify' | 'delete';
  summary: string;
  /** Must already exist as a stored artifact when present. */
  diffArtifactId?: string;
}

export interface WorkerTaskResultInput {
  sessionId: string;
  runEpoch: number;
  taskId: string;
  attemptId: string;
  summary: string;
  changes: readonly WorkspaceChangeInput[];
}

export interface WorkerTaskResultOutput {
  taskId: string;
  attemptId: string;
  /** Always `verifying`: the task is now waiting on evidence. */
  taskStatus: 'verifying';
  changes: readonly WorkspaceChangeInput[];
  revision: number;
}

export interface VerificationRequest {
  sessionId: string;
  runEpoch: number;
  taskId: string;
  attemptId: string;
  /** Must name a command from the Contract's approved verification profile. */
  commandId: string;
}

export interface VerificationOutcome {
  taskId: string;
  attemptId: string;
  commandId: string;
  status: 'passed' | 'failed' | 'blocked';
  evidenceId: string;
  exitCode?: number;
  criterionIds: readonly string[];
  reason: string;
  /** Durable revision after the evidence was committed. */
  revision: number;
}

export type ReviewVerdict = 'pass' | 'fail';

export interface ReviewerResultInput {
  sessionId: string;
  runEpoch: number;
  taskId: string;
  attemptId: string;
  verdict: ReviewVerdict;
  criterionIds: readonly string[];
  evidenceIds: readonly string[];
  notes: readonly string[];
}

export interface ReviewerResultOutput {
  taskId: string;
  attemptId: string;
  verdict: ReviewVerdict;
  taskStatus: Task['status'];
  attemptStatus: Attempt['status'];
  revision: number;
}

/** Approval outcome a user can give for a proposed Contract revision. */
export const CONTRACT_DECISIONS = ['approve', 'reject'] as const;
export type ContractDecision = (typeof CONTRACT_DECISIONS)[number];

/** Lifecycle actions a user can apply to a managed company session. */
export const COMPANY_SESSION_ACTIONS = ['pause', 'resume', 'kill', 'restart', 'archive'] as const;
export type CompanySessionAction = (typeof COMPANY_SESSION_ACTIONS)[number];

export interface CompanyCoordinator {
  /** Ingest a user prompt, returning the stored prompt record. */
  submitPrompt(input: SubmitPromptInput): Promise<CompanyPrompt>;

  /** Approve or reject a specific Contract revision. */
  decideContract(
    id: string,
    revision: number,
    decision: ContractDecision,
    note?: string,
  ): Promise<void>;

  /** Answer a pending clarification, technical choice, or approval question. */
  answerQuestion(input: QuestionAnswerInput): Promise<void>;

  /**
   * Report what a Worker changed. Worker only, and only for the attempt that
   * session started at the given epoch. Every changed path must be relative,
   * canonical inside the workspace, covered by the task's write scopes and use
   * an operation the scope declares; a cited diff artifact must already be
   * stored. On success the task becomes `verifying` so QA can review it.
   */
  submitTaskResult(input: WorkerTaskResultInput): Promise<WorkerTaskResultOutput>;

  /**
   * Run one command from the Contract's approved verification profile and
   * record its evidence. QA only, bound to the live attempt and epoch. The
   * command's output artifacts are stored before the evidence that cites them,
   * and a cancelled run commits nothing.
   */
  verifyTask(input: VerificationRequest): Promise<VerificationOutcome>;

  /**
   * Record QA's verdict. A `pass` requires passing evidence, persisted against
   * this attempt, for every required acceptance criterion; a `fail` spends one
   * bounded repair cycle, or fails the task once they run out.
   */
  submitQaResult(input: ReviewerResultInput): Promise<ReviewerResultOutput>;

  /**
   * Record the Judge's verdict. Judge only, after QA has passed, judged against
   * the same server-verified evidence. Only a `pass` marks the task `done`.
   */
  submitJudgeResult(input: ReviewerResultInput): Promise<ReviewerResultOutput>;

  /**
   * Apply a lifecycle action to a managed session. `runEpoch` is the epoch the
   * client believes is live; a mismatch is rejected rather than applied.
   */
  controlSession(id: string, action: CompanySessionAction, runEpoch: number): Promise<void>;

  /**
   * Replace the per-role model profiles. Applied to the next dispatch or to an
   * idle session, never switched mid-tool.
   */
  updateSettings(roleProfiles: Record<string, RoleProfile>): Promise<void>;

  /** Hot/warm projection of the company, safe to send to an authorized client. */
  snapshot(): CompanySnapshot;

  /** Resource measurements for the diagnostics panel. */
  diagnostics(): CompanyDiagnostics;

  /** Stop scheduling, quiesce owned runs, flush the store, release ownership. */
  dispose(): Promise<void>;
}
