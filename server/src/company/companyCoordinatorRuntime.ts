import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

import type {
  Attempt,
  CompanyArchitectureIssue,
  CompanyChange,
  CompanyDiagnostics,
  CompanyEvent,
  CompanyModelCatalogEntry,
  CompanyPrompt,
  CompanyRole,
  CompanySession,
  CompanySnapshot,
  CompanyState,
  Contract,
  Question,
  QuestionAnswerInput,
  RoleProfile,
  SubmitPromptInput,
  Task,
  VerificationProfile,
  WorkspaceChange,
  WriteScope,
} from '../../../core/src/company.js';
import type {
  CompanyCoordinator,
  CompanySessionAction,
  ContractDecision,
  OmpSessionListing,
  ReviewerResultInput,
  ReviewerResultOutput,
  TransitionAction,
  VerificationOutcome,
  VerificationRequest,
  WorkerTaskResultInput,
  WorkerTaskResultOutput,
  WorkspaceChangeInput,
} from './companyCoordinator.js';
import { COMPANY_SESSION_NAME_MAX_LENGTH } from './companyCoordinator.js';
import {
  answerQuestion as answerQuestionTransition,
  approveContract,
  approvedVerificationCommand,
  controlSession as controlSessionTransition,
  createPromptSubmission,
  recordJudgeVerdict,
  recordQaVerdict,
  recordTaskResult,
} from './companyEngine.js';
import { CompanyError } from './companyError.js';
import type { CompanyOwnership } from './companyOwnership.js';
import { applyCompanyEvent } from './companyState.js';
import type { CompanyStore } from './companyStore.js';
import { COMPANY_MAX_PROMPT_BYTES, COMPANY_PROMPT_TEXT_MEDIA_TYPE } from './constants.js';
import { type ContractDraftProposal, createContractDraft } from './contractDraft.js';
import { recordArchitectureReview as recordArchitectureReviewTransition } from './contractWorkflow.js';
import { canonicalWithinFolder, resolveFolderCwd } from './folderScope.js';
import { SESSION_ACTION_LABELS, SESSION_STATUS_LABELS } from './labels.js';
import {
  assertOmpSessionFileIn,
  comparableOmpPath,
  listOmpSessionFiles,
  ompSessionDirForFolder,
  readOmpSessionCwd,
} from './ompSessionFiles.js';
import { resolveWorkspaceTarget } from './permissionPolicy.js';
import type { UsageLedger } from './usageService.js';
import { type PrerequisiteCheck, runVerificationCommand } from './verificationRunner.js';
import { listFolderRepos } from './workItems/folderRepos.js';

const REQUIRED_ROLES = ['director', 'advisor', 'worker', 'qa', 'judge', 'chat'] as const;
const ROLE_TOOL_POLICIES: Record<(typeof REQUIRED_ROLES)[number], RoleProfile['toolsPolicy']> = {
  director: 'read-only',
  advisor: 'read-only',
  worker: 'scoped-write',
  qa: 'verification-only',
  judge: 'read-only',
  chat: 'omp',
};
const CONTEXT_NUMBER_FIELDS = new Set([
  'contextTokens',
  'maxContextTokens',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'remainingTokens',
  'compactionEpoch',
]);

/** Actions that end or release a run, and so need proven ownership first. */
const OWNERSHIP_GATED_ACTIONS: ReadonlySet<CompanySessionAction> = new Set([
  'restart',
  'kill',
  'archive',
]);

/** Session statuses that hold a live turn; only an interrupt may end one. */
const INTERRUPTIBLE_STATUSES: Partial<Record<CompanySession['status'], true>> = {
  busy: true,
  waiting_input: true,
};
/** Statuses in which a session holds no live process; resume or restart reopens it on its own omp file. */
const REOPENABLE_STATUSES: Partial<Record<CompanySession['status'], true>> = {
  parked: true,
  stopped: true,
  crashed: true,
};
/** Refusal for a parked or ended chat session whose record never learned its omp file. */
export const CHAT_REOPEN_WITHOUT_FILE_MESSAGE =
  'Phiên chat này chưa có file phiên OMP nên không thể mở lại.';
/** What one resume of an OMP file does, decided under the write queue. */
type OmpResumeTarget =
  | { readonly kind: 'focus'; readonly sessionId: string }
  | { readonly kind: 'open' }
  | {
      readonly kind: 'reopen';
      readonly sessionId: string;
      readonly action: 'resume' | 'restart';
      readonly runEpoch: number;
    };

/** Statuses in which a session is starting, running or winding down; it cannot be deleted yet. */
const DELETE_BLOCKING_STATUSES: Partial<Record<CompanySession['status'], true>> = {
  starting: true,
  busy: true,
  waiting_input: true,
  pausing: true,
  stopping: true,
};
/** Task states that release their session; any other state still holds the session's work. */
const RELEASED_TASK_STATUSES: Partial<Record<Task['status'], true>> = {
  done: true,
  failed: true,
  cancelled: true,
};
/** Contract states that no longer keep their prompts' sessions in use. */
const CLOSED_CONTRACT_STATUSES: Partial<Record<Contract['status'], true>> = {
  completed: true,
  cancelled: true,
};

/**
 * Why the host could not prove it still owns a run.
 *
 *  - `unproven`: ownership cannot be established at all.
 *  - `conflict`: the live run belongs to somebody else.
 *  - `gone`: there is no run left to own.
 */
export const OWNERSHIP_VERDICTS = ['unproven', 'conflict', 'gone'] as const;
export type OwnershipVerdict = (typeof OWNERSHIP_VERDICTS)[number];

/**
 * The host's proof that it still owns the live native run failed.
 *
 * This is the discriminator the coordinator branches on, never a code string:
 * a refusal has to be recognisable as a REFUSAL, because a refused control
 * must not be recorded as a crash. A crash says "the run died"; this says "we
 * never proved the run was ours to touch", which is a different fact with a
 * different remedy.
 */
export class CompanyOwnershipError extends CompanyError {
  readonly verdict: OwnershipVerdict;

  constructor(verdict: OwnershipVerdict, message: string, options?: ErrorOptions) {
    // `gone` is reported as `unproven`: a run that no longer exists is exactly
    // the case where ownership cannot be established, and diagnostics stay
    // greppable against the two agreed codes.
    super(
      verdict === 'conflict' ? 'company_ownership_conflict' : 'company_ownership_unproven',
      message,
      options,
    );
    this.name = 'CompanyOwnershipError';
    this.verdict = verdict;
  }
}

export interface CompanySessionControlResult {
  readonly status: CompanySession['status'];
  readonly nativeSessionId?: string;
  readonly nativeSessionPath?: string;
  readonly agentId?: number;
  readonly effectiveModel?: string;
}

/**
 * Effects owned by the workspace runtime, never by a transport surface.
 *
 * REENTRY CONTRACT -- which effects may commit back into the coordinator.
 *
 * `serialize()` is a lock HELD ACROSS AWAITS, not a synchronous critical
 * section: yielding to a macrotask (`setImmediate`, `setTimeout`, awaiting
 * anything) does NOT free it. Every operation queued on it resolves only after
 * the operation currently running finishes, so a queued call made from inside
 * a running operation waits for itself forever.
 *
 * Awaited WITH NO LOCK HELD (these MAY call `commitRuntimeChanges` and any
 * public command freely):
 *   recover              -- runs from start(), which is never serialized
 *   onPromptSubmitted    -- awaited after the prompt's serialized phase ends
 *   onContractDecision   -- likewise
 *   onQuestionAnswered   -- likewise
 *   onSettingsUpdated    -- likewise
 *   onStateChanged       -- never fired from inside the lock: commit() always
 *                           schedules it on the drained queue, and never
 *                           awaits the handler
 *
 * Awaited WHILE THE QUEUE IS HELD (calling `commitRuntimeChanges` or any
 * public command from one of these DEADLOCKS; `readState()` is safe because it
 * is synchronous):
 *   verifyControlOwnership
 *   controlSession
 *   getModelCatalog      -- a catalogue read; it must not commit either
 */
