import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CompanyState } from '../../core/src/company.js';
import type { ServerMessage } from '../../core/src/messages.js';
import { CompanyError } from '../src/company/companyError.js';
import type { CompanyRuntimeDeps } from '../src/company/companyRuntime.js';
import { COMPANY_MODEL_CATALOG_TTL_MS } from '../src/company/constants.js';
import { SessionLog, sessionLogDirectory } from '../src/company/sessionLog.js';
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
 * The run that actually received a prompt. A board can hold more than one live
 * run, so "the first runner started" is not necessarily the one under test.
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
  resumeFile?: string;
  started: number;
  disposed: number;

  readonly prompts: { text: string; runEpoch?: number }[];
  identity: { pid: number; imageName: string } | null;
  requestModelCatalog: ReturnType<typeof vi.fn>;
  requestSessionInfo: Mock<(runEpoch: number) => Promise<unknown>>;
  abort: ReturnType<typeof vi.fn>;
  sendPrompt: (runEpoch: number, prompt: { text: string; runEpoch?: number }) => Promise<void>;
  dispose: ReturnType<typeof vi.fn>;
  onEvent: (handler: (event: never) => void) => () => void;
  /** The runtime's event handler, so a kill can deliver the exit a real process sends. */
  listener?: (event: never) => void;
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

/** What a live run reports about its own process; the bridge answers in this shape. */
const LIVE_SESSION_DESCRIPTION = {
  cwd: 'D:/live-cwd',
  model: 'provider/live-model',
  thinking: 'high',
  sessionFile: 'D:/live-cwd/session.jsonl',
  tools: [{ name: 'read', source: 'builtin', active: true }],
  skills: [{ name: 'brand', description: 'Brand voice' }],
};

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
    requestSessionInfo: vi.fn<(runEpoch: number) => Promise<unknown>>(
      async () => LIVE_SESSION_DESCRIPTION,
    ),
    abort: vi.fn(async () => undefined),
    sendPrompt: vi.fn(async (_epoch: number, prompt: { text: string; runEpoch?: number }) => {
      runner.prompts.push(prompt);
    }),
    dispose: vi.fn(async () => {
      runner.disposed += 1;
    }),
    onEvent: (handler) => {
      runner.listener = handler;
      return () => undefined;
    },
    start: async () => {
      runner.started += 1;
    },
  };
  return runner;
}

async function harness(overrides: Partial<CompanyRuntimeDeps> = {}): Promise<Harness> {
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
    readOmpModels: async () => [
      {
        id: 'provider/model',
        provider: 'provider',
        model: 'model',
        input: ['text'],
        thinkingLevels: ['high', 'xhigh'],
        configured: true,
      },
    ],
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
          resumeFile?: string;
          rpcHandler: (request: never) => Promise<unknown>;
        }) => {
          Object.assign(runner, {
            sessionId: input.sessionId,
            runEpoch: input.runEpoch,
            resumeFile: input.resumeFile,
          });
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
        requestSessionInfo: runner.requestSessionInfo,
        dispose: runner.dispose,
        onEvent: runner.onEvent,
      } as never;
    },
    createSupervisor: () => {
      // The real supervisor's kill is what closes a run's bridge, so the fake
      // has to do the same or a dispose could never reach the runner.
      const ports = new Map<string, { shutdownBridge?: () => Promise<unknown> }>();
      const sessionOfRun = new Map<string, string>();
      return {
        registerRun: (input: {
          runId: string;
          sessionId: string;
          ports?: { shutdownBridge?: () => Promise<unknown> };
        }) => {
          if (input.ports) ports.set(input.runId, input.ports);
          sessionOfRun.set(input.runId, input.sessionId);
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
          // A real process reports its exit while the kill is still settling.
          const sessionId = sessionOfRun.get(runId);
          const runner = startedRunners.find((entry) => entry.sessionId === sessionId);
          runner?.listener?.({ kind: 'exit', exitCode: 1 } as never);
          return { state: 'stopped' };
        },
        getRun: (runId: string) => (sessionOfRun.has(runId) ? { runId } : undefined),
        verifyRunOwnership: async () => 'gone' as const,
        dispose: async () => ({ role: 'owner', blocked: [] }),
      } as never;
    },
    now: () => '2026-10-02T00:00:00.000Z',
    setInterval: (() => 0) as unknown as CompanyRuntimeDeps['setInterval'],
    clearInterval: () => undefined,
    ...overrides,
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

/** Record tool-call starts in a session's durable log, as the runtime does while a run works. */
async function recordToolCalls(
  h: Harness,
  sessionId: string,
  calls: { toolName: string; text: string }[],
): Promise<void> {
  const log = new SessionLog({
    directory: sessionLogDirectory(h.store.namespaceDir),
    now: () => '2026-10-02T00:00:00.000Z',
    onEntry: () => undefined,
  });
  for (const call of calls) {
    log.record(sessionId, { kind: 'tool', runEpoch: 1, toolName: call.toolName, text: call.text });
  }
  await log.drain();
}

