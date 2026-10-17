import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  Attempt,
  CompanyChange,
  CompanyEvent,
  CompanyModelCatalogEntry,
  CompanySession,
  CompanyState,
  Contract,
  Question,
  SubmitPromptInput,
} from '../../core/src/company.js';
import type { CompanySessionAction } from '../src/company/companyCoordinator.js';
import { applyCompanyEvent } from '../src/company/companyState.js';
import type { CompanyStore as CompanyStoreType } from '../src/company/companyStore.js';
import type { ContractDraftProposal } from '../src/company/contractDraft.js';
import { UsageLedger } from '../src/company/usageService.js';

let tempHome: string;
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof os>('os');
  return { ...actual, homedir: () => tempHome };
});

const { CompanyStore } = await import('../src/company/companyStore.js');
const { CompanyOwnershipError, WorkspaceCompanyCoordinator } =
  await import('../src/company/companyCoordinatorRuntime.js');

const now = '2026-10-02T00:00:00.000Z';

function event(state: CompanyState, change: CompanyChange): CompanyEvent {
  return {
    id: randomUUID(),
    sequence: state.revision + 1,
    baseRevision: state.revision,
    at: now,
    changes: [change],
  };
}

function contract(id: string, status: Contract['status'] = 'awaiting_approval'): Contract {
  return {
    id,
    code: 'PA-C0001',
    revision: 2,
    promptIds: [],
    requirements: [],
    phases: [],
    tasks: [],
    assumptions: [],
    decisions: [],
    acceptance: [],
    status,
  };
}

function session(id: string, runEpoch = 0): CompanySession {
  return {
    id,
    code: 'PA-S0001',
    name: 'Worker 1',
    role: 'worker',
    workstreamId: 'stream-a',
    workspaceKey: 'workspace-a',
    requestedModel: 'provider/model',
    runEpoch,
    status: 'idle',
    lastUsedAt: now,
  };
}

const modelCatalog: CompanyModelCatalogEntry[] = [
  {
    id: 'provider/model',
    provider: 'provider',
    model: 'model',
    thinking: ['high', 'medium'],
    acceptsImages: false,
    credentialsConfigured: true,
  },
];

function effects(
  overrides: Partial<ConstructorParameters<typeof WorkspaceCompanyCoordinator>[0]['effects']> = {},
) {
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
    ...overrides,
  };
}

