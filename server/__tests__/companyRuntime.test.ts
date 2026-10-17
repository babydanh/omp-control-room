import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CompanyState } from '../../core/src/company.js';
import type { ServerMessage } from '../../core/src/messages.js';
import type { CompanyRuntimeDeps } from '../src/company/companyRuntime.js';
import { UsageLedger } from '../src/company/usageService.js';

let tempHome: string;
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof os>('os');
  return { ...actual, homedir: () => tempHome };
});

// The `os` mock above must be in place before the store module is evaluated,
// because the store resolves its namespace through `homedir()` on construction.
const { CompanyStore } = await import('../src/company/companyStore.js');
const { WorkspaceCompanyCoordinator } = await import('../src/company/companyCoordinatorRuntime.js');
const { createCompanyRuntime } = await import('../src/company/companyRuntime.js');
const { resolveNativeLaunch } = await import('../src/company/companyNativeLaunch.js');
/**
 * Let every already-scheduled microtask and `setImmediate` callback run.
 * `Promise.withResolvers` is the preferred shape, but this project compiles to
 * ES2022 where it does not exist, so the executor form is the correct one here.
 */
/**
 * Wait for a condition the runtime reaches through its own write queue. Every
 * wait here settles on a real state change; the deadline is only the guard that
 * turns a hang into a failure.
 */
async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
  throw new Error(`timed out waiting for: ${label}`);
}

/**
 * The run that actually received a prompt.
 *
 * The runtime may start an idle Director purely to answer a model-catalog read,
 * and that run never receives a prompt, so "the first runner started" is not
 * necessarily the one under test.
 */
async function promptedRun(h: Harness): Promise<FakeRunner> {
  await until(
    () => h.runners.some((runner) => runner.prompts.length > 0),
    'a Director run to receive the prompt',
  );
  return h.runners.find((runner) => runner.prompts.length > 0) as FakeRunner;
}

const WORKSPACE = path.join(os.tmpdir(), 'company-runtime-workspace');

/** One recorded runner, so a test can see what was launched and what was torn down. */
interface FakeRunner {
  sessionId: string;
  runEpoch: number;
  started: number;
  disposed: number;

  readonly prompts: { text: string; runEpoch?: number }[];
  identity: { pid: number; imageName: string } | null;
  requestModelCatalog: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  sendPrompt: (runEpoch: number, prompt: { text: string; runEpoch?: number }) => Promise<void>;
  dispose: ReturnType<typeof vi.fn>;
  onEvent: (handler: (event: never) => void) => () => void;
  start: () => Promise<void>;
  state: string;
}

interface Harness {
  readonly runtime: Awaited<ReturnType<typeof createCompanyRuntime>>;
  readonly coordinator: InstanceType<typeof WorkspaceCompanyCoordinator>;
  readonly store: Awaited<ReturnType<typeof CompanyStore.open>>;
  readonly runners: FakeRunner[];
  readonly pty: {
    readonly killed: string[];
    readonly writes: { sessionId: string; data: string }[];
    disposed: number;
  };
  readonly messages: ServerMessage[];
  /** The rpc handler the last started runner was given, for bridge assertions. */
  rpcHandler(): (request: never) => Promise<unknown>;
}

const startedRunners: FakeRunner[] = [];

function makeRunner(sessionId: string, runEpoch: number): FakeRunner {
  const runner: FakeRunner = {
    sessionId,
    runEpoch,
    started: 0,
    disposed: 0,
    prompts: [],
    identity: { pid: 4242, imageName: 'node.exe' },
    state: 'running',
    requestModelCatalog: vi.fn(async () => ({
      sessionId,
      runEpoch,
      models: [
        {
          id: 'provider/model',
          provider: 'provider',
          model: 'model',
          input: ['text'],
          thinkingLevels: ['high', 'xhigh'],
          configured: true,
        },
      ],
    })),
    abort: vi.fn(async () => undefined),
    sendPrompt: vi.fn(async (_epoch: number, prompt: { text: string; runEpoch?: number }) => {
      runner.prompts.push(prompt);
    }),
    dispose: vi.fn(async () => {
      runner.disposed += 1;
    }),
    onEvent: () => () => undefined,
    start: async () => {
      runner.started += 1;
    },
  };
  return runner;
}

