import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CompanySnapshot,
  CompanyWorkspaceEntry,
  ServerMessage,
} from '../../core/src/messages.js';
import type { CompanyCommandServices } from '../src/company/clientCommands.js';
import type {
  WorkspaceCompanyHost,
  WorkspaceCompanyHostOptions,
} from '../src/company/workspaceCompanyHost.js';
import {
  COMPANY_WORKSPACE_PUSH_REQUEST_ID,
  CompanyWorkspaceRegistry,
  countCompanyWork,
} from '../src/company/workspaceRegistry.js';

/** A fake host: its coordinator reports `state.snapshot`, and `emit` delivers a frame the way the real host does. */
interface FakeHost {
  readonly host: WorkspaceCompanyHost;
  readonly options: WorkspaceCompanyHostOptions;
  readonly state: { snapshot: CompanySnapshot; disposeCalls: number };
  emit(message: ServerMessage): void;
}

interface Harness {
  readonly registry: CompanyWorkspaceRegistry;
  readonly broadcasts: ServerMessage[];
  readonly hosts: FakeHost[];
  /** Backing store for the recents seam, so tests can inspect what was remembered. */
  readonly recents: string[];
  readonly control: { failNextOpen: boolean; openCalls: number };
}

function snapshotWith(parts: {
  sessions?: string[];
  questions?: string[];
  contracts?: string[];
}): CompanySnapshot {
  return {
    sessions: (parts.sessions ?? []).map((status) => ({ status })),
    questions: (parts.questions ?? []).map((status) => ({ status })),
    contracts: (parts.contracts ?? []).map((status) => ({ status })),
  } as unknown as CompanySnapshot;
}

function createFakeHost(options: WorkspaceCompanyHostOptions): FakeHost {
  const state = { snapshot: snapshotWith({}), disposeCalls: 0 };
  const services = {
    coordinator: { snapshot: () => state.snapshot },
  } as unknown as CompanyCommandServices;
  const host: WorkspaceCompanyHost = {
    workspacePath: options.workspacePath,
    workspaceKey: options.workspacePath.toLowerCase(),
    role: 'owner',
    isOwner: true,
    services,
    dispose: async () => {
      state.disposeCalls += 1;
    },
  };
  return {
    host,
    options,
    state,
    emit: (message) => options.onMessage(message),
  };
}

function createHarness(
  options: { recents?: string[]; beforeOpen?: (workspacePath: string) => Promise<void> } = {},
): Harness {
  const broadcasts: ServerMessage[] = [];
  const hosts: FakeHost[] = [];
  const recents = [...(options.recents ?? [])];
  const control = { failNextOpen: false, openCalls: 0 };
  const registry = new CompanyWorkspaceRegistry({
    broadcast: (message) => {
      broadcasts.push(message);
    },
    openHost: async (hostOptions) => {
      control.openCalls += 1;
      await options.beforeOpen?.(hostOptions.workspacePath);
      if (control.failNextOpen) {
        control.failNextOpen = false;
        throw new Error('native runtime prerequisite missing');
      }
      const fake = createFakeHost(hostOptions);
      hosts.push(fake);
      return fake.host;
    },
    hostDefaults: { helperPath: 'pty-host.exe', extensionPath: 'omp-bridge.js' },
    recents: {
      read: () => [...recents],
      remember: (workspacePath) => {
        const next = [workspacePath, ...recents.filter((entry) => entry !== workspacePath)];
        recents.splice(0, recents.length, ...next.slice(0, 10));
      },
    },
    countDebounceMs: 250,
  });
  return { registry, broadcasts, hosts, recents, control };
}

function hostAt(hosts: FakeHost[], index: number): FakeHost {
  const found = hosts[index];
  if (!found) throw new Error(`no fake host at index ${index}`);
  return found;
}

function marker(requestId: string): ServerMessage {
  return { type: 'companyCommandResult', requestId, ok: true } as unknown as ServerMessage;
}

function workspaceLists(broadcasts: ServerMessage[]): CompanyWorkspaceEntry[][] {
  return broadcasts.flatMap((message) =>
    message.type === 'companyWorkspaces' ? [message.workspaces] : [],
  );
}

describe('countCompanyWork', () => {
  it('counts busy and starting sessions as working, and waiting inputs, pending questions and awaiting approvals as waiting', () => {
    const counts = countCompanyWork(
      snapshotWith({
        sessions: ['busy', 'starting', 'waiting_input', 'idle', 'parked'],
        questions: ['pending', 'answered'],
        contracts: ['awaiting_approval', 'running'],
      }),
    );
    expect(counts).toEqual({ working: 2, waiting: 3 });
  });
});