export interface WorkspaceCompanyCoordinatorEffects {
  /** Awaited while the queue is held (settings validation); read-only, must not commit. */
  readonly getModelCatalog: () => Promise<CompanyModelCatalogEntry[]>;
  readonly diagnostics: () => CompanyDiagnostics;
  readonly onPromptSubmitted: (prompt: CompanyPrompt, input: SubmitPromptInput) => Promise<void>;
  /**
   * Open a plain omp chat session in this workspace, or resume an omp session
   * file. `cwd` and `role` place a new session as `openNewChat` describes. Like
   * onPromptSubmitted, awaited after the caller's serialized phase.
   */
  readonly openChatSession: (input: {
    resumeFile?: string;
    cwd?: string;
    role?: CompanyRole;
    workstreamKey?: string;
  }) => Promise<CompanySession>;
  /** Park one squad session that the pool agrees is idle; false when the pool refuses. */
  readonly parkSquadSession: (sessionId: string) => Promise<boolean>;
  readonly onContractDecision: (contract: Contract, decision: ContractDecision) => Promise<void>;
  readonly onQuestionAnswered: (question: Question, input: QuestionAnswerInput) => Promise<void>;
  /**
   * Shut down, quiesce or release a run.
   *
   * Awaited WHILE the write queue is held (see the reentry contract above):
   * this must NOT call `commitRuntimeChanges` or any public command, and MUST
   * NOT yield to a macrotask expecting that to release the lock. Return the
   * resulting session facts; the coordinator journals them.
   */
  readonly controlSession: (
    session: CompanySession,
    action: CompanySessionAction,
    runEpoch: number,
  ) => Promise<CompanySessionControlResult>;
  /**
   * Stop a deleted session's live process and erase the files it owns: its OMP
   * session file and its board log. Awaited WHILE the write queue is held and
   * must NOT commit. A refusal throws, and then nothing is removed from the board.
   */
  readonly deleteSession: (sessionId: string, session: CompanySession | undefined) => Promise<void>;
  /**
   * Pre-invalidation ownership gate for a destructive control.
   *
   * Invoked before ANY durable change for `restart`, `kill` or `archive`, while
   * the session is still at the epoch the caller asked about. Resolve only once
   * the host has proven it still owns the live run for that epoch; reject with
   * {@link CompanyOwnershipError} to refuse.
   *
   * A rejection is total: no event is committed, the run epoch does not move,
   * no attempt is interrupted, and the native process is left exactly as it
   * was -- it may well still be running, which is the entire point of refusing.
   *
   * Optional, because a session with no live native run has nothing to prove.
   *
   * Awaited WHILE the write queue is held (see the reentry contract above):
   * this must NOT call `commitRuntimeChanges` or any public command. It proves
   * ownership; it does not change ownership.
   */
  readonly verifyControlOwnership?: (
    session: CompanySession,
    action: CompanySessionAction,
    runEpoch: number,
  ) => Promise<void>;
  /** Awaited with NO lock held; may commit its own routing through commitRuntimeChanges. */
  readonly onSettingsUpdated: (profiles: Record<string, RoleProfile>) => Promise<void>;
  /** Fired by commit() and never awaited; see the reentry contract above. */
  readonly onStateChanged: (event: CompanyEvent) => void;
  /** Awaited with NO lock held (runs from start(), which is never serialized). */
  readonly recover: (state: CompanyState) => Promise<void>;
  readonly dispose: () => Promise<void>;
}

export interface WorkspaceCompanyCoordinatorOptions {
  readonly store: CompanyStore;
  readonly state: CompanyState;
  readonly usageLedger: UsageLedger;
  readonly isOwner: () => boolean;
  readonly ownership?: Pick<CompanyOwnership, 'release'>;
  readonly effects: WorkspaceCompanyCoordinatorEffects;
  readonly now?: () => string;
  readonly isTerminalAttached?: (sessionId: string) => boolean;
  /**
   * Canonical workspace root. Defaults to the store's own canonical path, which
   * is the same realpath: changed paths and verification cwds are resolved
   * against it, so nothing may name a target that leaves the workspace.
   */
  readonly workspaceRoot?: string;
  /**
   * Machine-checks an environment prerequisite a Contract declared. Absent, a
   * declared prerequisite is unverifiable and blocks the run instead of being
   * assumed to hold.
   */
  readonly checkPrerequisite?: PrerequisiteCheck;
}

/**
 * Durable workspace coordinator. Every mutation is serialized, journaled before
 * it becomes visible, and rejected on followers. Runtime effects run only
 * after their authorization/state preconditions have committed.
 */

/**
 * Bind acceptance criteria to the verification profiles this workspace already has.
 *
 * A stored profile is keyed by the acceptance criterion it proves, so a binding
 * produces one criterion-keyed profile per claim and takes the executable, argv,
 * cwd, timeout and prerequisites from the DISCOVERED profile. A Director can
 * therefore connect a criterion to a check that really exists here and can never
 * author a command of its own. Only bound profiles are returned: an unbound
 * discovered profile claims no criterion and would fail the contract's own
 * key-matches-claim rule.
 */
function bindDiscoveredProfiles(
  discovered: Readonly<Record<string, VerificationProfile>>,
  bindings: Readonly<Record<string, unknown>>,
): Record<string, VerificationProfile> {
  const bound: Record<string, VerificationProfile> = {};
  for (const [criterionId, entry] of Object.entries(bindings)) {
    const profileId =
      entry !== null && typeof entry === 'object' && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)['profileId']
        : entry;
    if (typeof profileId !== 'string') continue;
    const source = discovered[profileId];
    if (source === undefined) continue;
    bound[criterionId] = {
      ...source,
      id: criterionId,
      criterionIds: [...(bound[criterionId]?.criterionIds ?? []), criterionId],
    };
  }
  return bound;
}

export class WorkspaceCompanyCoordinator implements CompanyCoordinator {
  private writeQueue: Promise<unknown> = Promise.resolve();
  private started = false;
  private startPromise: Promise<void> | null = null;
  private disposed = false;
  /**
   * True only while `effects.recover` is running. It lets the host journal its
   * reconciliation (interrupting what a crash left running) through
   * `commitRuntimeChanges`, WITHOUT opening the public command surface: nobody
   * may submit a prompt or a verdict against a company that has not finished
   * recovering.
   */
  private recovering = false;
  /**
   * In-flight verification runs keyed `attemptId:commandId`, each carrying the
   * QA session that authorized it so a restart or kill can cancel just those.
   */
  private readonly verifications = new Map<
    string,
    { controller: AbortController; sessionId: string }
  >();
  /**
   * The revision at which each entity was last written, keyed `entity:id`.
   *
   * A single global revision cannot tell a genuine conflict from an unrelated
   * one: two runtime turns routinely write different entities, and one turn's
   * commit would be refused because a concurrent turn had moved the company
   * forward. Recording per entity lets a batch be refused only when a record it
   * would overwrite actually changed underneath it, which is the only case in
   * which replaying a stale whole-record put would lose work.
   */
  private readonly entityRevisions = new Map<string, number>();

  private readonly workspaceRoot: string;
  /** Canonical keys of OMP files a resume is opening right now. */
  private readonly resumingOmpFiles = new Set<string>();

  constructor(private readonly options: WorkspaceCompanyCoordinatorOptions) {
    this.state = options.state;
    this.now = options.now ?? (() => new Date().toISOString());
    this.isTerminalAttached = options.isTerminalAttached ?? (() => false);
    this.workspaceRoot = options.workspaceRoot ?? options.store.workspacePath;
  }

  private state: CompanyState;

  private static entityKey(entity: string, id: string): string {
    return `${entity}:${id}`;
  }
  private readonly now: () => string;
  private readonly isTerminalAttached: (sessionId: string) => boolean;

  /** Refresh a follower's local read model from the owner's journal. */
  async refresh(): Promise<CompanySnapshot> {
    this.assertNotDisposed();
    return this.serialize(async () => {
      const state = await this.options.store.load();
      if (state.revision >= this.state.revision) this.state = state;
      return this.snapshot();
    });
  }

  /** Reconcile durable state before accepting commands or scheduling work. */
  async start(): Promise<void> {
    this.assertNotDisposed();
    if (this.started) return;
    if (this.startPromise) return this.startPromise;
    const pending = this.initialize();
    this.startPromise = pending;
    try {
      await pending;
    } finally {
      if (this.startPromise === pending) this.startPromise = null;
    }
  }

  private async initialize(): Promise<void> {
    const refreshed = await this.options.store.load();
    this.assertNotDisposed();
    if (refreshed.revision >= this.state.revision) this.state = refreshed;
    this.options.usageLedger.hydrateFromState(this.state.usageIndex);
    for (const session of Object.values(this.state.sessions)) {
      this.options.usageLedger.beginRun(session.id, session.runEpoch);
    }
    if (this.options.isOwner()) {
      this.recovering = true;
      try {
        await this.options.effects.recover(structuredClone(this.state));
      } catch (error) {
        // A failed recovery leaves the company unstarted rather than half-open:
        // the caller sees the failure and no command can act on a stale model.
        this.recovering = false;
        throw error;
      }
      this.recovering = false;
    }
    this.assertNotDisposed();
    this.started = true;
  }