describe('WorkspaceCompanyCoordinator', () => {
  let workspace: string;

  beforeEach(async () => {
    tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pxl-company-coordinator-'));
    workspace = path.join(tempHome, 'workspace');
    await fs.promises.mkdir(workspace);
  });

  afterEach(async () => {
    await fs.promises.rm(tempHome, { recursive: true, force: true });
  });

  it('durably stores the raw prompt artifact before notifying the scheduler and projects only a bounded preview', async () => {
    const store = await CompanyStore.open(workspace);
    const state = await store.load();
    let coordinator!: InstanceType<typeof WorkspaceCompanyCoordinator>;
    const submitted: string[] = [];
    coordinator = new WorkspaceCompanyCoordinator({
      store,
      state,
      usageLedger: new UsageLedger(),
      isOwner: () => true,
      now: () => now,
      effects: effects({
        onPromptSubmitted: async (prompt) => {
          const artifact = await store.readArtifact(prompt.rawTextArtifactId, 0, 10_000);
          submitted.push(Buffer.from(artifact.dataBase64, 'base64').toString('utf8'));
          expect(coordinator.snapshot().revision).toBe(1);
        },
      }),
    });
    await coordinator.start();
    const text = `Implement a detailed feature ${'important '.repeat(40)}PRIVATE-PROMPT-TAIL`;
    const input: SubmitPromptInput = { requestId: randomUUID(), text, delivery: 'prompt' };

    const prompt = await coordinator.submitPrompt(input);
    const snapshot = coordinator.snapshot();
    expect(submitted).toEqual([text]);
    expect(prompt.rawTextArtifactId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(snapshot.prompts[0]?.preview).not.toBe(text);
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE-PROMPT-TAIL');
    expect(snapshot.revision).toBe(1);
    await coordinator.dispose();
  });
  it('accepts a Director draft for a tracked prompt and commits its task DAG', async () => {
    const store = await CompanyStore.open(workspace);
    let state = await store.load();
    const director = {
      ...session('director-draft'),
      role: 'director' as const,
      name: 'Director',
      status: 'busy' as const,
    };
    const seed = event(state, {
      entity: 'session',
      op: 'put',
      id: director.id,
      value: director,
    });
    await store.commit(seed);
    state = applyCompanyEvent(state, seed);
    // The workspace's discovered check: the only thing that can prove a task done.
    const profiles = event(state, {
      entity: 'settings',
      op: 'put',
      id: 'settings',
      value: {
        ...state.settings,
        verificationProfiles: {
          test: {
            id: 'test',
            criterionIds: [],
            commands: [
              { id: 'test:test', executable: 'npm', argv: ['test'], cwd: '.', timeoutSeconds: 600 },
            ],
            prerequisites: [],
            outputScopes: [],
          },
        },
      },
    });
    await store.commit(profiles);
    state = applyCompanyEvent(state, profiles);
    const coordinator = new WorkspaceCompanyCoordinator({
      store,
      state,
      usageLedger: new UsageLedger(),
      isOwner: () => true,
      now: () => now,
      effects: effects(),
    });
    await coordinator.start();
    const prompt = await coordinator.submitPrompt({
      requestId: randomUUID(),
      text: 'Implement the result view.',
      delivery: 'prompt',
    });
    const requirementId = randomUUID();
    const criterionId = randomUUID();
    const phaseId = randomUUID();
    const taskId = randomUUID();
    const proposal: ContractDraftProposal = {
      title: 'Result view',
      summary: 'Implement the requested result view.',
      requirements: [
        {
          id: requirementId,
          promptId: prompt.id,
          fragmentIds: [prompt.fragments![0]!.id],
          text: 'Implement the result view.',
          kind: 'goal',
          status: 'planned',
        },
      ],
      phases: [
        {
          id: phaseId,
          title: 'Implementation',
          ordinal: 0,
          taskIds: [taskId],
          acceptanceIds: [criterionId],
        },
      ],
      tasks: [
        {
          id: taskId,
          phaseId,
          title: 'Implement result view',
          requirementIds: [requirementId],
          dependsOn: [],
          workstreamId: 'main',
          readScopes: [{ path: 'src', kind: 'directory', operations: ['read', 'list', 'search'] }],
          writeScopes: [{ path: 'src/result.ts', kind: 'file', operations: ['create', 'modify'] }],
          sharedResources: [],
          acceptance: [criterionId],
          executionMode: 'session',
          routeReason: 'The feature requires one coding task.',
        },
      ],
      assumptions: [],
      decisions: [],
      acceptance: [
        {
          id: criterionId,
          requirementIds: [requirementId],
          description: 'The result view tests pass.',
          kind: 'command',
          required: true,
        },
      ],
      verificationProfiles: { [criterionId]: { profileId: 'test' } },
    };

    await coordinator.submitContractDraft({
      sessionId: director.id,
      runEpoch: director.runEpoch,
      promptId: prompt.id,
      proposal,
    });
    expect(coordinator.snapshot().contracts[0]).toMatchObject({
      promptIds: [prompt.id],
      revision: 1,
      status: 'architecture_review',
      requirements: [{ id: requirementId }],
    });
    expect(coordinator.snapshot().tasks[0]).toMatchObject({
      title: 'Implement result view',
      status: 'planned',
      contractId: coordinator.snapshot().contracts[0]?.id,
    });
    await coordinator.dispose();
  });

  it('rejects stale Contract decisions and records an explicit rejection of the current revision', async () => {
    const store = await CompanyStore.open(workspace);
    let state = await store.load();
    const current = contract('contract-a');
    const seed = event(state, { entity: 'contract', op: 'put', id: current.id, value: current });
    await store.commit(seed);
    state = applyCompanyEvent(state, seed);
    const coordinator = new WorkspaceCompanyCoordinator({
      store,
      state,
      usageLedger: new UsageLedger(),
      isOwner: () => true,
      now: () => now,
      effects: effects(),
    });
    await coordinator.start();

    await expect(coordinator.decideContract(current.id, 1, 'reject')).rejects.toMatchObject({
      code: 'company_revision_conflict',
    });
    await coordinator.decideContract(current.id, 2, 'reject', 'The architecture needs a new plan.');
    expect(coordinator.snapshot().contracts[0]?.status).toBe('cancelled');
    expect(coordinator.snapshot().contracts[0]?.decisions).toContain(
      'The architecture needs a new plan.',
    );
    await coordinator.dispose();
  });

  it('persists an answer once before resuming the native question and rejects duplicate answers', async () => {
    const store = await CompanyStore.open(workspace);
    let state = await store.load();
    const question: Question = {
      id: 'question-a',
      sessionId: 'session-a',
      runEpoch: 3,
      kind: 'technical_choice',
      title: 'Choose storage',
      questions: [{ id: 'q1', question: 'Which store?', options: [{ label: 'SQLite' }] }],
      actionDigest: 'digest-a',
      status: 'pending',
      createdAt: now,
    };
    const seed = event(state, { entity: 'question', op: 'put', id: question.id, value: question });
    await store.commit(seed);
    state = applyCompanyEvent(state, seed);
    const resumed: string[] = [];
    const coordinator = new WorkspaceCompanyCoordinator({
      store,
      state,
      usageLedger: new UsageLedger(),
      isOwner: () => true,
      now: () => now,
      effects: effects({
        onQuestionAnswered: async (answered) => {
          resumed.push(answered.id);
          expect(coordinator.snapshot().questions[0]?.status).toBe('answered');
          // A native resume persists the session it is about to re-enter. It
          // runs with no lock held, so committing from here must not deadlock.
          await coordinator.commitRuntimeChanges(
            [
              {
                entity: 'counters',
                op: 'put',
                id: 'counters',
                value: { session: 1, task: 1, contract: 1 },
              },
            ],
            coordinator.readState().revision,
          );
        },
      }),
    });
    await coordinator.start();
    const answer = {
      requestId: randomUUID(),
      questionId: question.id,
      runEpoch: question.runEpoch,
      actionDigest: question.actionDigest,
      answers: { q1: { selectedIndices: [0], isOther: false } },
    };

    await coordinator.answerQuestion(answer);
    await expect(
      coordinator.answerQuestion({ ...answer, requestId: randomUUID() }),
    ).rejects.toMatchObject({
      code: 'question_not_pending',
    });
    expect(resumed).toEqual([question.id]);
    await coordinator.dispose();
  });

  it('records an architecture review only from the current Advisor run', async () => {
    const store = await CompanyStore.open(workspace);
    let state = await store.load();
    const draft = contract('contract-review', 'architecture_review');
    const director = {
      ...session('director-a'),
      role: 'director' as const,
      name: 'Director',
      status: 'busy' as const,
    };
    const advisor = {
      ...session('advisor-a'),
      role: 'advisor' as const,
      name: 'Advisor',
      status: 'busy' as const,
    };
    const seed = {
      ...event(state, { entity: 'contract', op: 'put', id: draft.id, value: draft }),
      changes: [
        { entity: 'contract' as const, op: 'put' as const, id: draft.id, value: draft },
        { entity: 'session' as const, op: 'put' as const, id: director.id, value: director },
        { entity: 'session' as const, op: 'put' as const, id: advisor.id, value: advisor },
      ],
    };
    await store.commit(seed);
    state = applyCompanyEvent(state, seed);
    const coordinator = new WorkspaceCompanyCoordinator({
      store,
      state,
      usageLedger: new UsageLedger(),
      isOwner: () => true,
      now: () => now,
      effects: effects(),
    });
    await coordinator.start();

    const review = {
      contractId: draft.id,
      revision: draft.revision,
      verdict: 'approve' as const,
      issues: [],
      advisorNotes: ['Reviewed the affected interfaces and found no blockers.'],
    };
    await expect(
      coordinator.submitArchitectureReview({
        ...review,
        sessionId: director.id,
        runEpoch: director.runEpoch,
      }),
    ).rejects.toMatchObject({ code: 'company_role_forbidden' });
    await expect(
      coordinator.submitArchitectureReview({
        ...review,
        sessionId: advisor.id,
        runEpoch: advisor.runEpoch + 1,
      }),
    ).rejects.toMatchObject({ code: 'stale_run_epoch' });

    await coordinator.submitArchitectureReview({
      ...review,
      sessionId: advisor.id,
      runEpoch: advisor.runEpoch,
    });
    expect(coordinator.snapshot().contracts[0]).toMatchObject({
      id: draft.id,
      revision: draft.revision,
      status: 'awaiting_approval',
      architectureReviews: [{ revision: draft.revision, verdict: 'approve' }],
    });
    await coordinator.dispose();
  });

  it('starts a new usage epoch on restart and finishes the session from the runtime result', async () => {
    const store = await CompanyStore.open(workspace);
    let state = await store.load();
    const initial = session('session-a', 4);
    const seed = event(state, { entity: 'session', op: 'put', id: initial.id, value: initial });
    await store.commit(seed);
    state = applyCompanyEvent(state, seed);
    const usage = new UsageLedger();
    const actions: number[] = [];
    const coordinator = new WorkspaceCompanyCoordinator({
      store,
      state,
      usageLedger: usage,
      isOwner: () => true,
      now: () => now,
      effects: effects({
        controlSession: async (_record, action, epoch) => {
          actions.push(epoch);
          return { status: action === 'restart' ? 'idle' : 'stopped' };
        },
      }),
    });
    await coordinator.start();

    await coordinator.controlSession(initial.id, 'restart', 4);
    expect(actions).toEqual([5]);
    expect(usage.currentRunEpoch(initial.id)).toBe(5);
    expect(coordinator.snapshot().sessions[0]).toMatchObject({ runEpoch: 5, status: 'idle' });
    await expect(coordinator.controlSession(initial.id, 'kill', 4)).rejects.toMatchObject({
      code: 'stale_run_epoch',
    });
    await coordinator.controlSession(initial.id, 'kill', 5);
    expect(actions).toEqual([5, 6]);
    expect(usage.currentRunEpoch(initial.id)).toBe(6);
    expect(coordinator.snapshot().sessions[0]).toMatchObject({ runEpoch: 6, status: 'stopped' });
    await coordinator.dispose();
  });

  it('fails closed for followers and rejects unavailable model selections without committing settings', async () => {
    const store = await CompanyStore.open(workspace);
    const state = await store.load();
    let owner = false;
    const coordinator = new WorkspaceCompanyCoordinator({
      store,
      state,
      usageLedger: new UsageLedger(),
      isOwner: () => owner,
      now: () => now,
      effects: effects(),
    });
    await coordinator.start();

    await expect(
      coordinator.submitPrompt({ requestId: randomUUID(), text: 'do work', delivery: 'prompt' }),
    ).rejects.toMatchObject({ code: 'company_not_owner' });
    owner = true;
    await expect(
      coordinator.updateSettings({
        ...state.settings.roleProfiles,
        worker: { ...state.settings.roleProfiles.worker!, requestedModel: 'provider/unavailable' },
      }),
    ).rejects.toMatchObject({ code: 'model_unavailable' });
    expect(coordinator.snapshot().revision).toBe(0);
    await coordinator.dispose();
  });

  it('lets the host reconcile a crashed run during recovery without opening the public surface', async () => {
    const store = await CompanyStore.open(workspace);
    let state = await store.load();
    const crashed = { ...session('worker-restored'), activeTaskId: 'task-restored' };
    const running: Attempt = {
      id: 'attempt-restored',
      taskId: 'task-restored',
      sessionId: crashed.id,
      runEpoch: crashed.runEpoch,
      startedAt: now,
      status: 'running',
      changes: [],
      evidenceIds: [],
    };
    const seedEvent = {
      ...event(state, { entity: 'attempt', op: 'put', id: running.id, value: running }),
      changes: [
        { entity: 'session' as const, op: 'put' as const, id: crashed.id, value: crashed },
        { entity: 'attempt' as const, op: 'put' as const, id: running.id, value: running },
      ],
    };
    await store.commit(seedEvent);
    state = applyCompanyEvent(state, seedEvent);

    const dispatched: number[] = [];
    const prompts: string[] = [];
    let publicRejection: string | undefined;
    let coordinator!: InstanceType<typeof WorkspaceCompanyCoordinator>;
    coordinator = new WorkspaceCompanyCoordinator({
      store,
      state,
      usageLedger: new UsageLedger(),
      isOwner: () => true,
      now: () => now,
      effects: effects({
        onStateChanged: (committed) => {
          dispatched.push(committed.sequence);
        },
        onPromptSubmitted: async (prompt) => {
          prompts.push(prompt.id);
        },
        recover: async (recovered) => {
          await coordinator.commitRuntimeChanges(
            Object.values(recovered.attempts)
              .filter((attempt) => attempt.status === 'running')
              .map((attempt) => ({
                entity: 'attempt' as const,
                op: 'put' as const,
                id: attempt.id,
                value: {
                  ...attempt,
                  status: 'interrupted' as const,
                  endedAt: now,
                  error: 'Interrupted by a host restart.',
                },
              })),
            recovered.revision,
          );
          await coordinator
            .submitPrompt({ requestId: randomUUID(), text: 'do work', delivery: 'prompt' })
            .then(
              () => undefined,
              (error: { code?: string }) => {
                publicRejection = error.code;
              },
            );
        },
      }),
    });

    await coordinator.start();

    // A crash leaves nothing "running" behind, and the fix is durable.
    expect((await store.load()).attempts[running.id]).toMatchObject({
      status: 'interrupted',
      endedAt: now,
    });
    // Reconciling the past dispatched nothing and started no work of its own.
    expect(publicRejection).toBe('company_not_started');
    expect(dispatched).toEqual([]);
    expect(prompts).toEqual([]);
    // The public surface is open only once startup actually finished.
    await expect(
      coordinator.submitPrompt({ requestId: randomUUID(), text: 'do work', delivery: 'prompt' }),
    ).resolves.toBeTruthy();
    await coordinator.dispose();
  });

  // ── Ownership gate for destructive controls ───────────────────────────

  async function seedLiveRun(): Promise<{ store: CompanyStoreType; state: CompanyState }> {
    const liveStore = await CompanyStore.open(workspace);
    let liveState = await liveStore.load();
    const live = {
      ...session('worker-owned', 4),
      status: 'busy' as const,
      activeTaskId: 'task-owned',
    };
    const running: Attempt = {
      id: 'attempt-owned',
      taskId: 'task-owned',
      sessionId: live.id,
      runEpoch: live.runEpoch,
      startedAt: now,
      status: 'running',
      changes: [],
      evidenceIds: [],
    };
    const seedEvent = {
      ...event(liveState, { entity: 'attempt', op: 'put', id: running.id, value: running }),
      changes: [
        { entity: 'session' as const, op: 'put' as const, id: live.id, value: live },
        { entity: 'attempt' as const, op: 'put' as const, id: running.id, value: running },
      ],
    };
    await liveStore.commit(seedEvent);
    liveState = applyCompanyEvent(liveState, seedEvent);
    return { store: liveStore, state: liveState };
  }

  it('refuses a destructive control and leaves the durable run exactly as it was', async () => {
    const { store: liveStore, state: liveState } = await seedLiveRun();
    const before = liveState.revision;
    const coordinator = new WorkspaceCompanyCoordinator({
      store: liveStore,
      state: liveState,
      usageLedger: new UsageLedger(),
      isOwner: () => true,
      now: () => now,
      effects: effects({
        verifyControlOwnership: async () => {
          throw new CompanyOwnershipError('unproven', 'No process handle proves this run is ours.');
        },
      }),
    });
    await coordinator.start();

    await expect(coordinator.controlSession('worker-owned', 'kill', 4)).rejects.toMatchObject({
      name: 'CompanyOwnershipError',
      verdict: 'unproven',
    });

    // Not merely "no throw": the refusal is durable-neutral. The run may well
    // still be alive, so nothing may claim it moved on or died.
    const after = await liveStore.load();
    expect(after.revision).toBe(before);
    expect(after.sessions['worker-owned']).toMatchObject({ status: 'busy', runEpoch: 4 });
    expect(after.attempts['attempt-owned']).toMatchObject({ status: 'running' });
    await coordinator.dispose();
  });

  it('records a post-gate ownership failure as blocked rather than crashed', async () => {
    const { store: liveStore, state: liveState } = await seedLiveRun();
    const coordinator = new WorkspaceCompanyCoordinator({
      store: liveStore,
      state: liveState,
      usageLedger: new UsageLedger(),
      isOwner: () => true,
      now: () => now,
      effects: effects({
        verifyControlOwnership: async () => undefined,
        controlSession: async () => {
          throw new CompanyOwnershipError('conflict', 'Another host owns this run.');
        },
      }),
    });
    await coordinator.start();

    await expect(coordinator.controlSession('worker-owned', 'kill', 4)).rejects.toMatchObject({
      verdict: 'conflict',
    });

    const after = await liveStore.load();
    // `crashed` would claim the run died. We never proved it was ours to kill.
    expect(after.sessions['worker-owned']?.status).toBe('stopped');
    // The pre-shutdown invalidation stands (that is the race protection), but
    // the session keeps its task pointer so an orphaned process stays visible.
    expect(after.sessions['worker-owned']?.activeTaskId).toBe('task-owned');
    expect(after.attempts['attempt-owned']).toMatchObject({ status: 'interrupted' });
    await coordinator.dispose();
  });

  it('lets a native effect commit its own routing without deadlocking the queue', async () => {
    const store = await CompanyStore.open(workspace);
    const state = await store.load();
    let coordinator!: InstanceType<typeof WorkspaceCompanyCoordinator>;
    const promptRevision: number[] = [];
    coordinator = new WorkspaceCompanyCoordinator({
      store,
      state,
      usageLedger: new UsageLedger(),
      isOwner: () => true,
      now: () => now,
      effects: effects({
        // What a native runtime actually does: persist its session, counters
        // and route BEFORE launching. Awaited inside the write queue this
        // deadlocks -- serialize() is a lock held across awaits, so the
        // nested commit waits on the effect that is waiting on it. A deadlock
        // shows up here as the suite's own timeout, which is the honest signal
        // for "this promise never settles".
        onPromptSubmitted: async () => {
          promptRevision.push(coordinator.readState().revision);
          await coordinator.commitRuntimeChanges(
            [
              {
                entity: 'counters',
                op: 'put',
                id: 'counters',
                value: { session: 1, task: 0, contract: 0 },
              },
            ],
            coordinator.readState().revision,
          );
        },
        onSettingsUpdated: async () => {
          await coordinator.commitRuntimeChanges(
            [
              {
                entity: 'counters',
                op: 'put',
                id: 'counters',
                value: { session: 7, task: 7, contract: 7 },
              },
            ],
            coordinator.readState().revision,
          );
        },
      }),
    });
    await coordinator.start();

    await coordinator.submitPrompt({
      requestId: randomUUID(),
      text: 'do work',
      delivery: 'prompt',
    });
    // The effect saw the prompt already durable, then advanced the journal.
    expect(promptRevision).toEqual([1]);
    expect((await store.load()).counters).toMatchObject({ session: 1 });

    await coordinator.updateSettings(state.settings.roleProfiles);
    expect((await store.load()).counters).toMatchObject({ session: 7 });
    await coordinator.dispose();
  });
});
