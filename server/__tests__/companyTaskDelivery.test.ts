/**
 * The Company task delivery state machine: a Worker reports what it changed,
 * QA runs the Contract's own commands, and only a passing Judge closes the
 * task.
 *
 * Everything here runs against a real CompanyStore in a temporary namespace
 * and real child processes (`process.execPath`), so "the evidence is durable"
 * and "the command really exited 0" are observations rather than mocks.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AcceptanceCriterion,
  Attempt,
  CompanyChange,
  CompanyEvent,
  CompanyModelCatalogEntry,
  CompanySession,
  CompanyState,
  Contract,
  Task,
  VerificationProfile,
} from '../../core/src/company.js';
import type {
  CompanySessionAction,
  ReviewerResultInput,
  WorkerTaskResultInput,
  WorkspaceChangeInput,
} from '../src/company/companyCoordinator.js';
import type { CompanyStore as CompanyStoreType } from '../src/company/companyStore.js';
import { UsageLedger } from '../src/company/usageService.js';

let tempHome: string;
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof os>('os');
  return { ...actual, homedir: () => tempHome };
});

// Loaded after the `os` mock: a static import would be hoisted above it and
// CompanyStore would resolve its namespace from the real home directory.
const { CompanyStore } = await import('../src/company/companyStore.js');
const { WorkspaceCompanyCoordinator } = await import('../src/company/companyCoordinatorRuntime.js');

const now = '2026-10-02T00:00:00.000Z';
const NODE = process.execPath;

const CRITERION_ID = 'criterion-tests-pass';
const CONTRACT_ID = 'contract-delivery';
const TASK_ID = 'task-delivery';
const ATTEMPT_ID = 'attempt-delivery';
const WORKER_ID = 'worker-delivery';
const QA_ID = 'qa-delivery';
const JUDGE_ID = 'judge-delivery';
const COMMAND_ID = 'cmd-tests';

/**
 * Wait until `target` appears, driven by the filesystem event that creates it
 * rather than a guessed sleep, so the cancellation case never races a fixed
 * delay.
 *
 * The executor form is unavoidable here: this project's `lib` predates
 * `Promise.withResolvers`, so `resolve` cannot be captured outside the
 * constructor. Re-checking the path keeps it correct where a platform reports
 * a null filename.
 */
function waitForFile(target: string): Promise<void> {
  const watcher = fs.watch(path.dirname(target));
  return new Promise<void>((resolve) => {
    const check = (): void => {
      if (!fs.existsSync(target)) return;
      watcher.close();
      resolve();
    };
    watcher.on('change', check);
    watcher.on('rename', check);
  });
}

function criterion(overrides: Partial<AcceptanceCriterion> = {}): AcceptanceCriterion {
  return {
    id: CRITERION_ID,
    requirementIds: ['req-1'],
    description: 'The bounded Node command exits 0.',
    kind: 'command',
    required: true,
    ...overrides,
  } as AcceptanceCriterion;
}

function verificationProfile(overrides: Partial<VerificationProfile> = {}): VerificationProfile {
  return {
    id: CRITERION_ID,
    criterionIds: [CRITERION_ID],
    commands: [
      {
        id: COMMAND_ID,
        executable: NODE,
        argv: ['-e', 'process.stdout.write("delivery-ok"); process.exit(0)'],
        cwd: 'pkg',
        timeoutSeconds: 30,
      },
    ],
    prerequisites: [],
    outputScopes: [],
    ...overrides,
  } as VerificationProfile;
}

function taskFixture(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    code: 'PA-T0001',
    contractId: CONTRACT_ID,
    phaseId: 'phase-1',
    title: 'Deliver the task',
    requirementIds: ['req-1'],
    dependsOn: [],
    workstreamId: 'main',
    readScopes: [{ path: 'src', kind: 'directory', operations: ['read', 'list', 'search'] }],
    writeScopes: [{ path: 'src', kind: 'directory', operations: ['create', 'modify'] }],
    sharedResources: [],
    acceptance: [CRITERION_ID],
    executionMode: 'session',
    sessionId: WORKER_ID,
    status: 'running',
    attemptIds: [ATTEMPT_ID],
    routeReason: '',
    ...overrides,
  } as Task;
}

