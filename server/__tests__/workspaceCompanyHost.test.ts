/**
 * Two surfaces, one workspace, one executor.
 *
 * These tests open real hosts against real namespaces and talk over the real
 * local broker IPC (a named pipe on Windows, an owner-only socket on POSIX).
 * Nothing about ownership, proxying or privilege is stubbed: the assertions are
 * about what a user of two windows would see -- one runner launch, one durable
 * revision, a refused command that never took effect, and a follower leaving
 * the room without stopping the company's work.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CompanyDiagnostics, CompanyModelCatalogEntry } from '../../core/src/company.js';
import type { ServerMessage } from '../../core/src/messages.js';
import type {
  CompanyTerminalGateway,
  CompanyTerminalHandle,
} from '../src/company/clientCommands.js';
import type { CompanyBrokerEvent } from '../src/company/companyBroker.js';
import type { WorkspaceCompanyCoordinatorEffects } from '../src/company/companyCoordinatorRuntime.js';
import type { CompanyRuntime } from '../src/company/companyRuntime.js';
import type {
  WorkspaceCompanyHost,
  WorkspaceCompanyHostOptions,
} from '../src/company/workspaceCompanyHost.js';

let tempHome: string;
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof os>('os');
  return { ...actual, homedir: () => tempHome };
});

const { COMPANY_OWNER_DESCRIPTOR_FILE } = await import('../src/company/constants.js');
const { resolveCompanyBrokerEndpoint, sendCompanyBrokerRequest } =
  await import('../src/company/companyBroker.js');
const { CompanyOwnership } = await import('../src/company/companyOwnership.js');
const { companyNamespaceDir, resolveWorkspaceKey } = await import('../src/company/companyStore.js');
const { openWorkspaceCompany, readCompanyOwnerDescriptor } =
  await import('../src/company/workspaceCompanyHost.js');

const MODEL_CATALOG: CompanyModelCatalogEntry[] = [
  {
    id: 'provider/model',
    provider: 'provider',
    model: 'model',
    thinking: ['high'],
    acceptsImages: false,
    credentialsConfigured: true,
  },
];

const DIAGNOSTICS: CompanyDiagnostics = {
  liveRunners: 1,
  modelLeases: 1,
  nativeJobs: 0,
  queuedTasks: 0,
  pendingQuestions: 0,
  retainedSessions: 1,
  archivedSessions: 0,
  terminalBufferedBytes: 0,
  ownedHandleCount: 2,
  measuredAt: '2026-10-02T00:00:00.000Z',
};

/** One owner's whole native side, counted where the tests need proof. */
class FakeRuntime implements CompanyRuntime {
  /** Owner startups that ran recovery; one launch per workspace. */
  launches = 0;
  disposals = 0;
  readonly sessions = new Set<string>();
  /** Session keys with a viewer attached; a detach removes only these. */
  readonly viewers = new Set<string>();
  readonly attached: string[] = [];
  readonly detached: string[] = [];
  readonly written: string[] = [];
  readonly resized: string[] = [];
  readonly described: string[] = [];
  private leases = 0;

  readonly effects: WorkspaceCompanyCoordinatorEffects;
  readonly terminal: CompanyTerminalGateway;

  constructor(private readonly emit: (msg: ServerMessage) => void) {
    this.effects = {
      getModelCatalog: async () => MODEL_CATALOG,
      diagnostics: () => DIAGNOSTICS,
      onPromptSubmitted: async () => undefined,
      onContractDecision: async () => undefined,
      onQuestionAnswered: async () => undefined,
      controlSession: async (session, action) => {
        if (action === 'kill') this.sessions.delete(`${session.id}:${session.runEpoch}`);
        return { status: session.status };
      },
      onSettingsUpdated: async () => undefined,
      onStateChanged: () => undefined,
      recover: async () => {
        this.launches += 1;
      },
      dispose: async () => {
        this.disposals += 1;
        this.sessions.clear();
      },
    };
    this.terminal = {
      attach: async (sessionId, runEpoch, cols, rows, onLeaseGranted) => {
        const key = `${sessionId}:${runEpoch}`;
        this.sessions.add(key);
        this.attached.push(key);
        this.viewers.add(key);
        const handle: CompanyTerminalHandle = {
          leaseId: `lease-${(this.leases += 1)}`,
          cols: cols ?? 120,
          rows: rows ?? 32,
        };
        this.emit({
          type: 'terminalSnapshot',
          sessionId,
          runEpoch,
          seq: 0,
          data: Buffer.from('boot').toString('base64'),
        });
        onLeaseGranted?.(handle.leaseId);
        return handle;
      },
      write: async (sessionId, runEpoch, data) => {
        this.written.push(`${sessionId}:${runEpoch}:${data}`);
      },
      resize: async (sessionId, runEpoch, cols, rows) => {
        this.resized.push(`${sessionId}:${runEpoch}:${cols}x${rows}`);
      },
      detach: async (sessionId, runEpoch) => {
        // The runtime contract under test: detach releases the VIEWER's lease
        // and leaves the run it was watching alive.
        this.detached.push(`${sessionId}:${runEpoch}`);
        this.viewers.delete(`${sessionId}:${runEpoch}`);
      },
    };
  }