  async submitPrompt(input: SubmitPromptInput): Promise<CompanyPrompt> {
    // Cheap synchronous refusals first, so a follower -- or a company that has
    // not finished starting -- never triggers a native catalogue read.
    this.assertOwner();
    this.assertStarted();
    // Capability prechecks run BEFORE the lock is taken. They consult the model
    // catalogue, which is a native call that boots host state and commits
    // through this very queue, and they are skipped entirely for a prompt with
    // no attachments so an ordinary prompt pays nothing for a bootstrap.
    await this.assertAttachmentsSupported(input);
    // Phase 1 owns the queue and nothing else: validation, the raw artifact,
    // and the commit. The native effect runs in phase 2 precisely so that it
    // is free to persist its own session, counters and route through
    // `commitRuntimeChanges`, which takes this very queue.
    const committed = await this.serialize(async () => {
      this.assertOwner();
      this.assertStarted();
      const byteLength = Buffer.byteLength(input.text, 'utf8');
      if (byteLength > COMPANY_MAX_PROMPT_BYTES) {
        throw new CompanyError(
          'prompt_too_large',
          `Prompt vượt quá ${COMPANY_MAX_PROMPT_BYTES} byte.`,
        );
      }
      if (!input.text.trim())
        throw new CompanyError('invalid_prompt', 'Nội dung prompt không được để trống.');
      if (input.delivery !== 'prompt' && !input.targetSessionId) {
        throw new CompanyError(
          'prompt_target_required',
          'Prompt điều hướng và theo dõi yêu cầu một phiên đích được chỉ định rõ ràng.',
        );
      }
      if (input.targetSessionId && !this.state.sessions[input.targetSessionId]) {
        throw new CompanyError(
          'session_not_found',
          `Unknown target session: ${input.targetSessionId}`,
        );
      }
      if (input.targetContractId && !this.state.contracts[input.targetContractId]) {
        throw new CompanyError(
          'contract_not_found',
          `Unknown target Contract: ${input.targetContractId}`,
        );
      }

      const rawTextArtifactId = await this.options.store.writeArtifact(
        Buffer.from(input.text, 'utf8'),
        COMPANY_PROMPT_TEXT_MEDIA_TYPE,
      );
      const result = createPromptSubmission(this.state, {
        prompt: input,
        rawTextArtifactId,
        now: this.now(),
      });
      const event = result.events[0];
      if (!event)
        throw new CompanyError('prompt_commit_failed', 'Chuyển trạng thái prompt không tạo ra sự kiện nào.');
      const promptChange = event.changes.find(
        (change) => change.entity === 'prompt' && change.op === 'put',
      );
      if (!promptChange || promptChange.entity !== 'prompt' || promptChange.op !== 'put') {
        throw new CompanyError(
          'prompt_commit_failed',
          'Chuyển trạng thái prompt không tạo được bản ghi prompt.',
        );
      }
      await this.commit(event);
      const stored = this.state.prompts[promptChange.id];
      if (!stored)
        throw new CompanyError(
          'prompt_commit_failed',
          'Không đọc lại được prompt đã commit.',
        );
      return stored;
    });

    // Phase 2 holds no lock. The prompt and its raw artifact are already
    // durable, so a failing effect rejects to the caller without anything to
    // roll back and without replaying the prompt.
    await this.options.effects.onPromptSubmitted(committed, input);
    // The routed session is written in phase 2, so the answer (which session took
    // the prompt) is read back from the committed record, not the pre-route copy.
    return this.state.prompts[committed.id] ?? committed;
  }

  async submitContractDraft(input: {
    sessionId: string;
    runEpoch: number;
    promptId: string;
    proposal: ContractDraftProposal;
  }): Promise<void> {
    await this.serialize(async () => {
      this.assertOwner();
      this.assertStarted();
      const session = this.state.sessions[input.sessionId];
      if (!session || session.role !== 'director') {
        throw new CompanyError(
          'company_role_forbidden',
          'Chỉ phiên Director mới được gửi bản nháp Hợp đồng.',
        );
      }
      if (session.runEpoch !== input.runEpoch) {
        throw new CompanyError(
          'stale_run_epoch',
          `Director session ${session.code} has moved to another run.`,
        );
      }
      if (session.status !== 'busy') {
        throw new CompanyError(
          'director_run_not_active',
          `Director session ${session.code} is not actively planning.`,
        );
      }
      const prompt = this.state.prompts[input.promptId];
      if (!prompt) throw new CompanyError('prompt_not_found', `Unknown prompt: ${input.promptId}`);
      if (prompt.targetSessionId && prompt.targetSessionId !== session.id) {
        throw new CompanyError(
          'prompt_session_mismatch',
          `Prompt ${prompt.id} is assigned to another session.`,
        );
      }
      // A Director may BIND a criterion to a verification profile this workspace
      // already discovered; it may not introduce one. Only the criterion binding
      // is taken from the proposal — the executable and argv always come from
      // the discovered profile, so a model can never author a command to run.
      const boundProfiles = bindDiscoveredProfiles(
        this.state.settings.verificationProfiles,
        input.proposal.verificationProfiles ?? {},
      );
      const result = createContractDraft(this.state, {
        promptId: prompt.id,
        proposal: input.proposal,
        verificationProfiles: boundProfiles,
        now: this.now(),
        newEvent: { id: randomUUID() },
      });
      const event = result.events[0];
      if (!event)
        throw new CompanyError(
          'contract_draft_failed',
          'Chuyển trạng thái bản nháp hợp đồng không tạo ra sự kiện nào.',
        );
      await this.commit(event);
    });
  }

  async decideContract(
    id: string,
    revision: number,
    decision: ContractDecision,
    note?: string,
  ): Promise<void> {
    // The decision is durable before anything downstream is told about it, and
    // the notification runs with no lock held so the host may commit its own
    // routing while it reacts.
    const updated = await this.serialize(async () => {
      this.assertOwner();
      this.assertStarted();
      const contract = this.state.contracts[id];
      if (!contract) throw new CompanyError('contract_not_found', `Unknown Contract: ${id}`);
      if (contract.revision !== revision) {
        throw new CompanyError(
          'company_revision_conflict',
          `Contract ${contract.code} is at revision ${contract.revision}, not ${revision}.`,
        );
      }

      let event: CompanyEvent;
      if (decision === 'approve') {
        const result = approveContract(this.state, id, revision, this.now());
        const approved = result.events[0];
        if (!approved)
          throw new CompanyError('contract_approval_failed', 'Duyệt không tạo ra sự kiện nào.');
        event = approved;
      } else {
        if (contract.status !== 'awaiting_approval') {
          throw new CompanyError(
            'contract_not_awaiting_approval',
            `Contract ${contract.code} is ${contract.status}, not awaiting approval.`,
          );
        }
        const rejected: Contract = {
          ...contract,
          status: 'cancelled',
          decisions: note ? [...contract.decisions, note] : contract.decisions,
        };
        event = this.makeEvent([{ entity: 'contract', op: 'put', id, value: rejected }]);
      }

      await this.commit(event);
      return this.state.contracts[id];
    });
    if (updated) await this.options.effects.onContractDecision(updated, decision);
  }

  async submitArchitectureReview(input: {
    sessionId: string;
    runEpoch: number;
    contractId: string;
    revision: number;
    verdict: 'approve' | 'changes_requested';
    issues: CompanyArchitectureIssue[];
    advisorNotes: string[];
  }): Promise<void> {
    await this.serialize(async () => {
      this.assertOwner();
      this.assertStarted();
      const session = this.state.sessions[input.sessionId];
      if (!session || session.role !== 'advisor') {
        throw new CompanyError(
          'company_role_forbidden',
          'Chỉ phiên Advisor mới được gửi đánh giá kiến trúc.',
        );
      }
      if (session.runEpoch !== input.runEpoch) {
        throw new CompanyError(
          'stale_run_epoch',
          `Advisor session ${session.code} has moved to another run.`,
        );
      }
      if (session.status !== 'busy') {
        throw new CompanyError(
          'advisor_run_not_active',
          `Advisor session ${session.code} is not actively reviewing.`,
        );
      }
      const result = recordArchitectureReviewTransition(this.state, {
        contractId: input.contractId,
        revision: input.revision,
        verdict: input.verdict,
        issues: input.issues,
        advisorNotes: input.advisorNotes,
        now: this.now(),
        newEvent: { id: randomUUID() },
      });
      const event = result.events[0];
      if (!event)
        throw new CompanyError('contract_review_failed', 'Đánh giá kiến trúc không tạo ra sự kiện nào.');
      await this.commit(event);
    });
  }

  /** Read-only projection of the durable state, for an in-process runtime. */
  readState(): CompanyState {
    return structuredClone(this.state);
  }

  /**
   * Journal one host-authored batch of changes (session identity, native
   * session handles, usage, routing, counters, recovery reconciliation).
   *
   * It is the same atomic, journaled commit every other mutation uses, so the
   * runtime cannot write durable state behind the coordinator's back, and
   * `expectedRevision` is what stops two writers from interleaving.
   *
   * It is the ONE surface that also answers while `effects.recover` runs: a
   * crashed run has to be reconciled before the company is usable, and that
   * reconciliation is exactly this method. Nothing else does -- every public
   * command still refuses with `company_not_started` until recovery finishes.
   * Commits made during recovery are journaled but never dispatched, so
   * reconciling the past cannot wake a session and start new work on its own.
   */
  async commitRuntimeChanges(
    changes: readonly CompanyChange[],
    expectedRevision: number,
  ): Promise<void> {
    await this.serialize(async () => {
      this.assertOwner();
      if (!this.started && !this.recovering) {
        throw new CompanyError(
          'company_not_started',
          'Runtime công ty chưa hoàn tất khởi động.',
        );
      }
      // Only a record this batch would overwrite can conflict. Refusing because
      // SOME unrelated entity moved forward would reject valid work and, worse,
      // teach the caller to retry a batch whose own contents are already stale.
      for (const change of changes) {
        const last = this.entityRevisions.get(
          WorkspaceCompanyCoordinator.entityKey(change.entity, change.id),
        );
        if (last !== undefined && last > expectedRevision) {
          throw new CompanyError(
            'company_revision_conflict',
            `${change.entity} ${change.id} changed at revision ${last}; these changes target revision ${expectedRevision}.`,
          );
        }
      }
      if (changes.length === 0) return;
      await this.commit(this.makeEvent([...changes]), this.recovering ? 'suppressed' : 'deferred');
    });
  }