/** Commit an idle Worker, with its omp transcript at `nativeSessionPath` when one is given. */
async function seedWorker(
  h: Harness,
  sessionId: string,
  nativeSessionPath?: string,
): Promise<void> {
  await seed(h, [
    {
      entity: 'session',
      op: 'put',
      id: sessionId,
      value: {
        id: sessionId,
        code: 'S8',
        name: 'Worker S8',
        role: 'worker',
        workstreamId: 'ws-8',
        workspaceKey: 'workspace',
        requestedModel: 'provider/model',
        runEpoch: 1,
        status: 'idle',
        lastUsedAt: '2026-10-02T00:00:00.000Z',
        ...(nativeSessionPath === undefined ? {} : { nativeSessionId: 'saved', nativeSessionPath }),
      },
    },
  ]);
}

/** Commit a parked chat session, with its omp file at `nativeSessionPath` when given. */
async function seedParkedChat(
  h: Harness,
  sessionId: string,
  nativeSessionPath?: string,
): Promise<void> {
  await seed(h, [
    {
      entity: 'session',
      op: 'put',
      id: sessionId,
      value: {
        id: sessionId,
        code: 'C1',
        name: 'Chat parked',
        role: 'chat',
        workstreamId: `${sessionId}-stream`,
        workspaceKey: 'workspace',
        requestedModel: 'provider/model',
        runEpoch: 2,
        status: 'parked',
        lastUsedAt: '2026-10-02T00:00:00.000Z',
        ...(nativeSessionPath === undefined ? {} : { nativeSessionId: 'saved', nativeSessionPath }),
      },
    },
  ]);
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

  it('reports an unknown session as not found', async () => {
    const h = await harness();
    await expect(h.runtime.sessionInfo(randomUUID())).rejects.toThrowError(
      expect.objectContaining({ code: 'session_not_found' }),
    );
  });

  it('asks the live run, and reports its tools, skills and recorded tool use', async () => {
    const h = await harness();
    await h.coordinator.submitPrompt({
      requestId: 'req-5',
      text: 'Plan the work',
      delivery: 'prompt',
    });
    const runner = await promptedRun(h);
    await recordToolCalls(h, runner.sessionId, [
      { toolName: 'read', text: 'skill://brand' },
      { toolName: 'read', text: 'src/a.ts' },
      { toolName: 'bash', text: 'ls' },
    ]);

    const info = await h.runtime.sessionInfo(runner.sessionId);

    expect(runner.requestSessionInfo).toHaveBeenCalledWith(runner.runEpoch);
    expect(info).toMatchObject({
      cwd: 'D:/live-cwd',
      launchCwd: h.store.workspacePath,
      model: 'provider/live-model',
      thinking: 'high',
      sessionFile: 'D:/live-cwd/session.jsonl',
      tools: [{ name: 'read', source: 'builtin', active: true }],
      skills: [{ name: 'brand', description: 'Brand voice', used: true }],
      toolUsage: [
        { name: 'read', count: 2 },
        { name: 'bash', count: 1 },
      ],
      collectedFrom: 'live',
      collectedAt: '2026-10-02T00:00:00.000Z',
    });
  });

  it('falls back to the saved record when the live run cannot answer', async () => {
    const h = await harness();
    await h.coordinator.submitPrompt({
      requestId: 'req-6',
      text: 'Plan the work',
      delivery: 'prompt',
    });
    const runner = await promptedRun(h);
    runner.requestSessionInfo.mockRejectedValueOnce(new Error('bridge gone'));

    const info = await h.runtime.sessionInfo(runner.sessionId);

    expect(info.collectedFrom).toBe('transcript');
    expect(info.cwd).toBe(h.store.workspacePath);
  });

  it('answers from the saved transcript and the session log when no run is live', async () => {
    const h = await harness();
    const sessionId = randomUUID();
    const transcript = path.join(WORKSPACE, 'saved-session.jsonl');
    fs.writeFileSync(
      transcript,
      `${JSON.stringify({ type: 'session', version: 3, id: 'saved', cwd: WORKSPACE })}\n`,
    );
    await seedWorker(h, sessionId, transcript);
    await recordToolCalls(h, sessionId, [{ toolName: 'bash', text: 'ls' }]);

    const info = await h.runtime.sessionInfo(sessionId);

    expect(info).toMatchObject({
      cwd: h.store.workspacePath,
      model: 'provider/model',
      sessionFile: transcript,
      tools: [],
      skills: [],
      toolUsage: [{ name: 'bash', count: 1 }],
      collectedFrom: 'transcript',
      collectedAt: '2026-10-02T00:00:00.000Z',
    });
  });

  it('says it is record-only when neither a run nor a transcript can answer', async () => {
    const h = await harness();
    const sessionId = randomUUID();
    await seedWorker(h, sessionId);

    const info = await h.runtime.sessionInfo(sessionId);

    expect(info).toMatchObject({
      model: 'provider/model',
      toolUsage: [],
      collectedFrom: 'transcript',
    });
    expect(info.note).toEqual(expect.any(String));
    expect(info).not.toHaveProperty('tools');
    expect(info).not.toHaveProperty('sessionFile');
  });
});