  /** Records which session was described; this fake holds no native session to read. */
  async sessionInfo(sessionId: string) {
    this.described.push(sessionId);
    return {
      cwd: '/fake/workspace',
      launchCwd: '/fake/workspace',
      collectedFrom: 'transcript' as const,
      collectedAt: '2026-10-02T00:00:00.000Z',
      toolUsage: [],
    };
  }

  async modelCatalog(): Promise<CompanyModelCatalogEntry[]> {
    return MODEL_CATALOG;
  }

  isTerminalAttached(sessionId: string): boolean {
    for (const key of this.sessions) {
      if (key.startsWith(`${sessionId}:`)) return true;
    }
    return false;
  }

  async checkPrerequisite(prerequisite: string): Promise<string | null> {
    return this.unmetPrerequisites.has(prerequisite) ? `${prerequisite} is not met` : null;
  }

  /** Prerequisites this fake refuses; the real runtime reads the filesystem. */
  readonly unmetPrerequisites = new Set<string>();

  async dispose(): Promise<void> {
    await this.effects.dispose();
  }

  /** A frame the owner's runtime would emit for a live PTY. */
  terminalData(sessionId: string, runEpoch: number, seq: number): void {
    this.emit({
      type: 'terminalData',
      sessionId,
      runEpoch,
      seq,
      data: Buffer.from(`frame-${seq}`).toString('base64'),
    });
  }
}

interface Harness {
  hosts: WorkspaceCompanyHost[];
  messages: Map<WorkspaceCompanyHost, ServerMessage[]>;
  brokerEvents: CompanyBrokerEvent[];
  runtimeFactoryCalls: number;
  runtime(): FakeRuntime;
  open(overrides?: Partial<WorkspaceCompanyHostOptions>): Promise<WorkspaceCompanyHost>;
  disposeAll(): Promise<void>;
}

function makeHarness(workspacePath: string): Harness {
  const hosts: WorkspaceCompanyHost[] = [];
  const messages = new Map<WorkspaceCompanyHost, ServerMessage[]>();
  const brokerEvents: CompanyBrokerEvent[] = [];
  let runtime: FakeRuntime | null = null;

  const harness: Harness = {
    hosts,
    messages,
    brokerEvents,
    runtimeFactoryCalls: 0,
    runtime: () => runtime as FakeRuntime,
    async open(overrides = {}) {
      const host = await openWorkspaceCompany({
        workspacePath,
        onMessage: (message: ServerMessage) => {
          messages.get(host)?.push(message);
        },
        runtimeFactory: async (input): Promise<CompanyRuntime> => {
          harness.runtimeFactoryCalls += 1;
          runtime = new FakeRuntime(input.onMessage);
          return runtime;
        },
        onBrokerEvent: (event) => {
          brokerEvents.push(event);
        },
        // Real polling on a short cadence: the point is that the follower learns
        // from the owner, not that it learns slowly.
        pollIntervalMs: 20,
        eventPollIntervalMs: 10,
        connectTimeoutMs: 2_000,
        requestTimeoutMs: 5_000,
        ...overrides,
      });
      hosts.push(host);
      messages.set(host, []);
      return host;
    },
    async disposeAll() {
      // Followers first: a follower outlives its owner, so this is the order a
      // surface really tears its windows down in.
      for (const host of [...hosts].reverse()) await host.dispose();
    },
  };
  return harness;
}

/**
 * Wait for a condition the owner's real polls will make true.
 *
 * The follower's projection and event streams run on wall-clock timers inside
 * the host and the broker, so a deterministic clock is not available here. This
 * polls the observable state rather than sleeping a guessed duration, so a
 * failure names the condition instead of a timeout.
 */
async function until(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(10);
  }
  throw new Error('condition was never met');
}