function attemptFixture(overrides: Partial<Attempt> = {}): Attempt {
  return {
    id: ATTEMPT_ID,
    taskId: TASK_ID,
    sessionId: WORKER_ID,
    runEpoch: 1,
    startedAt: now,
    status: 'running',
    changes: [],
    evidenceIds: [],
    ...overrides,
  } as Attempt;
}

function roleSession(id: string, role: CompanySession['role'], runEpoch: number): CompanySession {
  return {
    id,
    code: `PA-S-${role}`,
    name: role,
    role,
    workstreamId: 'main',
    workspaceKey: 'workspace-a',
    requestedModel: 'provider/model',
    runEpoch,
    status: 'busy',
    activeTaskId: TASK_ID,
    lastUsedAt: now,
  } as CompanySession;
}

function contractFixture(status: Contract['status'] = 'running'): Contract {
  return {
    id: CONTRACT_ID,
    code: 'PA-C0001',
    revision: 1,
    promptIds: [],
    requirements: [],
    phases: [],
    tasks: [],
    assumptions: [],
    decisions: [],
    acceptance: [criterion()],
    status,
  } as Contract;
}

const modelCatalog: CompanyModelCatalogEntry[] = [
  {
    id: 'provider/model',
    provider: 'provider',
    model: 'model',
    thinking: ['high'],
    acceptsImages: false,
    credentialsConfigured: true,
  },
];

function effects() {
  return {
    getModelCatalog: async () => modelCatalog,
    diagnostics: () => ({
      liveRunners: 0,
      modelLeases: 0,
      nativeJobs: 0,
      queuedTasks: 0,
      pendingQuestions: 0,
      retainedSessions: 0,
      archivedSessions: 0,
      terminalBufferedBytes: 0,
      ownedHandleCount: 0,
      measuredAt: now,
    }),
    onPromptSubmitted: async () => undefined,
    onContractDecision: async () => undefined,
    onQuestionAnswered: async () => undefined,
    controlSession: async (_session: CompanySession, action: CompanySessionAction) => ({
      status: (action === 'pause'
        ? 'paused'
        : action === 'restart'
          ? 'idle'
          : 'stopped') as CompanySession['status'],
    }),
    onSettingsUpdated: async () => undefined,
    onStateChanged: () => undefined,
    recover: async () => undefined,
    dispose: async () => undefined,
  };
}

function workerResult(overrides: Partial<WorkerTaskResultInput> = {}): WorkerTaskResultInput {
  return {
    sessionId: WORKER_ID,
    runEpoch: 1,
    taskId: TASK_ID,
    attemptId: ATTEMPT_ID,
    summary: 'Implemented the delivery slice.',
    changes: [
      { path: 'src/delivery.ts', kind: 'modify', summary: 'Implement the delivery slice.' },
    ] as WorkspaceChangeInput[],
    ...overrides,
  };
}

function qaResult(overrides: Partial<ReviewerResultInput> = {}): ReviewerResultInput {
  return {
    sessionId: QA_ID,
    runEpoch: 2,
    taskId: TASK_ID,
    attemptId: ATTEMPT_ID,
    verdict: 'pass',
    criterionIds: [CRITERION_ID],
    evidenceIds: [],
    notes: ['The approved command exited 0.'],
    ...overrides,
  };
}

function judgeResult(overrides: Partial<ReviewerResultInput> = {}): ReviewerResultInput {
  return {
    sessionId: JUDGE_ID,
    runEpoch: 3,
    taskId: TASK_ID,
    attemptId: ATTEMPT_ID,
    verdict: 'pass',
    criterionIds: [CRITERION_ID],
    evidenceIds: [],
    notes: ['The delivery matches the Contract.'],
    ...overrides,
  };
}