  /**
   * Record a Worker result: validate every claim against the live attempt,
   * then persist the changes and hand the task to verification in one event.
   */
  async submitTaskResult(input: WorkerTaskResultInput): Promise<WorkerTaskResultOutput> {
    return this.serialize(async () => {
      this.assertOwner();
      this.assertStarted();
      const session = this.assertRoleSession(input.sessionId, input.runEpoch, 'worker');
      const task = this.state.tasks[input.taskId];
      if (!task) throw new CompanyError('task_not_found', `Unknown task: ${input.taskId}`);
      if (session.activeTaskId !== task.id) {
        throw new CompanyError(
          'task_not_active_for_session',
          `Worker session ${session.code} is not working on task ${task.code}.`,
        );
      }
      const contract = this.state.contracts[task.contractId];
      if (!contract) {
        throw new CompanyError('contract_not_found', `Unknown Contract: ${task.contractId}`);
      }
      if (contract.status !== 'approved' && contract.status !== 'running') {
        throw new CompanyError(
          'contract_not_running',
          `Contract ${contract.code} is ${contract.status}; work needs an approved Contract.`,
        );
      }
      const attempt = this.state.attempts[input.attemptId];
      if (!attempt)
        throw new CompanyError('attempt_not_found', `Unknown attempt: ${input.attemptId}`);

      const declared = Array.isArray(input.changes) ? input.changes : [];
      const seen = new Set<string>();
      const changes: WorkspaceChange[] = [];
      for (const change of declared) {
        const validated = await this.validateChange(change, task);
        if (seen.has(validated.path)) {
          throw new CompanyError(
            'duplicate_change_path',
            `Path ${validated.path} is reported twice in one result.`,
          );
        }
        seen.add(validated.path);
        changes.push(validated);
      }

      const result = recordTaskResult(this.state, {
        taskId: task.id,
        attemptId: attempt.id,
        sessionId: input.sessionId,
        runEpoch: input.runEpoch,
        changes,
        now: this.now(),
        newEvent: { id: randomUUID() },
      });
      const event = result.events[0];
      if (!event)
        throw new CompanyError('task_result_failed', 'Chuyển trạng thái kết quả nhiệm vụ không tạo ra sự kiện nào.');
      // The assignment is released IN THE SAME EVENT that accepts the result. A
      // role still holding its task can never be parked, so it would keep its
      // runner slot forever and starve the next role in the chain — but the
      // release cannot happen any earlier either, because authorization for this
      // very call is exactly what the assignment provides.
      const released: CompanySession = { ...session };
      delete released.activeTaskId;
      await this.commit(
        {
          ...event,
          changes: [
            ...event.changes,
            { entity: 'session', op: 'put', id: session.id, value: released },
          ],
        },
        'deferred',
      );
      return {
        taskId: task.id,
        attemptId: attempt.id,
        taskStatus: 'verifying',
        changes,
        revision: this.state.revision,
      };
    });
  }

  /**
   * Run one approved verification command and record what actually happened.
   *
   * The subprocess runs OUTSIDE the serialized queue -- a suite that takes a
   * minute must not block every other company command -- and the epoch and
   * attempt are rechecked afterwards, so a run whose session moved on while it
   * executed commits nothing.
   */
  async verifyTask(input: VerificationRequest): Promise<VerificationOutcome> {
    const plan = await this.serialize(async () => {
      this.assertOwner();
      this.assertStarted();
      const session = this.assertRoleSession(input.sessionId, input.runEpoch, 'qa');
      const task = this.state.tasks[input.taskId];
      if (!task) throw new CompanyError('task_not_found', `Unknown task: ${input.taskId}`);
      if (session.activeTaskId !== task.id) {
        throw new CompanyError(
          'task_not_active_for_session',
          `QA session ${session.code} is not reviewing task ${task.code}.`,
        );
      }
      if (task.status !== 'verifying') {
        throw new CompanyError(
          'task_not_verifying',
          `Task ${task.code} is ${task.status}, not verifying.`,
        );
      }
      const attempt = this.assertLiveAttempt(task, input.attemptId);
      const approved = approvedVerificationCommand(this.state, task, input.commandId);
      if (!approved) {
        throw new CompanyError(
          'verification_command_not_approved',
          `Command ${input.commandId} is not in an approved verification profile for task ${task.code}.`,
        );
      }
      const key = `${attempt.id}:${input.commandId}`;
      if (this.verifications.has(key)) {
        throw new CompanyError(
          'verification_already_running',
          `Command ${input.commandId} is already running for attempt ${attempt.id}.`,
        );
      }
      const controller = new AbortController();
      this.verifications.set(key, { controller, sessionId: session.id });
      return { session, task, attempt, approved, controller, key };
    });

    let outcome;
    try {
      outcome = await runVerificationCommand(
        {
          command: plan.approved.command,
          criterionIds: plan.approved.criterionIds,
          prerequisites: plan.approved.prerequisites,
        },
        {
          workspaceRoot: this.workspaceRoot,
          store: this.options.store,
          signal: plan.controller.signal,
          ...(this.options.checkPrerequisite
            ? { checkPrerequisite: this.options.checkPrerequisite }
            : {}),
        },
      );
    } finally {
      this.verifications.delete(plan.key);
    }

    return this.serialize(async () => {
      this.assertOwner();
      this.assertStarted();
      if (plan.controller.signal.aborted) {
        throw new CompanyError(
          'verification_cancelled',
          `Command ${input.commandId} was cancelled and recorded no evidence.`,
        );
      }
      const session = this.state.sessions[plan.session.id];
      if (!session || session.runEpoch !== input.runEpoch) {
        throw new CompanyError(
          'stale_run_epoch',
          `QA session ${plan.session.code} moved to another run while the command executed.`,
        );
      }
      const attempt = this.state.attempts[plan.attempt.id];
      if (!attempt || attempt.status !== 'running') {
        throw new CompanyError(
          'attempt_not_running',
          `Attempt ${plan.attempt.id} closed while the command executed.`,
        );
      }
      const task = this.state.tasks[plan.task.id];
      if (
        !task ||
        task.status !== 'verifying' ||
        task.attemptIds[task.attemptIds.length - 1] !== attempt.id
      ) {
        throw new CompanyError(
          'stale_task_attempt',
          `Task ${plan.task.code} moved on while the command executed.`,
        );
      }

      const evidence = outcome.evidence;
      const committed: Attempt = { ...attempt, evidenceIds: [...attempt.evidenceIds, evidence.id] };
      await this.commit(
        this.makeEvent([
          { entity: 'evidence', op: 'put', id: evidence.id, value: evidence },
          { entity: 'attempt', op: 'put', id: attempt.id, value: committed },
        ]),
        'deferred',
      );
      return {
        taskId: task.id,
        attemptId: attempt.id,
        commandId: input.commandId,
        status: outcome.status,
        evidenceId: evidence.id,
        ...(evidence.exitCode === undefined ? {} : { exitCode: evidence.exitCode }),
        criterionIds: [...plan.approved.criterionIds],
        reason: outcome.reason,
        revision: this.state.revision,
      };
    });
  }

  async submitQaResult(input: ReviewerResultInput): Promise<ReviewerResultOutput> {
    return this.reviewerResult(input, 'qa', recordQaVerdict);
  }

  async submitJudgeResult(input: ReviewerResultInput): Promise<ReviewerResultOutput> {
    return this.reviewerResult(input, 'judge', recordJudgeVerdict);
  }