async function ownerChannel(workspacePath: string): Promise<{
  endpoint: string;
  nonce: string;
  path: string;
}> {
  const key = await resolveWorkspaceKey(workspacePath);
  const descriptor = await readCompanyOwnerDescriptor(key);
  if (!descriptor || descriptor.instanceNonce.length === 0) {
    throw new Error('no owner descriptor');
  }
  const namespaceDir = companyNamespaceDir(key);
  return {
    endpoint:
      descriptor.brokerEndpoint ??
      resolveCompanyBrokerEndpoint(namespaceDir, descriptor.instanceNonce),
    nonce: descriptor.instanceNonce,
    path: path.join(namespaceDir, COMPANY_OWNER_DESCRIPTOR_FILE),
  };
}

describe('workspace company host', () => {
  let workspacePath: string;
  let harness: Harness;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-company-home-'));
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-company-ws-'));
    harness = makeHarness(workspacePath);
  });

  afterEach(async () => {
    await harness.disposeAll();
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  it('gives one workspace one owner and one runtime launch', async () => {
    const owner = await harness.open();
    const follower = await harness.open({ clientId: 'follower-surface' });

    expect(owner.isOwner).toBe(true);
    expect(follower.isOwner).toBe(false);
    expect(follower.workspaceKey).toBe(owner.workspaceKey);
    // One executor: the follower never composes a runtime, so two windows on one
    // workspace still start exactly one company.
    expect(harness.runtimeFactoryCalls).toBe(1);
    expect(harness.runtime().launches).toBe(1);
  });

  it('applies a follower prompt to the owner journal and shares the revision', async () => {
    const owner = await harness.open();
    const follower = await harness.open({ clientId: 'follower-surface' });

    const prompt = await follower.services.coordinator.submitPrompt({
      requestId: randomUUID(),
      text: 'Build the quarterly report',
      delivery: 'prompt',
    });

    // The owner's own projection moved: the mutation really ran in the owner.
    expect(owner.services.coordinator.snapshot().revision).toBe(1);
    expect(owner.services.coordinator.snapshot().prompts).toHaveLength(1);
    // And the follower learns it from the owner, never from its own store.
    await until(() => follower.services.coordinator.snapshot().revision === 1);
    expect(follower.services.coordinator.snapshot().prompts[0]?.id).toBe(prompt.id);
    expect(harness.runtimeFactoryCalls).toBe(1);
  });

  it('does not replay a follower command the owner refused', async () => {
    const owner = await harness.open();
    const follower = await harness.open({ clientId: 'follower-surface' });
    const before = owner.services.coordinator.snapshot().revision;

    // `steer` needs a target, so the owner refuses it after the request lands.
    await expect(
      follower.services.coordinator.submitPrompt({
        requestId: randomUUID(),
        text: 'change your mind',
        delivery: 'steer',
      }),
    ).rejects.toMatchObject({ code: 'company_prompt_target_required' });

    expect(owner.services.coordinator.snapshot().revision).toBe(before);
    // Exactly one attempt reached the owner. A retry after an uncertain outcome
    // is how a company prompt gets applied twice.
    const attempts = harness.brokerEvents.filter((event) => event.code === 'request_rejected');
    expect(attempts).toHaveLength(1);
  });

  it('refuses a proxied command that carries no privilege proof, with no side effect', async () => {
    // This owner keeps a client table: only the follower's own client may
    // command the company through it.
    const owner = await harness.open({
      authority: { isClientPrivileged: (clientId) => clientId === 'follower-surface' },
    });
    await harness.open({ clientId: 'follower-surface' });
    const before = owner.services.coordinator.snapshot().revision;
    const channel = await ownerChannel(workspacePath);
    const input = { requestId: randomUUID(), text: 'unproven', delivery: 'prompt' };

    // No privilege flag at all.
    await expect(
      sendCompanyBrokerRequest({
        endpoint: channel.endpoint,
        nonce: channel.nonce,
        command: 'company.prompt.submit',
        params: {
          privileged: false,
          executionAllowed: true,
          clientId: 'follower-surface',
          input,
        },
      }),
    ).rejects.toMatchObject({ code: 'company_privileged_required' });
    // Privileged, but a client the owner's authority does not recognize.
    await expect(
      sendCompanyBrokerRequest({
        endpoint: channel.endpoint,
        nonce: channel.nonce,
        command: 'company.prompt.submit',
        params: {
          privileged: true,
          executionAllowed: true,
          clientId: 'someone-elses-client',
          input,
        },
      }),
    ).rejects.toMatchObject({ code: 'company_privileged_required' });
    // Privileged client, but no stated consent to execute anything.
    await expect(
      sendCompanyBrokerRequest({
        endpoint: channel.endpoint,
        nonce: channel.nonce,
        command: 'company.prompt.submit',
        params: { privileged: true, clientId: 'follower-surface', input },
      }),
    ).rejects.toMatchObject({ code: 'company_execution_forbidden' });
    // A command outside the published vocabulary.
    await expect(
      sendCompanyBrokerRequest({
        endpoint: channel.endpoint,
        nonce: channel.nonce,
        command: 'company.store.load',
        params: { privileged: true, executionAllowed: true, clientId: 'follower-surface' },
      }),
    ).rejects.toMatchObject({ code: 'company_command_unknown' });

    expect(owner.services.coordinator.snapshot().revision).toBe(before);
  });

  it('gives a session to one viewer: the owner surface and a follower never both see it', async () => {
    const owner = await harness.open();
    const follower = await harness.open({ clientId: 'follower-surface' });
    const sessionId = randomUUID();

    // The owner's own surface attaches first.
    await owner.services.terminal!.attach(sessionId, 0, 80, 24);
    harness.messages.get(owner)!.length = 0;
    harness.messages.get(follower)!.length = 0;
    harness.runtime().terminalData(sessionId, 0, 1);
    await until(() => harness.messages.get(owner)!.length > 0);
    expect(harness.messages.get(follower)!).toHaveLength(0);

    // A follower attaches: it takes the session, and the owner surface stops.
    await follower.services.terminal!.attach(sessionId, 0, 80, 24);
    harness.messages.get(owner)!.length = 0;
    harness.messages.get(follower)!.length = 0;
    harness.runtime().terminalData(sessionId, 0, 2);
    await until(() => harness.messages.get(follower)!.length > 0);
    expect(harness.messages.get(owner)!).toHaveLength(0);
    // Both attaches landed on the owner's one PTY, not on a second process.
    expect(harness.runtime().attached).toEqual([`${sessionId}:0`, `${sessionId}:0`]);
    expect([...harness.runtime().sessions]).toEqual([`${sessionId}:0`]);
  });

  it('stops a follower stream the moment the owner surface takes the session back', async () => {
    const owner = await harness.open();
    const follower = await harness.open({ clientId: 'follower-surface' });
    const sessionId = randomUUID();

    const followerHandle = await follower.services.terminal!.attach(sessionId, 1, 80, 24);
    harness.messages.get(owner)!.length = 0;
    harness.messages.get(follower)!.length = 0;
    harness.runtime().terminalData(sessionId, 1, 1);
    await until(() => harness.messages.get(follower)!.length > 0);
    expect(harness.messages.get(owner)!).toHaveLength(0);

    // The owner surface re-attaches and takes the session back.
    await owner.services.terminal!.attach(sessionId, 1, 80, 24);
    harness.messages.get(owner)!.length = 0;
    harness.messages.get(follower)!.length = 0;
    harness.runtime().terminalData(sessionId, 1, 2);
    await until(() => harness.messages.get(owner)!.length > 0);
    expect(harness.messages.get(follower)!).toHaveLength(0);

    // The lease the follower was holding no longer drives anything.
    await expect(
      follower.services.terminal!.write(sessionId, 1, 'x', followerHandle.leaseId),
    ).rejects.toMatchObject({ code: 'company_terminal_lease_denied' });
  });

  it('keeps the owner running when a follower detaches', async () => {
    const owner = await harness.open();
    const follower = await harness.open({ clientId: 'follower-surface' });
    const sessionId = randomUUID();
    await owner.services.terminal!.attach(sessionId, 3);

    const handle = await follower.services.terminal!.attach(sessionId, 3);
    await follower.services.terminal!.write(sessionId, 3, 'ls\r', handle.leaseId);
    await follower.services.terminal!.resize(sessionId, 3, 100, 30, handle.leaseId);
    await follower.services.terminal!.detach(sessionId, 3, handle.leaseId);

    // The viewer is released at the owner, and the run it was watching keeps
    // going: the run belongs to the company, not to whoever was watching it.
    expect(harness.runtime().detached).toEqual([`${sessionId}:3`]);
    expect(harness.runtime().viewers.has(`${sessionId}:3`)).toBe(false);
    expect(harness.runtime().sessions.has(`${sessionId}:3`)).toBe(true);
    expect(harness.runtime().written).toEqual([`${sessionId}:3:ls\r`]);
    expect(harness.runtime().resized).toEqual([`${sessionId}:3:100x30`]);

    await follower.dispose();
    expect(harness.runtime().sessions.has(`${sessionId}:3`)).toBe(true);
    expect(owner.isOwner).toBe(true);
  });

  it('keeps native-run reporting and the owner lock out of a follower', async () => {
    await harness.open();
    const follower = await harness.open({ clientId: 'follower-surface' });
    await expect(
      follower.services.coordinator.submitTaskResult({
        sessionId: randomUUID(),
        runEpoch: 0,
        taskId: randomUUID(),
        attemptId: randomUUID(),
        summary: 'done',
        changes: [],
      }),
    ).rejects.toMatchObject({ code: 'company_role_forbidden' });
    await expect(
      follower.services.coordinator.verifyTask({
        sessionId: randomUUID(),
        runEpoch: 0,
        taskId: randomUUID(),
        attemptId: randomUUID(),
        commandId: 'build',
      }),
    ).rejects.toMatchObject({ code: 'company_role_forbidden' });

    const channel = await ownerChannel(workspacePath);
    await follower.dispose();

    // Leaving did not hand the workspace to anybody else.
    const after = await ownerChannel(workspacePath);
    expect(after.nonce).toBe(channel.nonce);
    expect(fs.existsSync(after.path)).toBe(true);
    expect(new CompanyOwnership().isOwner).toBe(false);
  });

  it('releases the lock and closes native resources on owner dispose', async () => {
    const owner = await harness.open();
    const follower = await harness.open({ clientId: 'follower-surface' });
    const channel = await ownerChannel(workspacePath);

    await owner.dispose();

    expect(harness.runtime().disposals).toBe(1);
    expect(fs.existsSync(channel.path)).toBe(false);
    // A follower outlives its owner fail-closed: the last known projection stays
    // readable, and nothing new can be commanded.
    await expect(
      follower.services.coordinator.submitPrompt({
        requestId: randomUUID(),
        text: 'anyone home',
        delivery: 'prompt',
      }),
    ).rejects.toMatchObject({ code: 'company_owner_unavailable' });
    expect(follower.services.coordinator.snapshot().revision).toBe(0);

    await follower.dispose();

    // The lock is free, so a fresh surface takes the owner role.
    const successor = makeHarness(workspacePath);
    const next = await successor.open();
    expect(next.isOwner).toBe(true);
    await successor.disposeAll();
  });

  it('fails closed when a descriptor names a live process with no channel', async () => {
    const key = await resolveWorkspaceKey(workspacePath);
    const descriptorPath = path.join(companyNamespaceDir(key), COMPANY_OWNER_DESCRIPTOR_FILE);
    fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
    const nonce = randomUUID();
    fs.writeFileSync(
      descriptorPath,
      JSON.stringify({
        protocolVersion: 1,
        pid: process.pid,
        processStartTime: Date.now(),
        instanceNonce: nonce,
        brokerEndpoint: null,
        acquiredAt: new Date().toISOString(),
      }),
      'utf8',
    );

    await expect(harness.open({ connectTimeoutMs: 500 })).rejects.toMatchObject({
      code: 'company_owner_unavailable',
    });
    // It did not seize the lock it could not reach, and started no executor.
    expect(harness.runtimeFactoryCalls).toBe(0);
    const after = JSON.parse(fs.readFileSync(descriptorPath, 'utf8')) as { instanceNonce: string };
    expect(after.instanceNonce).toBe(nonce);
    expect(new CompanyOwnership().isOwner).toBe(false);
  });

  it('rolls back the lock when the runtime factory fails', async () => {
    await expect(
      harness.open({
        runtimeFactory: async () => {
          throw new Error('omp is not installed');
        },
      }),
    ).rejects.toThrow('omp is not installed');

    const key = await resolveWorkspaceKey(workspacePath);
    const descriptorPath = path.join(companyNamespaceDir(key), COMPANY_OWNER_DESCRIPTOR_FILE);
    expect(fs.existsSync(descriptorPath)).toBe(false);

    const successor = makeHarness(workspacePath);
    const next = await successor.open();
    expect(next.isOwner).toBe(true);
    await successor.disposeAll();
  });

  it('answers the follower model catalog from the owner', async () => {
    const owner = await harness.open();
    const follower = await harness.open({ clientId: 'follower-surface' });

    expect(await owner.services.modelCatalog()).toEqual(MODEL_CATALOG);
    expect(await follower.services.modelCatalog()).toEqual(MODEL_CATALOG);
  });
});
