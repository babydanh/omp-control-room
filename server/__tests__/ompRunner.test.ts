import { describe, expect, it, type Mock, vi } from 'vitest';

import type { RoleProfile } from '../../core/src/company.js';
import type {
  OmpBridgeEvent,
  OmpBridgeEventHandler,
  OmpBridgeHandle,
  OmpBridgeModelCatalog,
  OmpBridgeOptions,
  OmpBridgeSendPrompt,
} from '../src/company/ompBridge.js';
import { buildOmpRunnerArgs, createOmpRunner } from '../src/company/ompRunner.js';
import type { PtyHostEvent, PtySpawnIdentity, PtySpawnSpec } from '../src/company/ptyHost.js';

type Pty = {
  readonly events: Set<(event: PtyHostEvent) => void>;
  readonly spawnPty: Mock<(sessionId: string, spec: PtySpawnSpec) => Promise<PtySpawnIdentity>>;
  readonly kill: ReturnType<typeof vi.fn<(sessionId: string) => Promise<void>>>;
  onEvent(handler: (event: PtyHostEvent) => void): () => void;
};

function fakePty(): Pty {
  const events = new Set<(event: PtyHostEvent) => void>();
  return {
    events,
    spawnPty: vi.fn(async () => ({ pid: 4242, imageName: 'node.exe' })),
    kill: vi.fn(async () => undefined),
    onEvent(handler) {
      events.add(handler);
      return () => events.delete(handler);
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeBridge(options: OmpBridgeOptions, ready: Promise<void> = Promise.resolve()) {
  const handlers = new Set<OmpBridgeEventHandler>();
  const sendPrompt = vi.fn(async (_input: OmpBridgeSendPrompt) => undefined);
  const abort = vi.fn(async () => undefined);
  const dispose = vi.fn(async () => undefined);
  const catalog: OmpBridgeModelCatalog = {
    sessionId: options.sessionId,
    runEpoch: options.runEpoch,
    models: [
      {
        id: 'openai-codex/gpt-6-luna',
        provider: 'openai-codex',
        model: 'gpt-6-luna',
        input: ['text', 'image'],
        thinkingLevels: ['xhigh'],
        configured: true,
      },
    ],
  };
  const requestModelCatalog = vi.fn(async (): Promise<OmpBridgeModelCatalog> => catalog);
  const handle: OmpBridgeHandle = {
    endpoint: 'pipe:company-runner',
    nonce: 'real-run-nonce',
    sessionId: options.sessionId,
    runEpoch: options.runEpoch,
    role: options.role,
    childEnv: {
      PIXEL_AGENTS_OMP_BRIDGE_ENDPOINT: 'pipe:company-runner',
      PIXEL_AGENTS_OMP_BRIDGE_NONCE: 'real-run-nonce',
    },
    ready,
    pendingRpcs: 0,
    sendPrompt,
    abort,
    requestModelCatalog,
    requestSessionInfo: vi.fn(async () => ({ cwd: 'C:/workspace', tools: [], skills: [] })),
    answerQuestion: vi.fn(async () => undefined),
    cancelQuestion: vi.fn(async () => undefined),
    onEvent(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    dispose,
  };
  return {
    handle,
    sendPrompt,
    abort,
    dispose,
    requestModelCatalog,
    catalog,
    emit: (event: OmpBridgeEvent) => handlers.forEach((handler) => handler(event)),
  };
}

const profile: RoleProfile = {
  role: 'worker',
  requestedModel: 'openai-codex/gpt-6-luna:xhigh',
  thinking: 'xhigh',
  workflowFingerprint: 'workflow-v1',
  toolsPolicy: 'scoped-write',
};

function runnerInput(
  prompt: OmpBridgeSendPrompt = { requestId: 'prompt-1', text: 'initial goal' },
) {
  return {
    sessionId: 'company-session-1',
    runEpoch: 7,
    roleProfile: profile,
    workspaceRoot: 'C:/workspace/project',
    sessionDirectory: 'C:/workspace/.pixel-agents/sessions/company-session-1',
    nativeSessionId: 'native-resume-id',
    initialPrompt: prompt,
    rpcHandler: () => undefined,
  };
}

describe('buildOmpRunnerArgs approval mode', () => {
  const base = { commandArgs: [], extensionPath: 'C:/extension/omp-bridge.mjs' };
  const approvalOf = (args: string[]): string | null => {
    const index = args.indexOf('--approval-mode');
    return index === -1 ? null : (args[index + 1] ?? null);
  };

  it('stops a role run on exec approval, but leaves the user chat on its own omp default', () => {
    expect(approvalOf(buildOmpRunnerArgs({ ...base, roleProfile: profile }))).toBe('write');
    expect(approvalOf(buildOmpRunnerArgs({ ...base, roleProfile: { ...profile, toolsPolicy: 'omp' } }))).toBeNull();
  });

  it('never stops an unattended run on an approval nobody can answer, whatever its role policy', () => {
    expect(approvalOf(buildOmpRunnerArgs({ ...base, roleProfile: profile, unattended: true }))).toBe('yolo');
    expect(
      approvalOf(buildOmpRunnerArgs({ ...base, roleProfile: { ...profile, toolsPolicy: 'omp' }, unattended: true })),
    ).toBe('yolo');
  });
});

describe('managed OMP runner', () => {
  it('waits for authenticated readiness before delivery and keeps prompt text out of process arguments', async () => {
    const pty = fakePty();
    const readiness = deferred<void>();
    let bridge = fakeBridge(
      { sessionId: 'company-session-1', runEpoch: 7, role: 'worker', rpcHandler: () => undefined },
      readiness.promise,
    );
    const runner = createOmpRunner({
      ptyClient: pty,
      command: { file: 'C:/node.exe', args: ['C:/omp/cli.mjs'] },
      extensionPath: 'C:/extension/omp-bridge.mjs',
      environment: {
        PATH: 'C:/bin',
        HOME: 'C:/Users/test',
        PIXEL_AGENTS_OMP_BRIDGE_NONCE: 'attacker-value',
      },
      createBridge: (options) => {
        bridge = fakeBridge(options, readiness.promise);
        return bridge.handle;
      },
    });

    const starting = runner.start(
      runnerInput({ requestId: 'prompt-1', text: 'private initial prompt' }),
    );
    await pty.spawnPty.mock.results[0]?.value;

    expect(bridge.sendPrompt).not.toHaveBeenCalled();
    expect(pty.spawnPty.mock.calls[0]?.[1]).toMatchObject({
      file: 'C:/node.exe',
      args: [
        'C:/omp/cli.mjs',
        '--extension',
        'C:/extension/omp-bridge.mjs',
        '--model',
        'openai-codex/gpt-6-luna:xhigh',
        '--thinking',
        'xhigh',
        '--approval-mode',
        'write',
        '--session-dir',
        'C:/workspace/.pixel-agents/sessions/company-session-1',
        '--resume',
        'native-resume-id',
      ],
      cwd: 'C:/workspace/project',
      env: {
        PATH: 'C:/bin',
        HOME: 'C:/Users/test',
        PIXEL_AGENTS_OMP_BRIDGE_ENDPOINT: 'pipe:company-runner',
        PIXEL_AGENTS_OMP_BRIDGE_NONCE: 'real-run-nonce',
        TERM: 'xterm-256color',
      },
      cols: 120,
      rows: 32,
      term: 'xterm-256color',
    });
    expect(pty.spawnPty.mock.calls[0]?.[1].args).not.toContain('private initial prompt');

    readiness.resolve();
    await starting;

    expect(bridge.sendPrompt).toHaveBeenCalledWith({
      requestId: 'prompt-1',
      text: 'private initial prompt',
    });
    expect(runner.state).toBe('running');
    // The pid the helper reported, not the executable we asked for: lineage
    // checks compare against the running process.
    expect(runner.identity).toEqual({ pid: 4242, imageName: 'node.exe' });
    await runner.dispose();
  });

  it('keeps herdr control variables out of the OMP runner environment', async () => {
    const pty = fakePty();
    const runner = createOmpRunner({
      ptyClient: pty,
      command: { file: 'C:/node.exe', args: ['C:/omp/cli.mjs'] },
      extensionPath: 'C:/extension/omp-bridge.mjs',
      environment: {
        PATH: 'C:/bin',
        HERDR_SOCKET_PATH: 'C:/Users/test/herdr.sock',
        HERDR_PANE_ID: 'wA:p2',
      },
      createBridge: (options) => fakeBridge(options).handle,
    });

    const starting = runner.start(runnerInput());
    await pty.spawnPty.mock.results[0]?.value;
    await starting;

    const env = pty.spawnPty.mock.calls[0]?.[1].env;
    expect(env).toHaveProperty('PATH', 'C:/bin');
    expect(env).not.toHaveProperty('HERDR_SOCKET_PATH');
    expect(env).not.toHaveProperty('HERDR_PANE_ID');
    await runner.dispose();
  });

  it('rejects stale controls and routes active aborts and native events through the run bridge', async () => {
    const pty = fakePty();
    let bridge = fakeBridge({
      sessionId: 'company-session-1',
      runEpoch: 7,
      role: 'worker',
      rpcHandler: () => undefined,
    });
    const runner = createOmpRunner({
      ptyClient: pty,
      command: { file: 'C:/node.exe', args: ['C:/omp/cli.mjs'] },
      extensionPath: 'C:/extension/omp-bridge.mjs',
      createBridge: (options) => {
        bridge = fakeBridge(options);
        return bridge.handle;
      },
    });
    const nativeEvents: OmpBridgeEvent[] = [];
    runner.onEvent((event) => {
      if (event.kind === 'native') nativeEvents.push(event.event);
    });

    await runner.start(runnerInput({ requestId: 'prompt-1', text: 'first turn' }));
    await expect(
      runner.sendPrompt(6, { requestId: 'stale', text: 'must not arrive' }),
    ).rejects.toMatchObject({
      code: 'stale_company_run_epoch',
    });
    await expect(runner.abort(6)).rejects.toMatchObject({ code: 'stale_company_run_epoch' });
    expect(bridge.sendPrompt).not.toHaveBeenCalledWith({
      requestId: 'stale',
      text: 'must not arrive',
    });
    expect(bridge.abort).not.toHaveBeenCalled();

    bridge.emit({ k: 'text', seq: 1, text: 'working' });
    await runner.abort(7);
    expect(nativeEvents).toEqual([{ k: 'text', seq: 1, text: 'working' }]);
    expect(bridge.abort).toHaveBeenCalledTimes(1);
    await runner.dispose();
  });

  it('stops accepting prompts and releases the bridge when the PTY exits', async () => {
    const pty = fakePty();
    let bridge = fakeBridge({
      sessionId: 'company-session-1',
      runEpoch: 7,
      role: 'worker',
      rpcHandler: () => undefined,
    });
    const runner = createOmpRunner({
      ptyClient: pty,
      command: { file: 'C:/node.exe', args: ['C:/omp/cli.mjs'] },
      extensionPath: 'C:/extension/omp-bridge.mjs',
      createBridge: (options) => {
        bridge = fakeBridge(options);
        return bridge.handle;
      },
    });
    const runnerEvents: Array<{ kind: string; data?: string; exitCode?: number }> = [];
    runner.onEvent((event) => {
      if (event.kind === 'terminal_data' || event.kind === 'exit') runnerEvents.push(event);
    });

    await runner.start(runnerInput());
    for (const listener of pty.events) {
      listener({ type: 'data', sessionId: 'company-session-1:7', data: 'dGVybWluYWw=' });
      listener({ type: 'exit', sessionId: 'company-session-1:7', exitCode: 1 });
    }

    expect(runner.state).toBe('exited');
    expect(runnerEvents).toEqual([
      { kind: 'terminal_data', data: 'dGVybWluYWw=' },
      { kind: 'exit', exitCode: 1 },
    ]);
    expect(bridge.dispose).toHaveBeenCalledTimes(1);
    await expect(
      runner.sendPrompt(7, { requestId: 'late', text: 'too late' }),
    ).rejects.toMatchObject({
      code: 'omp_runner_not_running',
    });
    await runner.dispose();
  });

  it('kills the spawned PTY and disposes the bridge when authenticated startup fails', async () => {
    const pty = fakePty();
    const readiness = deferred<void>();
    let bridge = fakeBridge(
      { sessionId: 'company-session-1', runEpoch: 7, role: 'worker', rpcHandler: () => undefined },
      readiness.promise,
    );
    const runner = createOmpRunner({
      ptyClient: pty,
      command: { file: 'C:/node.exe', args: ['C:/omp/cli.mjs'] },
      extensionPath: 'C:/extension/omp-bridge.mjs',
      createBridge: (options) => {
        bridge = fakeBridge(options, readiness.promise);
        return bridge.handle;
      },
    });
    const starting = runner.start(runnerInput());
    await pty.spawnPty.mock.results[0]?.value;
    readiness.reject(new Error('bridge authentication failed'));

    await expect(starting).rejects.toThrow('bridge authentication failed');

    expect(pty.kill).toHaveBeenCalledTimes(1);
    expect(bridge.dispose).toHaveBeenCalledTimes(1);
    expect(runner.state).toBe('failed');
  });
  it('marks the runner failed when the authenticated bridge cannot be created', async () => {
    const pty = fakePty();
    const runner = createOmpRunner({
      ptyClient: pty,
      command: { file: 'C:/node.exe', args: ['C:/omp/cli.mjs'] },
      extensionPath: 'C:/extension/omp-bridge.mjs',
      createBridge: () => {
        throw new Error('bridge bind failed');
      },
    });

    await expect(runner.start(runnerInput())).rejects.toThrow('bridge bind failed');

    expect(runner.state).toBe('failed');
    expect(pty.spawnPty).not.toHaveBeenCalled();
    await runner.dispose();
  });

  it('keeps explicit disposal state when startup readiness is cancelled', async () => {
    const pty = fakePty();
    const readiness = deferred<void>();
    let bridge = fakeBridge(
      { sessionId: 'company-session-1', runEpoch: 7, role: 'worker', rpcHandler: () => undefined },
      readiness.promise,
    );
    const runner = createOmpRunner({
      ptyClient: pty,
      command: { file: 'C:/node.exe', args: ['C:/omp/cli.mjs'] },
      extensionPath: 'C:/extension/omp-bridge.mjs',
      createBridge: (options) => {
        bridge = fakeBridge(options, readiness.promise);
        return bridge.handle;
      },
    });
    const starting = runner.start(runnerInput());
    await pty.spawnPty.mock.results[0]?.value;

    await runner.dispose();
    readiness.reject(new Error('bridge disposed'));
    await expect(starting).rejects.toThrow('bridge disposed');

    expect(runner.state).toBe('disposed');
    expect(pty.kill).toHaveBeenCalledTimes(1);
    expect(bridge.dispose).toHaveBeenCalledTimes(1);
  });
  it('forwards catalog reads to the live bridge and refuses stale or stopped runs', async () => {
    const pty = fakePty();
    let bridge = fakeBridge({
      sessionId: 'company-session-1',
      runEpoch: 7,
      role: 'worker',
      rpcHandler: () => undefined,
    });
    const runner = createOmpRunner({
      ptyClient: pty,
      command: { file: 'C:/node.exe', args: ['C:/omp/cli.mjs'] },
      extensionPath: 'C:/extension/omp-bridge.mjs',
      createBridge: (options) => {
        bridge = fakeBridge(options);
        return bridge.handle;
      },
    });

    await runner.start(runnerInput());

    await expect(runner.requestModelCatalog(6)).rejects.toMatchObject({
      code: 'stale_company_run_epoch',
    });
    expect(bridge.requestModelCatalog).not.toHaveBeenCalled();

    // Not cached: only the live process knows which models its own
    // credentials expose, so every read has to reach the running runtime.
    await expect(runner.requestModelCatalog(7)).resolves.toBe(bridge.catalog);
    await expect(runner.requestModelCatalog(7)).resolves.toBe(bridge.catalog);
    expect(bridge.requestModelCatalog).toHaveBeenCalledTimes(2);

    for (const listener of pty.events) {
      listener({ type: 'exit', sessionId: 'company-session-1:7', exitCode: 1 });
    }

    await expect(runner.requestModelCatalog(7)).rejects.toMatchObject({
      code: 'omp_runner_not_running',
    });
    expect(bridge.requestModelCatalog).toHaveBeenCalledTimes(2);
    await runner.dispose();
  });
});