  private reviewerResult(
    input: ReviewerResultInput,
    role: 'qa' | 'judge',
    transition: typeof recordQaVerdict,
  ): Promise<ReviewerResultOutput> {
    return this.serialize(async () => {
      this.assertOwner();
      this.assertStarted();
      const session = this.assertRoleSession(input.sessionId, input.runEpoch, role);
      const task = this.state.tasks[input.taskId];
      if (!task) throw new CompanyError('task_not_found', `Unknown task: ${input.taskId}`);
      if (session.activeTaskId !== task.id) {
        throw new CompanyError(
          'task_not_active_for_session',
          `${role === 'qa' ? 'QA' : 'Judge'} session ${session.code} is not reviewing task ${task.code}.`,
        );
      }
      const attempt = this.state.attempts[input.attemptId];
      if (!attempt)
        throw new CompanyError('attempt_not_found', `Unknown attempt: ${input.attemptId}`);
      if (input.verdict !== 'pass' && input.verdict !== 'fail') {
        throw new CompanyError(
          'invalid_review_verdict',
          `Unknown verdict: ${String(input.verdict)}.`,
        );
      }
      const result = transition(this.state, {
        taskId: task.id,
        attemptId: attempt.id,
        sessionId: input.sessionId,
        runEpoch: input.runEpoch,
        verdict: input.verdict,
        criterionIds: [...(input.criterionIds ?? [])],
        evidenceIds: [...(input.evidenceIds ?? [])],
        notes: [...(input.notes ?? [])],
        now: this.now(),
        newEvent: { id: randomUUID() },
      });
      const event = result.events[0];
      if (!event)
        throw new CompanyError('review_failed', 'Chuyển trạng thái người đánh giá không tạo ra sự kiện nào.');
      // Released with the verdict, for the same reason as the Worker result: the
      // assignment authorizes THIS call and nothing after it, and holding it
      // keeps the reviewer permanently unparkable.
      const released: CompanySession = { ...session };
      delete released.activeTaskId;
      await this.commit(
        {
          ...event,
          changes: [
            ...event.changes,
            { entity: 'session', op: 'put', id: session.id, value: released },
          ],
        },
        'deferred',
      );
      const closedAttempt = this.state.attempts[attempt.id];
      const closedTask = this.state.tasks[task.id];
      return {
        taskId: task.id,
        attemptId: attempt.id,
        verdict: input.verdict,
        taskStatus: closedTask?.status ?? task.status,
        attemptStatus: closedAttempt?.status ?? attempt.status,
        revision: this.state.revision,
      };
    });
  }

  private assertRoleSession(
    sessionId: string,
    runEpoch: number,
    role: CompanyRole,
  ): CompanySession {
    const session = this.state.sessions[sessionId];
    if (!session || session.role !== role) {
      throw new CompanyError('company_role_forbidden', `Only a ${role} session may do this.`);
    }
    if (session.runEpoch !== runEpoch) {
      throw new CompanyError(
        'stale_run_epoch',
        `Session ${session.code} is at epoch ${session.runEpoch}, not ${runEpoch}.`,
      );
    }
    return session;
  }