describe('CompanyWorkspaceRegistry', () => {
  let root: string;
  let alpha: string;
  let beta: string;
  let alphaReal: string;
  let betaReal: string;
  let notes: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-workspaces-'));
    alpha = path.join(root, 'alpha');
    beta = path.join(root, 'beta');
    fs.mkdirSync(alpha);
    fs.mkdirSync(beta);
    notes = path.join(root, 'notes.txt');
    fs.writeFileSync(notes, 'not a folder');
    alphaReal = fs.realpathSync(alpha);
    betaReal = fs.realpathSync(beta);
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('opens a folder, makes it active, and publishes the list and a snapshot push', async () => {
    const h = createHarness();
    await h.registry.open(alpha);

    expect(h.hosts).toHaveLength(1);
    expect(hostAt(h.hosts, 0).options).toMatchObject({
      workspacePath: alphaReal,
      helperPath: 'pty-host.exe',
      extensionPath: 'omp-bridge.js',
    });
    expect(h.registry.activeServices()).toBe(hostAt(h.hosts, 0).host.services);
    expect(workspaceLists(h.broadcasts).at(-1)).toEqual([
      { path: alphaReal, active: true, open: true, working: 0, waiting: 0 },
    ]);
    expect(h.broadcasts).toContainEqual(
      expect.objectContaining({
        type: 'companySnapshot',
        requestId: COMPANY_WORKSPACE_PUSH_REQUEST_ID,
      }),
    );
    expect(h.recents[0]).toBe(alphaReal);
  });

  it('switching folders keeps the first host running and activates the second', async () => {
    const h = createHarness();
    await h.registry.open(alpha);
    await h.registry.open(beta);

    expect(h.hosts).toHaveLength(2);
    expect(h.registry.activeServices()).toBe(hostAt(h.hosts, 1).host.services);
    expect(hostAt(h.hosts, 0).state.disposeCalls).toBe(0);
    expect(workspaceLists(h.broadcasts).at(-1)).toEqual([
      { path: alphaReal, active: false, open: true, working: 0, waiting: 0 },
      { path: betaReal, active: true, open: true, working: 0, waiting: 0 },
    ]);
  });

  it('reopening an open folder reuses its host instead of starting another', async () => {
    const h = createHarness();
    await h.registry.open(alpha);
    await h.registry.open(beta);
    await h.registry.open(alpha);

    expect(h.hosts).toHaveLength(2);
    expect(h.registry.activeServices()).toBe(hostAt(h.hosts, 0).host.services);
  });

  it('refuses a missing path, a file, or a blank path, and opens no host', async () => {
    const h = createHarness();

    await expect(h.registry.open(path.join(root, 'missing'))).rejects.toMatchObject({
      code: 'workspace_invalid',
      message: expect.stringContaining('Không tìm thấy thư mục'),
    });
    await expect(h.registry.open(notes)).rejects.toMatchObject({
      code: 'workspace_invalid',
      message: expect.stringContaining('không phải là thư mục'),
    });
    await expect(h.registry.open('   ')).rejects.toMatchObject({
      code: 'workspace_invalid',
      message: 'Cần chọn một thư mục để mở.',
    });

    expect(h.hosts).toHaveLength(0);
    expect(h.registry.activeServices()).toBeNull();
    expect(h.broadcasts).toHaveLength(0);
  });

  it('reports a folder whose host fails to start as workspace_open_failed and keeps the previous one active', async () => {
    const h = createHarness();
    await h.registry.open(alpha);
    h.control.failNextOpen = true;

    await expect(h.registry.open(beta)).rejects.toMatchObject({
      code: 'workspace_open_failed',
      message: expect.stringContaining('native runtime prerequisite missing'),
    });
    expect(h.registry.activeServices()).toBe(hostAt(h.hosts, 0).host.services);
    expect(workspaceLists(h.broadcasts).at(-1)).toEqual([
      { path: alphaReal, active: true, open: true, working: 0, waiting: 0 },
    ]);
  });

  it('forwards only the active folder to the board and keeps the others silent', async () => {
    const h = createHarness();
    await h.registry.open(alpha);
    await h.registry.open(beta);
    const before = h.broadcasts.length;

    hostAt(h.hosts, 0).emit(marker('from-alpha'));
    hostAt(h.hosts, 1).emit(marker('from-beta'));

    expect(h.broadcasts.slice(before)).toEqual([marker('from-beta')]);

    await h.registry.open(alpha);
    const switched = h.broadcasts.length;
    hostAt(h.hosts, 0).emit(marker('alpha-again'));
    hostAt(h.hosts, 1).emit(marker('beta-silent'));

    expect(h.broadcasts.slice(switched)).toEqual([marker('alpha-again')]);
  });

  it('counts working and waiting work per folder from each host snapshot', async () => {
    const h = createHarness();
    await h.registry.open(alpha);
    hostAt(h.hosts, 0).state.snapshot = snapshotWith({
      sessions: ['busy', 'starting', 'waiting_input', 'idle'],
      questions: ['pending', 'answered'],
      contracts: ['awaiting_approval', 'running'],
    });
    await h.registry.open(beta);

    expect(h.registry.entries()).toEqual([
      { path: alphaReal, active: false, open: true, working: 2, waiting: 3 },
      { path: betaReal, active: true, open: true, working: 0, waiting: 0 },
    ]);
  });

  it('lists recently used folders that are not open after the open ones, without duplicating them', async () => {
    const gone = path.join(root, 'gone');
    const h = createHarness({ recents: [gone, alphaReal] });

    expect(h.registry.entries()).toEqual([
      { path: gone, active: false, open: false, working: 0, waiting: 0 },
      { path: alphaReal, active: false, open: false, working: 0, waiting: 0 },
    ]);

    await h.registry.open(alpha);

    expect(h.registry.entries()).toEqual([
      { path: alphaReal, active: true, open: true, working: 0, waiting: 0 },
      { path: gone, active: false, open: false, working: 0, waiting: 0 },
    ]);
  });

  it('coalesces count changes into one list broadcast and skips lists that did not change', async () => {
    const h = createHarness();
    await h.registry.open(alpha);
    const alphaHost = hostAt(h.hosts, 0);
    const listsBefore = workspaceLists(h.broadcasts).length;

    vi.useFakeTimers();
    alphaHost.state.snapshot = snapshotWith({ sessions: ['busy'] });
    alphaHost.emit(marker('a'));
    alphaHost.emit(marker('b'));
    alphaHost.emit(marker('c'));

    await vi.advanceTimersByTimeAsync(249);
    expect(workspaceLists(h.broadcasts)).toHaveLength(listsBefore);
    await vi.advanceTimersByTimeAsync(1);

    const lists = workspaceLists(h.broadcasts);
    expect(lists).toHaveLength(listsBefore + 1);
    expect(lists.at(-1)).toEqual([
      { path: alphaReal, active: true, open: true, working: 1, waiting: 0 },
    ]);

    alphaHost.emit(marker('d'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(workspaceLists(h.broadcasts)).toHaveLength(listsBefore + 1);

    alphaHost.state.snapshot = snapshotWith({ sessions: ['busy'], questions: ['pending'] });
    alphaHost.emit({ type: 'companyTextDelta' } as unknown as ServerMessage);
    await vi.advanceTimersByTimeAsync(1000);
    expect(workspaceLists(h.broadcasts)).toHaveLength(listsBefore + 1);
  });

  it('serialises opens so the last request the user made is the one left active', async () => {
    let releaseAlpha: () => void = () => undefined;
    const alphaGate = new Promise<void>((resolve) => {
      releaseAlpha = resolve;
    });
    const h = createHarness({
      beforeOpen: async (workspacePath) => {
        if (workspacePath === alphaReal) await alphaGate;
      },
    });

    const first = h.registry.open(alpha);
    const second = h.registry.open(beta);
    releaseAlpha();
    await Promise.all([first, second]);

    expect(h.hosts.map((fake) => fake.options.workspacePath)).toEqual([alphaReal, betaReal]);
    expect(h.registry.activeServices()).toBe(hostAt(h.hosts, 1).host.services);
  });

  it('dispose stops every host, clears the active folder, and refuses later opens', async () => {
    const h = createHarness();
    await h.registry.open(alpha);
    await h.registry.open(beta);

    await h.registry.dispose();
    await h.registry.dispose();

    expect(hostAt(h.hosts, 0).state.disposeCalls).toBe(1);
    expect(hostAt(h.hosts, 1).state.disposeCalls).toBe(1);
    expect(h.registry.activeServices()).toBeNull();
    await expect(h.registry.open(alpha)).rejects.toMatchObject({ code: 'company_unavailable' });

    const before = h.broadcasts.length;
    hostAt(h.hosts, 1).emit(marker('late'));
    expect(h.broadcasts).toHaveLength(before);
  });

  it('disposes a host that finishes starting after dispose was requested', async () => {
    let releaseAlpha: () => void = () => undefined;
    const alphaGate = new Promise<void>((resolve) => {
      releaseAlpha = resolve;
    });
    const h = createHarness({
      beforeOpen: async (workspacePath) => {
        if (workspacePath === alphaReal) await alphaGate;
      },
    });

    const pending = h.registry.open(alpha);
    await vi.waitFor(() => {
      expect(h.control.openCalls).toBe(1);
    });
    const disposed = h.registry.dispose();
    releaseAlpha();

    await expect(pending).rejects.toMatchObject({ code: 'company_unavailable' });
    await disposed;
    expect(h.hosts).toHaveLength(1);
    expect(hostAt(h.hosts, 0).state.disposeCalls).toBe(1);
    expect(h.registry.activeServices()).toBeNull();
  });
});