describe('chat sessions', () => {
  beforeEach(async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'company-runtime-home-'));
    fs.rmSync(WORKSPACE, { recursive: true, force: true });
    fs.mkdirSync(WORKSPACE, { recursive: true });
  });

  afterEach(async () => {
    fs.rmSync(WORKSPACE, { recursive: true, force: true });
  });

  it('opens one plain chat session for a prompt with nothing selected, then reuses it', async () => {
    const h = await harness();
    const directorsBefore = Object.values(h.coordinator.readState().sessions).filter(
      (s) => s.role === 'director',
    ).length;
    const first = await h.coordinator.submitPrompt({
      requestId: 'chat-1',
      text: 'hi',
      delivery: 'prompt',
      mode: 'chat',
    });
    const sessionId = first.targetSessionId;
    expect(sessionId).toEqual(expect.any(String));
    expect(h.coordinator.readState().sessions[sessionId ?? '']?.role).toBe('chat');

    // The chat text reaches omp exactly as typed: no company brief around it.
    const runner = await promptedRun(h);
    expect(runner.prompts[0]?.text).toBe('hi');

    const second = await h.coordinator.submitPrompt({
      requestId: 'chat-2',
      text: 'and then?',
      delivery: 'prompt',
      mode: 'chat',
      targetSessionId: sessionId,
    });
    expect(second.targetSessionId).toBe(sessionId);
    const roles = Object.values(h.coordinator.readState().sessions).map((s) => s.role);
    expect(roles.filter((role) => role === 'chat')).toHaveLength(1);
    // The chat prompt opened no Director: the board's own Director was already there.
    expect(roles.filter((role) => role === 'director')).toHaveLength(directorsBefore);
    expect(h.runners).toHaveLength(1);
  });

  it('deletes a live chat session without recording its own kill as a crash', async () => {
    const h = await harness();
    const opened = await h.coordinator.submitPrompt({
      requestId: 'chat-del',
      text: 'hi',
      delivery: 'prompt',
      mode: 'chat',
    });
    const sessionId = opened.targetSessionId ?? '';
    await promptedRun(h);
    const session = h.coordinator.readState().sessions[sessionId];
    expect(session).toBeDefined();
    // The turn has ended; only an idle session may be deleted.
    await h.coordinator.commitRuntimeChanges(
      [{ entity: 'session', op: 'put', id: sessionId, value: { ...session!, status: 'idle' } }],
      h.coordinator.readState().revision,
    );

    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await h.coordinator.controlSession(sessionId, 'delete', session!.runEpoch);
      // Let the exit callback the kill delivered finish its work.
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(h.coordinator.readState().sessions[sessionId]).toBeUndefined();
      // The exit of a run the board killed is not a crash: no write raced the
      // delete. Unhandled, that conflicting write used to take the server down.
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it('opens a new chat with no prompt and answers its board id', async () => {
    const h = await harness();

    const id = await h.coordinator.openNewChat();

    expect(h.coordinator.readState().sessions[id]).toMatchObject({ role: 'chat' });
    expect(h.runners).toHaveLength(1);
    expect(h.runners[0]?.prompts).toEqual([]);
    expect(h.runners[0]?.resumeFile).toBeUndefined();
  });

  it('reopens a parked chat session on its own omp file under the same session record', async () => {
    const h = await harness();
    const file = path.join(WORKSPACE, 'parked.jsonl');
    await seedParkedChat(h, 'chat-parked', file);

    await h.coordinator.controlSession('chat-parked', 'resume', 2);

    expect(h.runners).toHaveLength(1);
    expect(h.runners[0]?.resumeFile).toBe(file);
    expect(h.coordinator.readState().sessions['chat-parked']).toMatchObject({
      status: 'starting',
      runEpoch: 2,
      nativeSessionPath: file,
    });
  });

  it('refuses to reopen a parked chat session whose record never learned its omp file', async () => {
    const h = await harness();
    await seedParkedChat(h, 'chat-blank');

    await expect(h.coordinator.controlSession('chat-blank', 'resume', 2)).rejects.toMatchObject({
      code: 'session_reopen_refused',
    });

    expect(h.runners).toHaveLength(0);
    expect(h.coordinator.readState().sessions['chat-blank']).toMatchObject({ status: 'parked' });
  });
});