  private assertLiveAttempt(task: Task, attemptId: string): Attempt {
    const attempt = this.state.attempts[attemptId];
    if (!attempt) throw new CompanyError('attempt_not_found', `Unknown attempt: ${attemptId}`);
    if (attempt.taskId !== task.id) {
      throw new CompanyError(
        'attempt_task_mismatch',
        `Attempt ${attemptId} belongs to task ${attempt.taskId}, not ${task.code}.`,
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
    return attempt;
  }

  /**
   * One changed path, proven acceptable before it reaches the journal: relative,
   * canonical inside the workspace, inside a declared write scope, using an
   * operation that scope declares, and citing a diff artifact that exists.
   *
   * A deletion is rejected here: no `WriteScope` declares a `delete` operation,
   * so a Worker cannot report removing a file on the strength of a scope that
   * only ever promised it could create or modify things.
   */
  private async validateChange(change: WorkspaceChangeInput, task: Task): Promise<WorkspaceChange> {
    if (typeof change?.path !== 'string' || !change.path.trim()) {
      throw new CompanyError('invalid_change_path', 'Một thay đổi được báo cáo cần có đường dẫn không rỗng.');
    }
    if (path.isAbsolute(change.path) || /^[a-zA-Z]:/.test(change.path)) {
      throw new CompanyError(
        'change_path_not_relative',
        `A reported change path must be workspace-relative: ${change.path}`,
      );
    }
    if (resolveWorkspaceTarget(this.workspaceRoot, change.path) === null) {
      throw new CompanyError(
        'change_path_outside_workspace',
        `A reported change resolves outside the workspace: ${change.path}`,
      );
    }
    const scope = task.writeScopes.find((entry) => scopeCovers(entry, change.path));
    if (!scope) {
      throw new CompanyError(
        'change_outside_write_scope',
        `Task ${task.code} has no write scope covering ${change.path}.`,
      );
    }
    if (!(scope.operations as readonly string[]).includes(change.kind)) {
      throw new CompanyError(
        'change_operation_not_allowed',
        `Write scope ${scope.path} does not allow a ${change.kind}.`,
      );
    }
    if (typeof change.summary !== 'string' || !change.summary.trim()) {
      throw new CompanyError(
        'invalid_change_summary',
        `A reported change needs a summary: ${change.path}`,
      );
    }
    const diffArtifactId =
      typeof change.diffArtifactId === 'string' && change.diffArtifactId
        ? change.diffArtifactId
        : undefined;
    if (diffArtifactId !== undefined && !(await this.options.store.hasArtifact(diffArtifactId))) {
      throw new CompanyError(
        'change_artifact_not_found',
        `Diff artifact ${diffArtifactId} was never stored.`,
      );
    }
    return {
      path: change.path,
      kind: change.kind,
      summary: change.summary,
      ...(diffArtifactId === undefined ? {} : { diffArtifactId }),
    };
  }

  async answerQuestion(input: QuestionAnswerInput): Promise<void> {
    // The answer is journaled first; the native resume that follows is free to
    // commit the session state it produces, because it runs with no lock held.
    const answered = await this.serialize(async () => {
      this.assertOwner();
      this.assertStarted();
      const result = answerQuestionTransition(this.state, {
        ...input,
        now: this.now(),
        newEvent: { id: randomUUID() },
      });
      const event = result.events[0];
      if (!event)
        throw new CompanyError('question_answer_failed', 'Chuyển trạng thái câu trả lời không tạo ra sự kiện nào.');
      await this.commit(event);
      const record = this.state.questions[input.questionId];
      if (!record)
        throw new CompanyError(
          'question_answer_failed',
          'Câu hỏi đã trả lời biến mất sau khi commit.',
        );
      return record;
    });
    await this.options.effects.onQuestionAnswered(answered, input);
  }

  async controlSession(id: string, action: CompanySessionAction, runEpoch: number): Promise<void> {
    await this.serialize(async () => {
      this.assertOwner();
      this.assertStarted();
      const current = this.state.sessions[id];
      if (!current) throw new CompanyError('session_not_found', `Unknown session: ${id}`);
      if (current.runEpoch !== runEpoch) {
        throw new CompanyError(
          'stale_run_epoch',
          `Session ${current.code} is at epoch ${current.runEpoch}, not ${runEpoch}.`,
        );
      }
      if (action === 'delete') {
        await this.deleteSession(current, runEpoch);
        return;
      }
      if (action === 'interrupt') {
        await this.interruptSession(current, runEpoch);
        return;
      }
      this.assertActionAvailable(current, action);
      if (action === 'archive') this.assertArchivable(current);
      if (action === 'resume' || action === 'restart') this.assertReopenable(current);

      // Prove ownership BEFORE anything durable moves. After this point the
      // epoch has already advanced and attempts are already interrupted, so a
      // refusal recorded later would be a lie about a run that is still alive.
      if (OWNERSHIP_GATED_ACTIONS.has(action)) {
        await this.options.effects.verifyControlOwnership?.(current, action, runEpoch);
      }

      const result = controlSessionTransition(this.state, id, action, runEpoch, this.now(), {
        id: randomUUID(),
      });
      const transition = result.events[0];
      if (!transition)
        throw new CompanyError('session_control_failed', 'Chuyển trạng thái phiên không tạo ra sự kiện nào.');

      if (action === 'archive') {
        const archived = await this.options.effects.controlSession(current, action, runEpoch);
        if (archived.status !== 'archived') {
          throw new CompanyError(
            'session_control_result_invalid',
            'Lưu trữ không giải phóng được chỗ của phiên đang đậu.',
          );
        }
        await this.commit(transition);
        return;
      }

      const invalidated =
        action === 'restart' || action === 'kill'
          ? this.interruptedRunChanges(current, action)
          : [];
      await this.commit({ ...transition, changes: [...transition.changes, ...invalidated] });
      const transitioned = this.state.sessions[id];
      if (!transitioned)
        throw new CompanyError('session_control_failed', 'Phiên biến mất sau khi chuyển trạng thái.');
      const targetEpoch = transitioned.runEpoch;
      if (action === 'restart' || action === 'kill') {
        this.options.usageLedger.beginRun(id, targetEpoch);
        // A command started under the old epoch may no longer report into it,
        // so its run is killed rather than left to finish into a dead attempt.
        this.abortVerificationsOfSession(id);
      }

      try {
        const runtimeResult = await this.options.effects.controlSession(
          transitioned,
          action,
          targetEpoch,
        );
        this.assertControlResult(action, runtimeResult.status);
        const updated: CompanySession = {
          ...transitioned,
          ...runtimeResult,
          runEpoch: targetEpoch,
          lastUsedAt: this.now(),
        };
        if (
          updated.status !== transitioned.status ||
          runtimeResult.nativeSessionId ||
          runtimeResult.nativeSessionPath
        ) {
          await this.commit(this.makeEvent([{ entity: 'session', op: 'put', id, value: updated }]));
        }
      } catch (error) {
        if (action !== 'pause') {
          // The durable invalidation above assumed the run was ours and would
          // die. An ownership refusal breaks that assumption: we may have left
          // a live process running, so `crashed` would be a lie. `stopped` is
          // the one status that claims nothing about the process, and the task
          // and its attempts are left exactly as they are so an orphaned run
          // stays visible to the operator instead of quietly disappearing.
          const blocked = error instanceof CompanyOwnershipError;
          const failed: CompanySession = {
            ...transitioned,
            status: blocked ? 'stopped' : 'crashed',
            lastUsedAt: this.now(),
          };
          await this.commit(this.makeEvent([{ entity: 'session', op: 'put', id, value: failed }]));
        }
        throw error;
      }
    });
  }

  /**
   * Withdraw one prompt no Contract holds. When the session it was routed to
   * carries no other prompt and is not a chat session, that session is stopped
   * and deleted with it. Both changes commit together.
   */
  async cancelPrompt(promptId: string): Promise<void> {
    await this.serialize(async () => {
      this.assertOwner();
      this.assertStarted();
      const prompt = this.state.prompts[promptId];
      if (!prompt) throw new CompanyError('prompt_not_found', `Unknown prompt: ${promptId}`);
      const held = Object.values(this.state.contracts).some((contract) =>
        contract.promptIds.includes(promptId),
      );
      if (held) {
        throw new CompanyError(
          'prompt_in_contract',
          'Prompt này đã nằm trong một Contract nên không thể rút lại.',
        );
      }
      const changes: CompanyChange[] = [{ entity: 'prompt', op: 'remove', id: promptId }];
      const target =
        prompt.targetSessionId === undefined
          ? undefined
          : this.state.sessions[prompt.targetSessionId];
      const sharedWithOtherPrompts =
        target !== undefined &&
        Object.values(this.state.prompts).some(
          (other) => other.id !== promptId && other.targetSessionId === target.id,
        );
      if (target !== undefined && target.role !== 'chat' && !sharedWithOtherPrompts) {
        this.assertDeletable(target, { allowRunning: true });
        await this.options.effects.verifyControlOwnership?.(target, 'delete', target.runEpoch);
        await this.options.effects.deleteSession(target.id, target);
        changes.push({ entity: 'session', op: 'remove', id: target.id });
      }
      await this.commit(this.makeEvent(changes));
    });
  }

  /** List the OMP session files saved for the workspace folder and its repos. Read-only. */
  async listOmpSessions(): Promise<OmpSessionListing> {
    this.assertNotDisposed();
    const boardSessionByFile = new Map<string, string>();
    for (const session of Object.values(this.state.sessions)) {
      if (session.nativeSessionPath !== undefined) {
        boardSessionByFile.set(comparableOmpPath(session.nativeSessionPath), session.id);
      }
    }
    const sessions = await listOmpSessionFiles(
      await this.ompSessionDirectories(),
      boardSessionByFile,
    );
    return { folder: this.workspaceRoot, sessions };
  }

  /**
   * Every directory a folder session's OMP files can live in: the folder root's, each repo the
   * folder holds, and the directory of each board session whose cwd is inside the folder.
   */
  private async ompSessionDirectories(): Promise<string[]> {
    const repos = await listFolderRepos(this.workspaceRoot);
    const boardCwds = await Promise.all(
      Object.values(this.state.sessions).map(async (session) =>
        session.cwd === undefined
          ? undefined
          : canonicalWithinFolder(session.cwd, this.workspaceRoot),
      ),
    );
    const insideBoardCwds = boardCwds.filter((cwd): cwd is string => cwd !== undefined);
    return [this.workspaceRoot, ...repos, ...insideBoardCwds].map((folder) =>
      ompSessionDirForFolder(folder),
    );
  }

  /**
   * The directory a resumed session ran in, read from its file's header, when that directory is
   * an existing directory inside the folder. Anything else resumes in the folder root.
   */
  private async resumedSessionCwd(file: string): Promise<string | undefined> {
    const headerCwd = await readOmpSessionCwd(file);
    if (headerCwd === undefined) return undefined;
    try {
      return await resolveFolderCwd(headerCwd, this.workspaceRoot);
    } catch (error) {
      if (error instanceof CompanyError) return undefined;
      throw error;
    }
  }

  /**
   * Open a plain omp chat session in this workspace with no prompt. Nothing is
   * sent: the session waits for the user's first message. Returns its board id.
   * `cwd` and `role` place the new session (see `CompanyCoordinator.openNewChat`);
   * with neither, it is a chat session in the folder root.
   */
  async openNewChat(
    input: { cwd?: string; role?: CompanyRole; workstreamKey?: string } = {},
  ): Promise<string> {
    // The guards run under the queue. The effect runs after it, because it
    // commits through this same queue and would wait on itself inside it.
    await this.serialize(async () => {
      this.assertOwner();
      this.assertStarted();
    });
    const cwd =
      input.cwd === undefined ? undefined : await resolveFolderCwd(input.cwd, this.workspaceRoot);
    const session = await this.options.effects.openChatSession({
      ...(cwd === undefined ? {} : { cwd }),
      ...(input.role === undefined ? {} : { role: input.role }),
      ...(input.workstreamKey === undefined ? {} : { workstreamKey: input.workstreamKey }),
    });
    return session.id;
  }

  /**
   * Park one idle squad session so its process stops. Guards run under the queue; the effect runs
   * after it, as for the other session commands. False when the pool refuses.
   */
  async parkSquadSession(sessionId: string): Promise<boolean> {
    await this.serialize(async () => {
      this.assertOwner();
      this.assertStarted();
    });
    return this.options.effects.parkSquadSession(sessionId);
  }

  /**
   * Open a saved OMP session as a chat session. A live chat session that holds
   * the file answers with that session. A parked or ended chat session reopens
   * on its own file under the same record. Concurrent opens of one file are refused.
   */
  async resumeOmpSession(file: string): Promise<string> {
    const resolved = await assertOmpSessionFileIn(file, await this.ompSessionDirectories());
    const key = comparableOmpPath(resolved);
    const target = await this.serialize(async (): Promise<OmpResumeTarget> => {
      this.assertOwner();
      this.assertStarted();
      if (this.resumingOmpFiles.has(key)) {
        throw new CompanyError('omp_session_resuming', 'Phiên OMP này đang được mở; thử lại sau.');
      }
      const existing = Object.values(this.state.sessions).find(
        (session) =>
          session.nativeSessionPath !== undefined &&
          comparableOmpPath(session.nativeSessionPath) === key,
      );
      if (existing === undefined) {
        this.resumingOmpFiles.add(key);
        return { kind: 'open' };
      }
      if (existing.status === 'archived') {
        throw new CompanyError(
          'omp_session_archived',
          'Phiên OMP này thuộc một phiên đã lưu trữ nên không thể mở lại.',
        );
      }
      if (existing.role !== 'chat' || REOPENABLE_STATUSES[existing.status] !== true) {
        return { kind: 'focus', sessionId: existing.id };
      }
      this.resumingOmpFiles.add(key);
      return {
        kind: 'reopen',
        sessionId: existing.id,
        action: existing.status === 'parked' ? 'resume' : 'restart',
        runEpoch: existing.runEpoch,
      };
    });
    if (target.kind === 'focus') return target.sessionId;
    try {
      if (target.kind === 'open') {
        const cwd = await this.resumedSessionCwd(resolved);
        const session = await this.options.effects.openChatSession({
          resumeFile: resolved,
          ...(cwd === undefined ? {} : { cwd }),
        });
        return session.id;
      }
      await this.controlSession(target.sessionId, target.action, target.runEpoch);
      return target.sessionId;
    } finally {
      this.resumingOmpFiles.delete(key);
    }
  }

  /**
   * Interrupt the turn a session is running, as Esc does in omp. The native turn
   * ends and the session returns to idle through its normal run-end path, so
   * nothing durable is written here.
   */
  private async interruptSession(current: CompanySession, runEpoch: number): Promise<void> {
    if (INTERRUPTIBLE_STATUSES[current.status] !== true) {
      throw new CompanyError(
        'session_not_busy',
        `Phiên ${current.code} không có lượt đang chạy để dừng.`,
      );
    }
    await this.options.effects.verifyControlOwnership?.(current, 'interrupt', runEpoch);
    await this.options.effects.controlSession(current, 'interrupt', runEpoch);
  }

  /**
   * Delete a session the user asked to remove. Its process is stopped and its
   * files erased before the board forgets it, so a failure part-way leaves the
   * record in place and the delete can be retried.
   */
  private async deleteSession(current: CompanySession, runEpoch: number): Promise<void> {
    this.assertDeletable(current, { allowRunning: false });
    await this.options.effects.verifyControlOwnership?.(current, 'delete', runEpoch);
    await this.options.effects.deleteSession(current.id, current);
    await this.commit(this.makeEvent([{ entity: 'session', op: 'remove', id: current.id }]));
  }

  /**
   * Refuse deletion while the session still holds work: a live turn (unless the
   * caller stops it), an unfinished task or running attempt, a pending question,
   * or a prompt that belongs to an open Contract.
   */
  private assertDeletable(
    session: CompanySession,
    options: { readonly allowRunning: boolean },
  ): void {
    if (!options.allowRunning && DELETE_BLOCKING_STATUSES[session.status] === true) {
      throw new CompanyError(
        'session_running',
        `Phiên ${session.code} đang chạy lượt; hãy dừng lượt trước khi xoá.`,
      );
    }
    const task =
      session.activeTaskId === undefined ? undefined : this.state.tasks[session.activeTaskId];
    if (task !== undefined && RELEASED_TASK_STATUSES[task.status] !== true) {
      throw new CompanyError(
        'session_holds_task',
        `Phiên ${session.code} còn giữ một việc chưa xong; hãy hoàn tất hoặc huỷ việc đó trước.`,
      );
    }
    const attemptRunning = Object.values(this.state.attempts).some(
      (attempt) => attempt.sessionId === session.id && attempt.status === 'running',
    );
    if (attemptRunning) {
      throw new CompanyError(
        'session_holds_task',
        `Phiên ${session.code} đang chạy một lượt làm việc; hãy dừng lượt đó trước.`,
      );
    }
    const questionPending = Object.values(this.state.questions).some(
      (question) => question.sessionId === session.id && question.status === 'pending',
    );
    if (questionPending) {
      throw new CompanyError(
        'session_holds_question',
        `Phiên ${session.code} đang chờ trả lời một câu hỏi; hãy trả lời hoặc từ chối câu hỏi đó trước.`,
      );
    }
    const inOpenContract = Object.values(this.state.contracts).some(
      (contract) =>
        CLOSED_CONTRACT_STATUSES[contract.status] !== true &&
        contract.promptIds.some(
          (promptId) => this.state.prompts[promptId]?.targetSessionId === session.id,
        ),
    );
    if (inOpenContract) {
      throw new CompanyError(
        'session_in_contract',
        `Phiên ${session.code} đang nằm trong một Contract chưa đóng.`,
      );
    }
  }

  /**
   * Rename one managed session. The name is validated here as well as at the wire,
   * so no caller can store an empty or oversized label as durable state.
   */
  async renameSession(id: string, name: string): Promise<void> {
    await this.serialize(async () => {
      this.assertOwner();
      this.assertStarted();
      const current = this.state.sessions[id];
      if (!current) throw new CompanyError('session_not_found', `Unknown session: ${id}`);
      const trimmed = name.trim();
      if (trimmed.length === 0 || trimmed.length > COMPANY_SESSION_NAME_MAX_LENGTH) {
        throw new CompanyError(
          'session_name_invalid',
          `Tên phiên phải từ 1 đến ${COMPANY_SESSION_NAME_MAX_LENGTH} ký tự.`,
        );
      }
      if (trimmed === current.name) return;
      const updated: CompanySession = { ...current, name: trimmed };
      await this.commit(this.makeEvent([{ entity: 'session', op: 'put', id, value: updated }]));
    });
  }

  async updateSettings(roleProfiles: Record<string, RoleProfile>): Promise<void> {
    // Cheap synchronous refusals first, so a follower never triggers a native
    // catalogue read.
    this.assertOwner();
    this.assertStarted();
    // The catalogue read is a native call that boots host state, so it runs
    // BEFORE the lock is taken, and only when the patch actually moves a model
    // or thinking level: a settings-only no-op must not pay for a bootstrap.
    const catalog = this.patchMovesASelection(roleProfiles)
      ? await this.options.effects.getModelCatalog()
      : [];
    // Validation and the commit own the queue; telling the host runs free.
    const validated = await this.serialize(async () => {
      this.assertOwner();
      this.assertStarted();
      const profiles = this.validateSettingsPatch(roleProfiles, catalog);
      const settings = { ...this.state.settings, roleProfiles: profiles };
      await this.commit(
        this.makeEvent([{ entity: 'settings', op: 'put', id: 'settings', value: settings }]),
      );
      return profiles;
    });
    await this.options.effects.onSettingsUpdated(validated);
  }

  /**
   * Whether a patch changes any role's model or thinking level against the
   * settings as they stand now. Decided from a lock-free read so the catalogue
   * is fetched only when its answer can change the verdict.
   */
  private patchMovesASelection(roleProfiles: Record<string, RoleProfile>): boolean {
    const current = this.readState().settings.roleProfiles;
    return Object.values(roleProfiles).some((profile) => {
      const existing = current[profile.role];
      return (
        !existing ||
        profile.requestedModel !== existing.requestedModel ||
        profile.thinking !== existing.thinking
      );
    });
  }

  /**
   * Refuse a prompt whose attachments no configured model could accept.
   *
   * Checked before the write queue is held, because answering it means reading
   * the model catalogue -- a native call that boots host state and commits
   * through this queue. A prompt with no attachments returns immediately, so
   * the ordinary path never triggers a bootstrap. The check is deliberately
   * coarse (some configured model accepts images); it is a capability floor,
   * not a promise that a specific session's model will take the file.
   */
  private async assertAttachmentsSupported(input: SubmitPromptInput): Promise<void> {
    if (!input.attachments?.length) return;
    const catalog = await this.options.effects.getModelCatalog();
    if (catalog.some((entry) => entry.credentialsConfigured && entry.acceptsImages)) return;
    throw new CompanyError(
      'attachments_unsupported',
      'Không có mô hình nào được cấu hình để nhận tệp đính kèm hình ảnh, nên prompt này không thể được gửi đi.',
    );
  }

  snapshot(): CompanySnapshot {
    const prompts = Object.values(this.state.prompts).map((prompt) => ({
      id: prompt.id,
      preview: prompt.preview,
      createdAt: prompt.createdAt,
      attachments: structuredClone(prompt.attachments ?? []),
      ...(prompt.targetSessionId === undefined
        ? {}
        : { targetSessionId: prompt.targetSessionId }),
    }));
    const sessions = Object.values(this.state.sessions).map((session) => ({
      id: session.id,
      code: session.code,
      name: session.name,
      role: session.role,
      ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
      requestedModel: session.requestedModel,
      ...(session.effectiveModel === undefined ? {} : { effectiveModel: session.effectiveModel }),
      ...(session.agentId === undefined ? {} : { agentId: session.agentId }),
      runEpoch: session.runEpoch,
      status: session.status,
      ...(session.activeTaskId === undefined ? {} : { activeTaskId: session.activeTaskId }),
      lastUsedAt: session.lastUsedAt,
      ...(session.contextSnapshot === undefined
        ? {}
        : { contextSnapshot: projectContextSnapshot(session.contextSnapshot) }),
      ...(session.insight === undefined ? {} : { insight: session.insight }),
    }));
    return {
      revision: this.state.revision,
      settings: structuredClone(this.state.settings),
      prompts,
      contracts: structuredClone(Object.values(this.state.contracts)),
      tasks: structuredClone(Object.values(this.state.tasks)),
      sessions,
      questions: structuredClone(Object.values(this.state.questions)),
      quotas: structuredClone(Object.values(this.state.quotas)),
      attempts: structuredClone(Object.values(this.state.attempts)),
      evidence: structuredClone(Object.values(this.state.evidence)),
      reports: structuredClone(Object.values(this.state.reports)),
      usage: structuredClone(Object.values(this.state.usageIndex).flat()),
    };
  }

  /** Whether this folder's durable state holds a session, task, contract, question or prompt with this id. */
  holdsId(id: string): boolean {
    return (
      Object.hasOwn(this.state.sessions, id) ||
      Object.hasOwn(this.state.tasks, id) ||
      Object.hasOwn(this.state.contracts, id) ||
      Object.hasOwn(this.state.questions, id) ||
      Object.hasOwn(this.state.prompts, id)
    );
  }

  sessionForNative(nativeSessionId: string): string | null {
    const session = Object.values(this.state.sessions).find((candidate) => candidate.nativeSessionId === nativeSessionId);
    return session?.id ?? null;
  }

  sessionFile(sessionId: string): string | undefined {
    return Object.values(this.state.sessions).find((candidate) => candidate.id === sessionId)
      ?.nativeSessionPath;
  }

  diagnostics(): CompanyDiagnostics {
    return this.options.effects.diagnostics();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // A verification still running must not outlive the process that authorized
    // it; an aborted run commits nothing, so shutting down cannot leave a half
    // recorded verdict behind.
    this.abortVerifications();
    await this.writeQueue;

    let failure: unknown;
    try {
      await this.options.effects.dispose();
    } catch (error) {
      failure = error;
    }
    try {
      await this.options.ownership?.release();
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) throw failure;
  }

  /**
   * Validate a settings patch against the CURRENT durable settings and a
   * catalog the caller already fetched.
   *
   * Pure with respect to the coordinator: the catalog arrives as an argument
   * because fetching it is a native call that boots host state, and awaiting it
   * from inside the write queue deadlocks against the very commits the host
   * makes while booting. The caller fetches outside the lock; the comparison
   * against `this.state` happens here, inside the queue, so a selection that
   * changed while the fetch was in flight is still judged against the latest
   * settings rather than a stale snapshot.
   */
  private validateSettingsPatch(
    profiles: Record<string, RoleProfile>,
    catalog: readonly CompanyModelCatalogEntry[],
  ): Record<string, RoleProfile> {
    const keys = Object.keys(profiles).sort();
    if (keys.join(',') !== [...REQUIRED_ROLES].sort().join(',')) {
      throw new CompanyError(
        'invalid_role_profiles',
        'Mỗi vai trò công ty đều cần một hồ sơ, và không được phép có vai trò nào khác.',
      );
    }
    const validated: Record<string, RoleProfile> = {};
    for (const role of REQUIRED_ROLES) {
      const profile = profiles[role];
      const existing = this.state.settings.roleProfiles[role];
      if (!profile || profile.role !== role || profile.toolsPolicy !== ROLE_TOOL_POLICIES[role]) {
        throw new CompanyError(
          'invalid_role_profile',
          `The ${role} profile violates its fixed role policy.`,
        );
      }
      if (!existing || profile.workflowFingerprint !== existing.workflowFingerprint) {
        throw new CompanyError(
          'invalid_role_profile',
          `The ${role} profile cannot replace its workflow fingerprint.`,
        );
      }
      const selected = catalog.find((entry) => entry.id === profile.requestedModel);
      const selectionChanged =
        !existing ||
        profile.requestedModel !== existing.requestedModel ||
        profile.thinking !== existing.thinking;
      if (selectionChanged && (!selected || !selected.credentialsConfigured)) {
        throw new CompanyError(
          'model_unavailable',
          `Model ${profile.requestedModel} is not available with configured credentials.`,
        );
      }
      if (selectionChanged && !selected?.thinking.includes(profile.thinking)) {
        throw new CompanyError(
          'thinking_unavailable',
          `${profile.thinking} thinking is unavailable for ${profile.requestedModel}.`,
        );
      }
      validated[role] = structuredClone(profile);
    }
    return validated;
  }

  private assertActionAvailable(session: CompanySession, action: TransitionAction): void {
    const available: Record<TransitionAction, readonly CompanySession['status'][]> = {
      pause: ['starting', 'idle', 'busy', 'waiting_input'],
      resume: ['paused', 'parked'],
      kill: ['starting', 'idle', 'busy', 'waiting_input', 'pausing', 'stopping', 'crashed'],
      restart: [
        'starting',
        'idle',
        'busy',
        'waiting_input',
        'pausing',
        'stopping',
        'paused',
        'parked',
        'stopped',
        'crashed',
      ],
      archive: ['parked'],
    };
    if (!available[action].includes(session.status)) {
      throw new CompanyError(
        'invalid_session_transition',
        `Cannot ${action} a ${session.status} session.`,
      );
    }
  }

  private assertControlResult(action: TransitionAction, status: CompanySession['status']): void {
    const allowed: Record<TransitionAction, readonly CompanySession['status'][]> = {
      pause: ['pausing', 'paused'],
      resume: ['starting', 'idle', 'busy', 'waiting_input'],
      kill: ['stopped'],
      restart: ['starting', 'idle', 'busy', 'waiting_input'],
      archive: ['archived'],
    };
    if (!allowed[action].includes(status)) {
      throw new CompanyError(
        'session_control_result_invalid',
        `Hành động ${SESSION_ACTION_LABELS[action] ?? action} trả về trạng thái ${SESSION_STATUS_LABELS[status] ?? status} không hợp lệ.`,
      );
    }
  }

  private interruptedRunChanges(
    session: CompanySession,
    action: Extract<CompanySessionAction, 'restart' | 'kill'>,
  ): CompanyChange[] {
    const changes: CompanyChange[] = [];
    const reason =
      action === 'restart' ? 'Phiên đã được khởi động lại bởi người dùng.' : 'Phiên đã bị dừng bởi người dùng.';
    for (const attempt of Object.values(this.state.attempts)) {
      if (
        attempt.sessionId !== session.id ||
        attempt.runEpoch !== session.runEpoch ||
        attempt.status !== 'running'
      )
        continue;
      const interrupted: Attempt = {
        ...attempt,
        status: 'interrupted',
        endedAt: this.now(),
        error: reason,
      };
      changes.push({ entity: 'attempt', op: 'put', id: attempt.id, value: interrupted });
    }
    for (const question of Object.values(this.state.questions)) {
      if (
        question.sessionId !== session.id ||
        question.runEpoch !== session.runEpoch ||
        question.status !== 'pending'
      )
        continue;
      changes.push({
        entity: 'question',
        op: 'put',
        id: question.id,
        value: { ...question, status: 'cancelled' },
      });
    }
    if (session.activeTaskId) {
      const task = this.state.tasks[session.activeTaskId];
      if (task && !['done', 'failed', 'cancelled'].includes(task.status)) {
        const updated: Task = {
          ...task,
          status: action === 'restart' ? 'ready' : 'failed',
          routeReason: [task.routeReason, reason].filter(Boolean).join(' '),
        };
        changes.push({ entity: 'task', op: 'put', id: task.id, value: updated });
      }
    }
    return changes;
  }

  private assertArchivable(session: CompanySession): void {
    if (
      session.status !== 'parked' ||
      session.activeTaskId ||
      this.isTerminalAttached(session.id)
    ) {
      throw new CompanyError(
        'session_not_archivable',
        'Chỉ phiên đang đậu, không có công việc đang chạy hay kết nối terminal, mới có thể được lưu trữ.',
      );
    }
    if (
      Object.values(this.state.questions).some(
        (question) => question.sessionId === session.id && question.status === 'pending',
      )
    ) {
      throw new CompanyError(
        'session_not_archivable',
        'Một phiên đang có câu hỏi chờ trả lời không thể được lưu trữ.',
      );
    }
  }

  /**
   * A parked or ended chat session reopens only on the omp file its record holds.
   * Without one a run would start blank under the old session's name, so the
   * refusal comes before any durable change.
   */
  private assertReopenable(session: CompanySession): void {
    if (session.role !== 'chat' || session.nativeSessionPath !== undefined) return;
    if (REOPENABLE_STATUSES[session.status] !== true) return;
    throw new CompanyError('session_reopen_refused', CHAT_REOPEN_WITHOUT_FILE_MESSAGE);
  }

  private makeEvent(changes: CompanyEvent['changes']): CompanyEvent {
    return {
      id: randomUUID(),
      sequence: this.state.revision + 1,
      baseRevision: this.state.revision,
      at: this.now(),
      changes,
    };
  }

  /**
   * Journal one event and then, by default, tell the host once the queue has
   * drained.
   *
   * The notification is never fired from inside the lock. A dispatcher reacts
   * to an event by issuing the next company command — which is serialized
   * against this very queue — so a synchronous call would wait on the commit
   * that woke it. `suppressed` is the one exception: recovery journals what a
   * crash left behind and must not wake anything at all.
   */
  private async commit(
    event: CompanyEvent,
    dispatch: 'deferred' | 'suppressed' = 'deferred',
  ): Promise<void> {
    const next = applyCompanyEvent(this.state, event);
    await this.options.store.commit(event);
    this.state = next;
    for (const change of event.changes) {
      this.entityRevisions.set(
        WorkspaceCompanyCoordinator.entityKey(change.entity, change.id),
        next.revision,
      );
    }
    if (dispatch === 'suppressed') return;
    void this.writeQueue.then(() => this.notifyStateChanged(event));
  }

  private notifyStateChanged(event: CompanyEvent): void {
    try {
      this.options.effects.onStateChanged(event);
    } catch (error) {
      console.error('[CompanyCoordinator] State notification failed after durable commit.', error);
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(operation);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Kill every in-flight verification run; an aborted run commits nothing. */
  private abortVerifications(): void {
    for (const entry of this.verifications.values()) {
      entry.controller.abort();
    }
  }

  private abortVerificationsOfSession(sessionId: string): void {
    for (const entry of this.verifications.values()) {
      if (entry.sessionId === sessionId) entry.controller.abort();
    }
  }

  private assertOwner(): void {
    this.assertNotDisposed();
    if (!this.options.isOwner()) {
      throw new CompanyError(
        'company_not_owner',
        'Bản thể workspace này chỉ đọc; mọi thay đổi phải được gửi tới chủ sở hữu của nó.',
      );
    }
  }

  private assertStarted(): void {
    if (!this.started)
      throw new CompanyError(
        'company_not_started',
        'Runtime công ty chưa hoàn tất khởi động.',
      );
  }

  private assertNotDisposed(): void {
    if (this.disposed)
      throw new CompanyError('company_disposed', 'Runtime công ty đang tắt.');
  }
}

function projectContextSnapshot(source: Record<string, unknown>): Record<string, number> {
  const projected: Record<string, number> = {};
  for (const [key, value] of Object.entries(source)) {
    if (
      CONTEXT_NUMBER_FIELDS.has(key) &&
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0
    ) {
      projected[key] = value;
    }
  }
  return projected;
}

function normalizeRelativePath(target: string): string {
  // Folding unconditionally is the safe direction: a false conflict costs a
  // scope check, a missed one lets a report claim a file it never touched.
  return target.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function scopeCovers(scope: WriteScope, target: string): boolean {
  const scoped = normalizeRelativePath(scope.path);
  const normalized = normalizeRelativePath(target);
  if (scoped === '' || scoped === '.') return true; // whole workspace
  if (scope.kind === 'file') return normalized === scoped;
  return normalized === scoped || normalized.startsWith(`${scoped}/`);
}