describe('Company task delivery', () => {
  let workspace: string;
  let store: CompanyStoreType;

  beforeEach(async () => {
    tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pxl-company-delivery-'));
    workspace = path.join(tempHome, 'workspace');
    await fs.promises.mkdir(path.join(workspace, 'pkg'), { recursive: true });
    await fs.promises.mkdir(path.join(workspace, 'src'), { recursive: true });
    store = await CompanyStore.open(workspace);
  });

  afterEach(async () => {
    await fs.promises.rm(tempHome, { recursive: true, force: true });
  });

  /** Seed a running task owned by a Worker, with QA and Judge already bound. */
  async function seed(
    options: {
      contractStatus?: Contract['status'];
      profile?: VerificationProfile;
      task?: Task;
      workerTaskId?: string | null;
    } = {},
  ): Promise<CompanyState> {
    let state = await store.load();
    const changes: CompanyChange[] = [
      {
        entity: 'contract',
        op: 'put',
        id: CONTRACT_ID,
        value: contractFixture(options.contractStatus),
      },
      { entity: 'task', op: 'put', id: TASK_ID, value: options.task ?? taskFixture() },
      { entity: 'attempt', op: 'put', id: ATTEMPT_ID, value: attemptFixture() },
      {
        entity: 'session',
        op: 'put',
        id: WORKER_ID,
        value: {
          ...roleSession(WORKER_ID, 'worker', 1),
          ...(options.workerTaskId === undefined
            ? {}
            : options.workerTaskId === null
              ? { activeTaskId: undefined }
              : { activeTaskId: options.workerTaskId }),
        },
      },
      { entity: 'session', op: 'put', id: QA_ID, value: roleSession(QA_ID, 'qa', 2) },
      { entity: 'session', op: 'put', id: JUDGE_ID, value: roleSession(JUDGE_ID, 'judge', 3) },
      {
        entity: 'settings',
        op: 'put',
        id: 'settings',
        value: {
          ...state.settings,
          verificationProfiles: { [CRITERION_ID]: options.profile ?? verificationProfile() },
        },
      },
    ];
    const seedEvent: CompanyEvent = {
      id: randomUUID(),
      sequence: state.revision + 1,
      baseRevision: state.revision,
      at: now,
      changes,
    };
    await store.commit(seedEvent);
    state = await store.load();
    return state;
  }

  async function coordinatorFor(state: CompanyState, overrides: Record<string, unknown> = {}) {
    const coordinator = new WorkspaceCompanyCoordinator({
      store,
      state,
      usageLedger: new UsageLedger(),
      isOwner: () => true,
      now: () => now,
      effects: effects(),
      ...overrides,
    });
    await coordinator.start();
    return coordinator;
  }

  // ── Worker result ─────────────────────────────────────────────────────

  it('rejects a Worker result that is not from the current run, role or active task', async () => {
    const coordinator = await coordinatorFor(await seed());
    await expect(
      coordinator.submitTaskResult(workerResult({ sessionId: QA_ID, runEpoch: 2 })),
    ).rejects.toMatchObject({
      code: 'company_role_forbidden',
    });
    await expect(
      coordinator.submitTaskResult(workerResult({ runEpoch: 99 })),
    ).rejects.toMatchObject({
      code: 'stale_run_epoch',
    });
    await expect(
      coordinator.submitTaskResult(workerResult({ taskId: randomUUID() })),
    ).rejects.toMatchObject({
      code: 'task_not_found',
    });
    await expect(
      coordinator.submitTaskResult(workerResult({ attemptId: randomUUID() })),
    ).rejects.toMatchObject({
      code: 'attempt_not_found',
    });
    const detached = await coordinatorFor(await seed({ workerTaskId: null }));
    await expect(detached.submitTaskResult(workerResult())).rejects.toMatchObject({
      code: 'task_not_active_for_session',
    });
    await detached.dispose();
    expect(coordinator.snapshot().revision).toBe(1);
    await coordinator.dispose();
  });

  it('rejects a Worker result when the Contract is not running', async () => {
    const coordinator = await coordinatorFor(await seed({ contractStatus: 'awaiting_approval' }));
    await expect(coordinator.submitTaskResult(workerResult())).rejects.toMatchObject({
      code: 'contract_not_running',
    });
    await coordinator.dispose();
  });

  it('rejects a changed path outside the workspace, outside the write scopes, or with an undeclared operation', async () => {
    const coordinator = await coordinatorFor(await seed());
    await expect(
      coordinator.submitTaskResult(
        workerResult({ changes: [{ path: '../escape.ts', kind: 'create', summary: 'escape' }] }),
      ),
    ).rejects.toMatchObject({ code: 'change_path_outside_workspace' });
    await expect(
      coordinator.submitTaskResult(
        workerResult({
          changes: [
            { path: path.join(workspace, 'src', 'abs.ts'), kind: 'create', summary: 'absolute' },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'change_path_not_relative' });
    await expect(
      coordinator.submitTaskResult(
        workerResult({ changes: [{ path: 'docs/readme.md', kind: 'create', summary: 'outside' }] }),
      ),
    ).rejects.toMatchObject({ code: 'change_outside_write_scope' });
    await expect(
      coordinator.submitTaskResult(
        workerResult({ changes: [{ path: 'src/delivery.ts', kind: 'delete', summary: 'delete' }] }),
      ),
    ).rejects.toMatchObject({ code: 'change_operation_not_allowed' });
    expect(coordinator.snapshot().revision).toBe(1);
    await coordinator.dispose();
  });

  it('rejects a referenced diff artifact that was never stored', async () => {
    const coordinator = await coordinatorFor(await seed());
    await expect(
      coordinator.submitTaskResult(
        workerResult({
          changes: [
            {
              path: 'src/delivery.ts',
              kind: 'modify',
              summary: 'Implement the delivery slice.',
              diffArtifactId: randomUUID(),
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'change_artifact_not_found' });
    await coordinator.dispose();
  });

  it('accepts a Worker result once, persists the changes and moves the task to verifying', async () => {
    const coordinator = await coordinatorFor(await seed());
    const diffArtifactId = await store.writeArtifact(Buffer.from('diff', 'utf8'), 'text/plain');
    const result = await coordinator.submitTaskResult(
      workerResult({
        changes: [
          {
            path: 'src/delivery.ts',
            kind: 'create',
            summary: 'Add the delivery slice.',
            diffArtifactId,
          },
        ],
      }),
    );

    expect(result.taskStatus).toBe('verifying');
    expect(result.attemptId).toBe(ATTEMPT_ID);
    expect(result.changes).toHaveLength(1);
    expect(result.revision).toBe(2);

    const persisted = await store.load();
    expect(persisted.tasks[TASK_ID]?.status).toBe('verifying');
    expect(persisted.attempts[ATTEMPT_ID]?.changes).toEqual([
      {
        path: 'src/delivery.ts',
        kind: 'create',
        summary: 'Add the delivery slice.',
        diffArtifactId,
      },
    ]);

    // The assignment is released in the SAME event that accepts the result, so
    // the second submission is refused on authorization rather than on state.
    expect(persisted.sessions[WORKER_ID]?.activeTaskId).toBeUndefined();
    await expect(coordinator.submitTaskResult(workerResult())).rejects.toMatchObject({
      code: 'task_not_active_for_session',
    });
    expect((await store.load()).attempts[ATTEMPT_ID]?.changes).toHaveLength(1);
    await coordinator.dispose();
  });

  // ── company_verify ────────────────────────────────────────────────────

  it('runs an approved verification command and commits its evidence against the live attempt', async () => {
    const coordinator = await coordinatorFor(await seed());
    await coordinator.submitTaskResult(workerResult());

    const outcome = await coordinator.verifyTask({
      sessionId: QA_ID,
      runEpoch: 2,
      taskId: TASK_ID,
      attemptId: ATTEMPT_ID,
      commandId: COMMAND_ID,
    });

    expect(outcome.status).toBe('passed');
    expect(outcome.exitCode).toBe(0);
    expect(outcome.criterionIds).toEqual([CRITERION_ID]);

    const persisted = await store.load();
    expect(persisted.evidence[outcome.evidenceId]).toMatchObject({ exitCode: 0 });
    expect(persisted.attempts[ATTEMPT_ID]?.evidenceIds).toContain(outcome.evidenceId);
    // The command's stdout is stored BEFORE the evidence claims it exists.
    const page = await store.readArtifact(
      persisted.evidence[outcome.evidenceId]!.stdoutArtifactId!,
      0,
      4096,
    );
    expect(Buffer.from(page.dataBase64, 'base64').toString('utf8')).toBe('delivery-ok');
    await coordinator.dispose();
  });

  it('refuses to run any command the approved Contract did not approve', async () => {
    const coordinator = await coordinatorFor(await seed());
    await coordinator.submitTaskResult(workerResult());
    await expect(
      coordinator.verifyTask({
        sessionId: QA_ID,
        runEpoch: 2,
        taskId: TASK_ID,
        attemptId: ATTEMPT_ID,
        commandId: 'cmd-not-in-the-contract',
      }),
    ).rejects.toMatchObject({ code: 'verification_command_not_approved' });
    // A Worker may not borrow the verification tool.
    await expect(
      coordinator.verifyTask({
        sessionId: WORKER_ID,
        runEpoch: 1,
        taskId: TASK_ID,
        attemptId: ATTEMPT_ID,
        commandId: COMMAND_ID,
      }),
    ).rejects.toMatchObject({ code: 'company_role_forbidden' });
    expect(Object.keys((await store.load()).evidence)).toHaveLength(0);
    await coordinator.dispose();
  });

  it('blocks instead of running when a declared prerequisite cannot be checked', async () => {
    const coordinator = await coordinatorFor(
      await seed({ profile: verificationProfile({ prerequisites: ['database is up'] }) }),
    );
    await coordinator.submitTaskResult(workerResult());

    await expect(
      coordinator.verifyTask({
        sessionId: QA_ID,
        runEpoch: 2,
        taskId: TASK_ID,
        attemptId: ATTEMPT_ID,
        commandId: COMMAND_ID,
      }),
    ).rejects.toMatchObject({ code: 'verification_prerequisites_uncheckable' });
    expect(Object.keys((await store.load()).evidence)).toHaveLength(0);

    const checked = await coordinatorFor(await store.load(), {
      checkPrerequisite: async (prerequisite: string) => `${prerequisite} is missing`,
    });
    await expect(
      checked.verifyTask({
        sessionId: QA_ID,
        runEpoch: 2,
        taskId: TASK_ID,
        attemptId: ATTEMPT_ID,
        commandId: COMMAND_ID,
      }),
    ).rejects.toMatchObject({ code: 'verification_prerequisite_unmet' });
    expect(Object.keys((await store.load()).evidence)).toHaveLength(0);
    await coordinator.dispose();
    await checked.dispose();
  });

  it('records a failing command as failed evidence that cannot pass QA', async () => {
    const coordinator = await coordinatorFor(
      await seed({
        profile: verificationProfile({
          commands: [
            {
              id: COMMAND_ID,
              executable: NODE,
              argv: ['-e', 'process.exit(3)'],
              cwd: 'pkg',
              timeoutSeconds: 30,
            },
          ],
        }),
      }),
    );
    await coordinator.submitTaskResult(workerResult());
    const outcome = await coordinator.verifyTask({
      sessionId: QA_ID,
      runEpoch: 2,
      taskId: TASK_ID,
      attemptId: ATTEMPT_ID,
      commandId: COMMAND_ID,
    });
    expect(outcome.status).toBe('failed');
    await expect(
      coordinator.submitQaResult(qaResult({ evidenceIds: [outcome.evidenceId] })),
    ).rejects.toMatchObject({ code: 'qa_evidence_incomplete' });
    await coordinator.dispose();
  });

  it('drops an in-flight verification when the QA session is killed, and commits no evidence', async () => {
    const coordinator = await coordinatorFor(
      await seed({
        profile: verificationProfile({
          commands: [
            {
              id: COMMAND_ID,
              executable: NODE,
              argv: [
                '-e',
                "require('node:fs').writeFileSync('started.marker', '1'); setTimeout(() => {}, 60000)",
              ],
              cwd: 'pkg',
              timeoutSeconds: 30,
            },
          ],
        }),
      }),
    );
    await coordinator.submitTaskResult(workerResult());
    const running = coordinator.verifyTask({
      sessionId: QA_ID,
      runEpoch: 2,
      taskId: TASK_ID,
      attemptId: ATTEMPT_ID,
      commandId: COMMAND_ID,
    });
    // The command proves it actually started before the kill lands, so this
    // observes the cancellation rather than guessing at a delay.
    await waitForFile(path.join(workspace, 'pkg', 'started.marker'));
    await coordinator.controlSession(QA_ID, 'kill', 2);

    await expect(running).rejects.toMatchObject({ code: 'verification_cancelled' });
    expect(Object.keys((await store.load()).evidence)).toHaveLength(0);
    await coordinator.dispose();
  });

  // ── QA ────────────────────────────────────────────────────────────────

  it('refuses a QA pass that is not backed by the attempt evidence', async () => {
    const coordinator = await coordinatorFor(await seed());
    await coordinator.submitTaskResult(workerResult());

    await expect(
      coordinator.submitQaResult(qaResult({ evidenceIds: [randomUUID()] })),
    ).rejects.toMatchObject({
      code: 'qa_evidence_unknown',
    });
    await expect(
      coordinator.submitQaResult(qaResult({ criterionIds: ['criterion-unknown'] })),
    ).rejects.toMatchObject({
      code: 'qa_criterion_unknown',
    });
    await expect(coordinator.submitQaResult(qaResult({ evidenceIds: [] }))).rejects.toMatchObject({
      code: 'qa_evidence_incomplete',
    });
    await expect(
      coordinator.submitQaResult(qaResult({ sessionId: WORKER_ID, runEpoch: 1 })),
    ).rejects.toMatchObject({ code: 'company_role_forbidden' });
    expect((await store.load()).attempts[ATTEMPT_ID]?.qaVerdict).toBeUndefined();
    await coordinator.dispose();
  });

  it('routes a failing QA verdict to a bounded repair and never to done', async () => {
    const coordinator = await coordinatorFor(await seed());
    await coordinator.submitTaskResult(workerResult());
    const outcome = await coordinator.verifyTask({
      sessionId: QA_ID,
      runEpoch: 2,
      taskId: TASK_ID,
      attemptId: ATTEMPT_ID,
      commandId: COMMAND_ID,
    });

    const failed = await coordinator.submitQaResult(
      qaResult({ verdict: 'fail', evidenceIds: [outcome.evidenceId], notes: ['Wrong shape.'] }),
    );
    expect(failed.taskStatus).toBe('changes_requested');
    expect(failed.attemptStatus).toBe('failed');
    expect((await store.load()).attempts[ATTEMPT_ID]?.qaVerdict).toMatchObject({ verdict: 'fail' });
    await coordinator.dispose();
  });

  it('fails the task outright once the automatic repair budget is spent', async () => {
    const exhausted = taskFixture({
      attemptIds: ['attempt-a', 'attempt-b', ATTEMPT_ID],
      status: 'verifying',
    });
    const coordinator = await coordinatorFor(await seed({ task: exhausted }));
    const failed = await coordinator.submitQaResult(qaResult({ verdict: 'fail', evidenceIds: [] }));
    expect(failed.taskStatus).toBe('failed');
    await coordinator.dispose();
  });

  // ── Judge ─────────────────────────────────────────────────────────────

  it('finalizes the attempt and the task only on a passing Judge verdict', async () => {
    const coordinator = await coordinatorFor(await seed());
    await coordinator.submitTaskResult(workerResult());

    await expect(coordinator.submitJudgeResult(judgeResult())).rejects.toMatchObject({
      code: 'judge_requires_qa_pass',
    });

    const outcome = await coordinator.verifyTask({
      sessionId: QA_ID,
      runEpoch: 2,
      taskId: TASK_ID,
      attemptId: ATTEMPT_ID,
      commandId: COMMAND_ID,
    });
    await expect(coordinator.submitJudgeResult(judgeResult())).rejects.toMatchObject({
      code: 'judge_requires_qa_pass',
    });

    const passed = await coordinator.submitQaResult(
      qaResult({ evidenceIds: [outcome.evidenceId] }),
    );
    expect(passed.taskStatus).toBe('verifying');
    expect(passed.attemptStatus).toBe('running');

    // A second QA answer is refused; the first one is not merged. Its assignment
    // was released with the verdict, so the refusal is on authorization.
    expect((await store.load()).sessions[QA_ID]?.activeTaskId).toBeUndefined();
    await expect(
      coordinator.submitQaResult(qaResult({ evidenceIds: [outcome.evidenceId] })),
    ).rejects.toMatchObject({ code: 'task_not_active_for_session' });

    const judged = await coordinator.submitJudgeResult(
      judgeResult({ evidenceIds: [outcome.evidenceId] }),
    );
    expect(judged.taskStatus).toBe('done');
    expect(judged.attemptStatus).toBe('passed');

    const persisted = await store.load();
    expect(persisted.tasks[TASK_ID]?.status).toBe('done');
    expect(persisted.attempts[ATTEMPT_ID]).toMatchObject({
      status: 'passed',
      qaVerdict: { verdict: 'pass', sessionId: QA_ID, runEpoch: 2 },
      judgeVerdict: { verdict: 'pass', sessionId: JUDGE_ID, runEpoch: 3 },
    });
    expect(persisted.attempts[ATTEMPT_ID]?.endedAt).toBe(now);
    expect(persisted.sessions[JUDGE_ID]?.activeTaskId).toBeUndefined();
    await coordinator.dispose();
  });

  it('rejects out-of-order, stale-epoch and wrong-role verdicts', async () => {
    const coordinator = await coordinatorFor(await seed());
    await coordinator.submitTaskResult(workerResult());
    const outcome = await coordinator.verifyTask({
      sessionId: QA_ID,
      runEpoch: 2,
      taskId: TASK_ID,
      attemptId: ATTEMPT_ID,
      commandId: COMMAND_ID,
    });

    await expect(coordinator.submitQaResult(qaResult({ runEpoch: 41 }))).rejects.toMatchObject({
      code: 'stale_run_epoch',
    });
    await expect(
      coordinator.submitQaResult(qaResult({ sessionId: JUDGE_ID, runEpoch: 3 })),
    ).rejects.toMatchObject({ code: 'company_role_forbidden' });

    await coordinator.submitQaResult(qaResult({ evidenceIds: [outcome.evidenceId] }));
    await expect(
      coordinator.submitJudgeResult(
        judgeResult({ runEpoch: 41, evidenceIds: [outcome.evidenceId] }),
      ),
    ).rejects.toMatchObject({ code: 'stale_run_epoch' });
    await expect(
      coordinator.submitJudgeResult(
        judgeResult({ sessionId: WORKER_ID, runEpoch: 1, evidenceIds: [outcome.evidenceId] }),
      ),
    ).rejects.toMatchObject({ code: 'company_role_forbidden' });
    await expect(
      coordinator.submitJudgeResult(judgeResult({ evidenceIds: [randomUUID()] })),
    ).rejects.toMatchObject({ code: 'judge_evidence_unknown' });
    expect((await store.load()).tasks[TASK_ID]?.status).toBe('verifying');
    await coordinator.dispose();
  });

  it('survives a restart with the verified attempt intact', async () => {
    const coordinator = await coordinatorFor(await seed());
    await coordinator.submitTaskResult(workerResult());
    const outcome = await coordinator.verifyTask({
      sessionId: QA_ID,
      runEpoch: 2,
      taskId: TASK_ID,
      attemptId: ATTEMPT_ID,
      commandId: COMMAND_ID,
    });
    await coordinator.submitQaResult(qaResult({ evidenceIds: [outcome.evidenceId] }));
    await coordinator.dispose();

    const reopened = await coordinatorFor(await store.load());
    const judged = await reopened.submitJudgeResult(
      judgeResult({ evidenceIds: [outcome.evidenceId] }),
    );
    expect(judged.taskStatus).toBe('done');
    await reopened.dispose();
  });

  // ── Internal host hooks ───────────────────────────────────────────────

  it('hands the runtime a detached copy of the state and never the live one', async () => {
    const coordinator = await coordinatorFor(await seed());
    const snapshot = coordinator.readState();
    snapshot.tasks[TASK_ID]!.status = 'done';
    expect(coordinator.readState().tasks[TASK_ID]?.status).toBe('running');
    await coordinator.dispose();
  });

  it('journals runtime changes atomically and refuses a stale base revision', async () => {
    const coordinator = await coordinatorFor(await seed());
    const base = coordinator.readState().revision;
    const attached = roleSession(WORKER_ID, 'worker', 1);
    await coordinator.commitRuntimeChanges(
      [
        {
          entity: 'session',
          op: 'put',
          id: WORKER_ID,
          value: { ...attached, nativeSessionId: 'native-1', agentId: 7 },
        },
      ],
      base,
    );

    const persisted = await store.load();
    expect(persisted.revision).toBe(base + 1);
    expect(persisted.sessions[WORKER_ID]).toMatchObject({
      nativeSessionId: 'native-1',
      agentId: 7,
    });
    // The projection carries the office character id but never the live handle.
    expect(coordinator.snapshot().sessions.find((entry) => entry.id === WORKER_ID)).toMatchObject({
      agentId: 7,
    });
    expect(JSON.stringify(coordinator.snapshot())).not.toContain('native-1');

    await expect(
      coordinator.commitRuntimeChanges(
        [{ entity: 'session', op: 'put', id: WORKER_ID, value: attached }],
        base,
      ),
    ).rejects.toMatchObject({ code: 'company_revision_conflict' });
    expect((await store.load()).revision).toBe(base + 1);
    await coordinator.dispose();
  });
});