describe('model catalog', () => {
  beforeEach(async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'company-runtime-home-'));
    fs.rmSync(WORKSPACE, { recursive: true, force: true });
    fs.mkdirSync(WORKSPACE, { recursive: true });
  });

  afterEach(async () => {
    fs.rmSync(WORKSPACE, { recursive: true, force: true });
  });

  const CATALOG_MODEL = {
    id: 'provider/model',
    provider: 'provider',
    model: 'model',
    input: ['text'],
    thinkingLevels: ['high', 'xhigh'],
    configured: true,
  };
  const CATALOG_ENTRY = {
    id: 'provider/model',
    provider: 'provider',
    model: 'model',
    thinking: ['high', 'xhigh'],
    acceptsImages: false,
    credentialsConfigured: true,
  };

  it('reads the catalog from omp models without starting a session', async () => {
    const readOmpModels = vi.fn(async () => [CATALOG_MODEL]);
    const h = await harness({ readOmpModels });
    const sessionsBefore = Object.keys(h.coordinator.readState().sessions).length;

    await expect(h.runtime.modelCatalog()).resolves.toEqual([CATALOG_ENTRY]);

    expect(readOmpModels).toHaveBeenCalledTimes(1);
    expect(h.runners).toHaveLength(0);
    expect(Object.keys(h.coordinator.readState().sessions)).toHaveLength(sessionsBefore);
  });

  it('shares one read between concurrent callers', async () => {
    const readOmpModels = vi.fn(async () => [CATALOG_MODEL]);
    const h = await harness({ readOmpModels });

    const [first, second] = await Promise.all([h.runtime.modelCatalog(), h.runtime.modelCatalog()]);

    expect(first).toEqual([CATALOG_ENTRY]);
    expect(second).toEqual([CATALOG_ENTRY]);
    expect(readOmpModels).toHaveBeenCalledTimes(1);
  });

  it('reuses one read inside the TTL and reads again once it has aged out', async () => {
    let clock = Date.parse('2026-10-02T00:00:00.000Z');
    const readOmpModels = vi.fn(async () => [CATALOG_MODEL]);
    const h = await harness({ readOmpModels, now: () => new Date(clock).toISOString() });

    await h.runtime.modelCatalog();
    clock += COMPANY_MODEL_CATALOG_TTL_MS - 1;
    await h.runtime.modelCatalog();
    expect(readOmpModels).toHaveBeenCalledTimes(1);

    clock += 1;
    await h.runtime.modelCatalog();
    expect(readOmpModels).toHaveBeenCalledTimes(2);
  });

  it('does not keep a failed read, so the next caller asks again', async () => {
    const readOmpModels = vi
      .fn(async () => [CATALOG_MODEL])
      .mockRejectedValueOnce(new CompanyError('model_catalog_unavailable', 'omp is missing'));
    const h = await harness({ readOmpModels });

    await expect(h.runtime.modelCatalog()).rejects.toMatchObject({
      code: 'model_catalog_unavailable',
    });
    await expect(h.runtime.modelCatalog()).resolves.toEqual([CATALOG_ENTRY]);
    expect(readOmpModels).toHaveBeenCalledTimes(2);
  });

  it('answers from a live run when the CLI read fails', async () => {
    const readOmpModels = vi.fn(async () => {
      throw new CompanyError('model_catalog_unavailable', 'omp is missing');
    });
    const h = await harness({ readOmpModels });
    const opened = await h.coordinator.submitPrompt({
      requestId: 'catalog-live',
      text: 'hi',
      delivery: 'prompt',
      mode: 'chat',
    });
    const sessionId = opened.targetSessionId ?? '';
    const runner = await promptedRun(h);
    const session = h.coordinator.readState().sessions[sessionId];
    runner.requestModelCatalog.mockResolvedValueOnce({
      sessionId,
      runEpoch: session!.runEpoch,
      models: [CATALOG_MODEL],
    });

    await expect(h.runtime.modelCatalog()).resolves.toEqual([CATALOG_ENTRY]);
    expect(readOmpModels).toHaveBeenCalled();
  });

  it('refuses with the CLI reason when no run is live to ask', async () => {
    const readOmpModels = vi.fn(async () => {
      throw new CompanyError('model_catalog_unavailable', 'omp is missing');
    });
    const h = await harness({ readOmpModels });

    await expect(h.runtime.modelCatalog()).rejects.toMatchObject({
      code: 'model_catalog_unavailable',
      message: expect.stringContaining('omp is missing'),
    });
    expect(h.runners).toHaveLength(0);
  });
});