async function harness(): Promise<Harness> {
  startedRunners.length = 0;
  const store = await CompanyStore.open(WORKSPACE);
  const state: CompanyState = await store.load();
  const usageLedger = new UsageLedger();
  const messages: ServerMessage[] = [];
  const pty = {
    killed: [] as string[],
    writes: [] as { sessionId: string; data: string }[],
    disposed: 0,
  };
  let lastRpc: ((request: never) => Promise<unknown>) | null = null;

  const deps: Partial<CompanyRuntimeDeps> = {
    resolveLaunch: () => ({
      command: { file: process.execPath, args: [] },
      extensionPath: 'C:/dist/company-omp-bridge.mjs',
      helperPath: 'C:/dist/company-pty-host.js',
    }),
    startPtyClient: async () =>
      ({
        onEvent: () => () => undefined,
        write: async (sessionId: string, data: string) => {
          pty.writes.push({ sessionId, data });
        },
        resize: async () => undefined,
        snapshot: async () => '',
        kill: async (sessionId: string) => {
          pty.killed.push(sessionId);
        },
        dispose: async () => {
          pty.disposed += 1;
        },
      }) as never,
    createRunner: () => {
      const holder = { current: null as FakeRunner | null };
      const runner = makeRunner('', 0);
      startedRunners.push(runner);
      holder.current = runner;
      return {
        get state() {
          return 'running';
        },
        get identity() {
          return runner.identity;
        },
        start: async (input: {
          sessionId: string;
          runEpoch: number;
          initialPrompt?: { text: string };
          rpcHandler: (request: never) => Promise<unknown>;
        }) => {
          Object.assign(runner, { sessionId: input.sessionId, runEpoch: input.runEpoch });
          lastRpc = input.rpcHandler;
          await runner.start();
          // The real runner sends the first turn once its bridge is ready, so
          // the fake must too — otherwise a prompt would never arrive and the
          // tests would be asserting against a fiction.
          if (input.initialPrompt !== undefined) {
            await runner.sendPrompt(input.runEpoch, input.initialPrompt);
          }
        },
        sendPrompt: runner.sendPrompt,
        abort: runner.abort,
        requestModelCatalog: runner.requestModelCatalog,
        dispose: runner.dispose,
        onEvent: runner.onEvent,
      } as never;
    },
    createSupervisor: () => {
      // The real supervisor's kill is what closes a run's bridge, so the fake
      // has to do the same or a dispose could never reach the runner.
      const ports = new Map<string, { shutdownBridge?: () => Promise<unknown> }>();
      return {
        registerRun: (input: {
          runId: string;
          ports?: { shutdownBridge?: () => Promise<unknown> };
        }) => {
          if (input.ports) ports.set(input.runId, input.ports);
          return undefined;
        },
        notifyExit: (runId: string) => {
          ports.delete(runId);
          return undefined;
        },
        pause: async () => ({ state: 'paused' }),
        kill: async (runId: string) => {
          await ports.get(runId)?.shutdownBridge?.();
          ports.delete(runId);
          return { state: 'stopped' };
        },
        getRun: () => undefined,
        verifyRunOwnership: async () => 'gone' as const,
        dispose: async () => ({ role: 'owner', blocked: [] }),
      } as never;
    },
    now: () => '2026-10-02T00:00:00.000Z',
    setInterval: (() => 0) as unknown as CompanyRuntimeDeps['setInterval'],
    clearInterval: () => undefined,
  };

  const runtime = await createCompanyRuntime({
    store: store as never,
    usageLedger,
    getCoordinator: () => coordinator,
    onMessage: (message) => messages.push(message),
    deps,
  });
  const coordinator = new WorkspaceCompanyCoordinator({
    store,
    state,
    usageLedger,
    isOwner: () => true,
    effects: runtime.effects,
    now: () => '2026-10-02T00:00:00.000Z',
  });
  await coordinator.start();
  return {
    runtime,
    coordinator,
    store,
    runners: startedRunners,
    pty,
    messages,
    rpcHandler: () => {
      if (lastRpc === null) throw new Error('no runner was started');
      return lastRpc;
    },
  };
}

/** Commit a session + task + contract straight through the journal, as earlier turns would. */
async function seed(
  harnessValue: Harness,
  changes: Parameters<InstanceType<typeof WorkspaceCompanyCoordinator>['commitRuntimeChanges']>[0],
): Promise<void> {
  await harnessValue.coordinator.commitRuntimeChanges(
    changes,
    harnessValue.coordinator.readState().revision,
  );
}

describe('company runtime effects', () => {
  beforeEach(async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'company-runtime-home-'));
    fs.rmSync(WORKSPACE, { recursive: true, force: true });
    fs.mkdirSync(WORKSPACE, { recursive: true });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    fs.rmSync(WORKSPACE, { recursive: true, force: true });
  });

  it('refuses to compose when the OMP target is a shell wrapper', () => {
    // A `.cmd` shim would spawn cmd.exe, so the process the supervisor verifies
    // would not be the one the runtime asked for.
    expect(() =>
      resolveNativeLaunch({
        runnerCommand: { file: 'C:/tools/omp.cmd', args: [] },
        extensionPath: __filename,
        helperPath: __filename,
      }),
    ).toThrowError(expect.objectContaining({ code: 'omp_executable_unavailable' }));
  });

  it('reports a missing native prerequisite instead of substituting anything', async () => {
    // The machine running the suite may have OMP installed globally; point every
    // lookup root at the empty workspace so "not installed" is what is tested.
    vi.stubEnv('APPDATA', WORKSPACE);
    vi.stubEnv('OMP_CLI_ENTRY', '');
    const store = await CompanyStore.open(WORKSPACE);
    const state = await store.load();
    const usageLedger = new UsageLedger();
    const composition = createCompanyRuntime({
      store: store as never,
      usageLedger,
      getCoordinator: () =>
        new WorkspaceCompanyCoordinator({
          store,
          state,
          usageLedger,
          isOwner: () => true,
          effects: {} as never,
        }),
      onMessage: () => undefined,
      // No OMP installed and no explicit path: resolution must fail closed.
      deps: { resolveLaunch: (input) => resolveNativeLaunch({ ...input, distDir: WORKSPACE }) },
    });
    await expect(composition).rejects.toThrowError(
      expect.objectContaining({ code: 'omp_executable_unavailable' }),
    );
  });

  it('starts no worker for a Contract that is still awaiting approval', async () => {
    const h = await harness();
    await seed(h, [
      {
        entity: 'contract',
        op: 'put',
        id: 'contract-1',
        value: {
          id: 'contract-1',
          code: 'C1',
          revision: 1,
          promptIds: [],
          requirements: [],
          phases: [{ id: 'P1', title: 'Build', ordinal: 0, taskIds: [], acceptanceIds: [] }],
          tasks: [
            {
              id: 'task-1',
              code: 'T1',
              contractId: 'contract-1',
              phaseId: 'P1',
              title: 'Implement the feature',
              requirementIds: [],
              dependsOn: [],
              workstreamId: 'ws-1',
              readScopes: [],
              writeScopes: [{ path: 'src/a.ts', kind: 'file', operations: ['modify'] }],
              sharedResources: [],
              acceptance: [],
              executionMode: 'session',
              status: 'ready',
              attemptIds: [],
              routeReason: 'seeded',
            },
          ],
          assumptions: [],
          decisions: [],
          acceptance: [],
          status: 'awaiting_approval',
        },
      },
    ]);

    // A state change is what makes the runtime look for work; the Contract is
    // not approved, so the scheduler must hand nothing out.
    h.runtime.effects.onStateChanged({
      id: randomUUID(),
      sequence: 0,
      baseRevision: 0,
      at: '2026-10-02T00:00:00.000Z',
      changes: [],
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    const roles = h.runners.map((runner) => runner.sessionId);
    expect(roles).toEqual([]);
    expect(Object.values(h.coordinator.readState().sessions).map((s) => s.role)).toEqual([]);
  });

  it('refuses a bridge frame from an epoch this runtime does not own', async () => {
    const h = await harness();
    await h.coordinator.submitPrompt({
      requestId: 'req-1',
      text: 'Plan the work',
      delivery: 'prompt',
    });
    const runner = await promptedRun(h);
    expect(runner.prompts[0]?.text).toContain('Plan the work');

    const revision = h.coordinator.readState().revision;
    await expect(
      h.rpcHandler()({
        sessionId: runner.sessionId,
        runEpoch: runner.runEpoch + 5,
        method: 'company_tool',
        toolCallId: 'call-1',
        toolName: 'company_ask_user',
        role: 'director',
        payload: {
          title: 'Which one?',
          questions: [{ id: 'q', question: 'Which one?', options: [{ label: 'A' }] }],
        },
      } as never),
    ).rejects.toThrowError(expect.objectContaining({ code: 'stale_company_run_epoch' }));
    // A refused frame must not have created a Question.
    expect(Object.keys(h.coordinator.readState().questions)).toEqual([]);
    expect(h.coordinator.readState().revision).toBe(revision);
  });

  it('keeps the run alive when a viewer detaches from its terminal', async () => {
    const h = await harness();
    await h.coordinator.submitPrompt({
      requestId: 'req-2',
      text: 'Plan the work',
      delivery: 'prompt',
    });
    const runner = await promptedRun(h);
    const session = h.coordinator.readState().sessions[runner.sessionId];
    expect(session).toBeDefined();

    const handle = await h.runtime.terminal.attach(runner.sessionId, runner.runEpoch);
    expect(h.runtime.isTerminalAttached(runner.sessionId)).toBe(true);

    await h.runtime.terminal.write(runner.sessionId, runner.runEpoch, 'ls\r', handle.leaseId);
    await h.runtime.terminal.detach(runner.sessionId, runner.runEpoch, handle.leaseId);

    // The keystroke went to the runner's own PTY and detaching killed nothing.
    expect(h.pty.writes).toEqual([
      { sessionId: `${runner.sessionId}:${runner.runEpoch}`, data: 'ls\r' },
    ]);
    expect(h.pty.killed).toEqual([]);
    expect(runner.disposed).toBe(0);
    expect(h.runtime.isTerminalAttached(runner.sessionId)).toBe(false);
  });

  it('refuses a stale terminal lease and a dead run', async () => {
    const h = await harness();
    await h.coordinator.submitPrompt({
      requestId: 'req-3',
      text: 'Plan the work',
      delivery: 'prompt',
    });
    const runner = await promptedRun(h);
    const handle = await h.runtime.terminal.attach(runner.sessionId, runner.runEpoch);
    const second = await h.runtime.terminal.attach(runner.sessionId, runner.runEpoch);

    await expect(
      h.runtime.terminal.write(runner.sessionId, runner.runEpoch, 'ls\r', handle.leaseId),
    ).rejects.toThrowError(expect.objectContaining({ code: 'invalid_terminal_lease' }));
    await h.runtime.terminal.write(runner.sessionId, runner.runEpoch, 'ls\r', second.leaseId);

    await expect(
      h.runtime.terminal.attach(runner.sessionId, runner.runEpoch + 1),
    ).rejects.toThrowError(expect.objectContaining({ code: 'terminal_session_not_live' }));
  });

  it('tears every run, the helper and the timers down on dispose', async () => {
    const h = await harness();
    await h.coordinator.submitPrompt({
      requestId: 'req-4',
      text: 'Plan the work',
      delivery: 'prompt',
    });
    const runner = await promptedRun(h);
    await h.runtime.terminal.attach(runner.sessionId, runner.runEpoch);

    await h.runtime.dispose();

    expect(runner.disposed).toBe(1);
    expect(h.pty.disposed).toBe(1);
    expect(h.runtime.isTerminalAttached(runner.sessionId)).toBe(false);
    await expect(h.runtime.dispose()).resolves.toBeUndefined();
  });

  it('never resumes prior work on recovery', async () => {
    const h = await harness();
    const sessionId = randomUUID();
    await seed(h, [
      {
        entity: 'session',
        op: 'put',
        id: sessionId,
        value: {
          id: sessionId,
          code: 'S9',
          name: 'Worker S9',
          role: 'worker',
          workstreamId: 'ws-9',
          workspaceKey: 'workspace',
          requestedModel: 'provider/model',
          runEpoch: 3,
          status: 'busy',
          lastUsedAt: '2026-10-02T00:00:00.000Z',
        },
      },
      {
        entity: 'attempt',
        op: 'put',
        id: 'attempt-9',
        value: {
          id: 'attempt-9',
          taskId: 'task-9',
          sessionId,
          runEpoch: 3,
          startedAt: '2026-10-02T00:00:00.000Z',
          status: 'running',
          changes: [],
          evidenceIds: [],
        },
      },
    ]);

    await h.runtime.effects.recover(h.coordinator.readState());
    // The reconciliation is committed by the first pass after startup.
    await h.runtime.effects.onStateChanged({
      id: randomUUID(),
      sequence: 0,
      baseRevision: 0,
      at: '2026-10-02T00:00:00.000Z',
      changes: [],
    });
    await until(
      () => h.coordinator.readState().sessions[sessionId]?.status === 'crashed',
      'the interrupted session to be reconciled',
    );

    const recovered = h.coordinator.readState();
    expect(recovered.sessions[sessionId]?.status).toBe('crashed');
    expect(recovered.attempts['attempt-9']?.status).toBe('interrupted');
    // Recovery reconciles records; it never starts a process.
    expect(h.runners).toEqual([]);
  });
});
