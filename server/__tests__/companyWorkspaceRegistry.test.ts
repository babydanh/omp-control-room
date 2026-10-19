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
  COMPANY_WORKSPACE_PRESENCE_CHECK_MS,
  COMPANY_WORKSPACE_PUSH_REQUEST_ID,
  COMPANY_WORKSPACE_SESSION_LIMIT,
  CompanyWorkspaceRegistry,
  companyWorkspaceSessions,
  countCompanyWork,
} from '../src/company/workspaceRegistry.js';
import { toPathKey } from '../src/pathKey.js';

/** A fake host: its coordinator reports `state.snapshot`, and `emit` delivers a frame the way the real host does. */
interface FakeHost {
  readonly host: WorkspaceCompanyHost;
  readonly options: WorkspaceCompanyHostOptions;
  readonly state: {
    snapshot: CompanySnapshot;
    disposeCalls: number;
    unreadable: boolean;
    /** Ids the fake coordinator reports as held by this folder. */
    ids: Set<string>;
  };
  emit(message: ServerMessage): void;
}

interface Harness {
  readonly registry: CompanyWorkspaceRegistry;
  readonly broadcasts: ServerMessage[];
  readonly hosts: FakeHost[];
  /** Backing store for the recents seam, so tests can inspect what was remembered. */
  readonly recents: string[];
  readonly control: { failNextOpen: boolean; openCalls: number };
  /** Display-name store behind the names seam, keyed by path key, so tests can seed and inspect names. */
  readonly names: Record<string, string>;
}

/** A session as the coordinator lists it; the folder list keeps five of these fields and no more. */
interface SessionFixture {
  id: string;
  code: string;
  name: string;
  role: string;
  status: string;
}

function sessionOf(code: string, status: string): SessionFixture {
  return { id: `id-${code}`, code, name: `Tên ${code}`, role: 'worker', status };
}

/** A snapshot holding exactly these sessions, for the ordering and cap rules. */
function snapshotOfSessions(sessions: SessionFixture[]): CompanySnapshot {
  return { sessions, questions: [], contracts: [] } as unknown as CompanySnapshot;
}

function snapshotWith(parts: {
  sessions?: string[];
  questions?: string[];
  contracts?: string[];
}): CompanySnapshot {
  return {
    sessions: (parts.sessions ?? []).map((status, index) =>
      sessionOf(`PA-S${String(index + 1).padStart(4, '0')}`, status),
    ),
    questions: (parts.questions ?? []).map((status) => ({ status })),
    contracts: (parts.contracts ?? []).map((status) => ({ status })),
  } as unknown as CompanySnapshot;
}

function createFakeHost(options: WorkspaceCompanyHostOptions): FakeHost {
  const state = {
    snapshot: snapshotWith({}),
    disposeCalls: 0,
    unreadable: false,
    ids: new Set<string>(),
  };
  const services = {
    coordinator: {
      snapshot: () => {
        if (state.unreadable) throw new Error('coordinator still starting');
        return state.snapshot;
      },
      holdsId: (id: string) => state.ids.has(id),
    },
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
  options: {
    recents?: string[];
    beforeOpen?: (workspacePath: string) => Promise<void>;
    /** When false, every display-name save is refused, as a failed config write would be. */
    namesWritable?: boolean;
    /** When false, every recent-list save is refused, as a failed config write would be. */
    recentsWritable?: boolean;
    /** The fake file system's view of which folders exist. Defaults to the real one. */
    folderExists?: (workspacePath: string) => boolean;
  } = {},
): Harness {
  const broadcasts: ServerMessage[] = [];
  const hosts: FakeHost[] = [];
  const recents = [...(options.recents ?? [])];
  const names: Record<string, string> = {};
  const namesWritable = options.namesWritable ?? true;
  const recentsWritable = options.recentsWritable ?? true;
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
      forget: (workspacePath) => {
        if (!recentsWritable) return false;
        const key = toPathKey(workspacePath);
        const kept = recents.filter((entry) => toPathKey(entry) !== key);
        recents.splice(0, recents.length, ...kept);
        return true;
      },
    },
    names: {
      read: () => ({ ...names }),
      set: (workspacePath, name) => {
        if (!namesWritable) return false;
        const key = toPathKey(workspacePath);
        if (name === null) {
          delete names[key];
        } else {
          names[key] = name;
        }
        return true;
      },
    },
    countDebounceMs: 250,
    folderExists: options.folderExists,
  });
  return { registry, broadcasts, hosts, recents, control, names };
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

describe('companyWorkspaceSessions', () => {
  it('lists live sessions only: those waiting on the user first, then those working, then the rest, each by code', () => {
    const listed = companyWorkspaceSessions(
      snapshotOfSessions([
        sessionOf('PA-S0001', 'idle'),
        sessionOf('PA-S0002', 'busy'),
        sessionOf('PA-S0003', 'archived'),
        sessionOf('PA-S0004', 'waiting_input'),
        sessionOf('PA-S0005', 'starting'),
        sessionOf('PA-S0006', 'paused'),
      ]),
    );
    expect(listed.map((session) => session.code)).toEqual([
      'PA-S0004',
      'PA-S0002',
      'PA-S0005',
      'PA-S0001',
      'PA-S0006',
    ]);
  });

  it('orders codes by number, so PA-S0009 comes before PA-S0010', () => {
    const listed = companyWorkspaceSessions(
      snapshotOfSessions([sessionOf('PA-S0010', 'idle'), sessionOf('PA-S0009', 'idle')]),
    );
    expect(listed.map((session) => session.code)).toEqual(['PA-S0009', 'PA-S0010']);
  });

  it('carries only the fields the board needs', () => {
    const listed = companyWorkspaceSessions({
      sessions: [{ ...sessionOf('PA-S0001', 'busy'), requestedModel: 'model', runEpoch: 1 }],
    } as unknown as CompanySnapshot);
    expect(listed).toEqual([sessionOf('PA-S0001', 'busy')]);
  });

  it('caps the list at COMPANY_WORKSPACE_SESSION_LIMIT, keeping the sessions that wait on the user', () => {
    const sessions = Array.from({ length: 150 }, (_, index) =>
      sessionOf(`PA-S${String(index + 1).padStart(4, '0')}`, 'idle'),
    );
    sessions.push(sessionOf('PA-S9999', 'waiting_input'));

    const listed = companyWorkspaceSessions(snapshotOfSessions(sessions));

    expect(COMPANY_WORKSPACE_SESSION_LIMIT).toBe(100);
    expect(listed).toHaveLength(100);
    expect(listed[0]?.code).toBe('PA-S9999');
    expect(listed.at(-1)?.code).toBe('PA-S0099');
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
      { path: alphaReal, active: true, open: true, working: 0, waiting: 0, sessions: [] },
    ]);
    expect(h.broadcasts).toContainEqual(
      expect.objectContaining({
        type: 'companySnapshot',
        requestId: COMPANY_WORKSPACE_PUSH_REQUEST_ID,
        workspacePath: alphaReal,
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
      { path: alphaReal, active: false, open: true, working: 0, waiting: 0, sessions: [] },
      { path: betaReal, active: true, open: true, working: 0, waiting: 0, sessions: [] },
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
      { path: alphaReal, active: true, open: true, working: 0, waiting: 0, sessions: [] },
    ]);
  });

  it('tags board messages from each open folder with its path, and leaves terminal frames untagged', async () => {
    const h = createHarness();
    await h.registry.open(alpha);
    await h.registry.open(beta);
    const before = h.broadcasts.length;
    const terminal = {
      type: 'terminalData',
      sessionId: 'session-1',
      runEpoch: 1,
      seq: 0,
      data: '',
    } as unknown as ServerMessage;

    hostAt(h.hosts, 0).emit(marker('from-alpha'));
    hostAt(h.hosts, 1).emit(marker('from-beta'));
    hostAt(h.hosts, 0).emit(terminal);

    expect(h.broadcasts.slice(before)).toEqual([
      { ...marker('from-alpha'), workspacePath: alphaReal },
      { ...marker('from-beta'), workspacePath: betaReal },
      terminal,
    ]);
  });

  it('ensure opens a folder without activating it, and pushes its tagged snapshot', async () => {
    const h = createHarness();
    await h.registry.open(alpha);

    const services = await h.registry.ensure(beta);

    expect(h.hosts).toHaveLength(2);
    expect(services).toBe(hostAt(h.hosts, 1).host.services);
    expect(h.registry.activeServices()).toBe(hostAt(h.hosts, 0).host.services);
    expect(h.registry.activePath()).toBe(alphaReal);
    expect(h.broadcasts).toContainEqual(
      expect.objectContaining({
        type: 'companySnapshot',
        requestId: COMPANY_WORKSPACE_PUSH_REQUEST_ID,
        workspacePath: betaReal,
      }),
    );
    expect(workspaceLists(h.broadcasts).at(-1)).toEqual([
      { path: alphaReal, active: true, open: true, working: 0, waiting: 0, sessions: [] },
      { path: betaReal, active: false, open: true, working: 0, waiting: 0, sessions: [] },
    ]);
  });

  it('ensure answers an open folder from its existing host, with no new host or push', async () => {
    const h = createHarness();
    await h.registry.open(alpha);
    await h.registry.open(beta);
    const before = h.broadcasts.length;

    expect(await h.registry.ensure(alpha)).toBe(hostAt(h.hosts, 0).host.services);
    expect(h.hosts).toHaveLength(2);
    expect(h.broadcasts).toHaveLength(before);
  });

  it('ensure refuses a missing path or a file, and opens no host', async () => {
    const h = createHarness();

    await expect(h.registry.ensure(path.join(root, 'missing'))).rejects.toMatchObject({
      code: 'workspace_invalid',
    });
    await expect(h.registry.ensure(notes)).rejects.toMatchObject({ code: 'workspace_invalid' });

    expect(h.hosts).toHaveLength(0);
    expect(h.broadcasts).toHaveLength(0);
  });

  it('servicesFor, servicesHolding and activePath answer from the open folders', async () => {
    const h = createHarness();
    await h.registry.open(alpha);
    await h.registry.ensure(beta);
    hostAt(h.hosts, 1).state.ids.add('session-beta');

    expect(h.registry.servicesFor(betaReal)).toBe(hostAt(h.hosts, 1).host.services);
    expect(h.registry.servicesFor(path.join(root, 'gone'))).toBeNull();
    expect(h.registry.servicesHolding('session-beta')).toBe(hostAt(h.hosts, 1).host.services);
    expect(h.registry.servicesHolding('nobody')).toBeNull();
    expect(h.registry.activePath()).toBe(alphaReal);

    await h.registry.dispose();
    expect(h.registry.activePath()).toBeNull();
    expect(h.registry.servicesFor(alphaReal)).toBeNull();
    expect(h.registry.servicesHolding('session-beta')).toBeNull();
  });

  it('refuses ensure once the registry is disposed', async () => {
    const h = createHarness();
    await h.registry.dispose();

    await expect(h.registry.ensure(alpha)).rejects.toMatchObject({ code: 'company_unavailable' });
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
      {
        path: alphaReal,
        active: false,
        open: true,
        working: 2,
        waiting: 3,
        sessions: [
          sessionOf('PA-S0003', 'waiting_input'),
          sessionOf('PA-S0001', 'busy'),
          sessionOf('PA-S0002', 'starting'),
          sessionOf('PA-S0004', 'idle'),
        ],
      },
      { path: betaReal, active: true, open: true, working: 0, waiting: 0, sessions: [] },
    ]);
  });

  it('lists recently used folders that are not open after the open ones, without duplicating them', async () => {
    const h = createHarness({ recents: [betaReal, alphaReal] });

    expect(h.registry.entries()).toEqual([
      { path: betaReal, active: false, open: false, working: 0, waiting: 0 },
      { path: alphaReal, active: false, open: false, working: 0, waiting: 0 },
    ]);

    await h.registry.open(alpha);

    expect(h.registry.entries()).toEqual([
      { path: alphaReal, active: true, open: true, working: 0, waiting: 0, sessions: [] },
      { path: betaReal, active: false, open: false, working: 0, waiting: 0 },
    ]);
  });

  it('drops a recent folder that is no longer on disk, and keeps its display name', () => {
    const onDisk = new Set([toPathKey(alphaReal)]);
    const h = createHarness({
      recents: [betaReal, alphaReal],
      folderExists: (workspacePath) => onDisk.has(toPathKey(workspacePath)),
    });
    h.names[toPathKey(betaReal)] = 'Mốc B';

    expect(h.registry.entries()).toEqual([
      { path: alphaReal, active: false, open: false, working: 0, waiting: 0 },
    ]);
    expect(h.names).toEqual({ [toPathKey(betaReal)]: 'Mốc B' });
  });

  it('flags an open folder whose directory was removed, and lists it once', async () => {
    const onDisk = new Set([toPathKey(alphaReal), toPathKey(betaReal)]);
    const h = createHarness({
      recents: [alphaReal, betaReal],
      folderExists: (workspacePath) => onDisk.has(toPathKey(workspacePath)),
    });
    await h.registry.open(alpha);
    onDisk.delete(toPathKey(alphaReal));

    const entries = h.registry.entries();
    expect(entries.filter((entry) => entry.path === alphaReal)).toHaveLength(1);
    expect(entries).toEqual([
      {
        path: alphaReal,
        active: true,
        open: true,
        working: 0,
        waiting: 0,
        missing: true,
        sessions: [],
      },
      { path: betaReal, active: false, open: false, working: 0, waiting: 0 },
    ]);
  });

  it('republishes the folder list when an open folder disappears, without waiting for work', async () => {
    vi.useFakeTimers();
    const onDisk = new Set([toPathKey(alphaReal)]);
    const h = createHarness({
      folderExists: (workspacePath) => onDisk.has(toPathKey(workspacePath)),
    });
    await h.registry.open(alpha);
    const listsBefore = workspaceLists(h.broadcasts).length;

    onDisk.delete(toPathKey(alphaReal));
    await vi.advanceTimersByTimeAsync(COMPANY_WORKSPACE_PRESENCE_CHECK_MS);

    const lists = workspaceLists(h.broadcasts);
    expect(lists).toHaveLength(listsBefore + 1);
    expect(lists.at(-1)).toEqual([
      expect.objectContaining({ path: alphaReal, open: true, missing: true }),
    ]);
    await h.registry.dispose();
  });

  it('forgets a recent folder: drops it from the list and from the recents store', async () => {
    const h = createHarness({ recents: [betaReal, alphaReal] });

    await h.registry.forget(betaReal);

    expect(h.registry.entries()).toEqual([
      { path: alphaReal, active: false, open: false, working: 0, waiting: 0 },
    ]);
    expect(h.recents).toEqual([alphaReal]);
  });

  it('forgets a folder already gone from disk, without needing it to exist', async () => {
    const gone = path.join(root, 'gone');
    const h = createHarness({ recents: [gone] });

    await h.registry.forget(gone);

    expect(h.recents).toEqual([]);
    expect(h.registry.entries()).toEqual([]);
  });

  it('forgets an open folder: stops its Company and leaves no folder active', async () => {
    const h = createHarness();
    await h.registry.open(alpha);

    await h.registry.forget(alphaReal);

    expect(hostAt(h.hosts, 0).state.disposeCalls).toBe(1);
    expect(h.registry.activePath()).toBeNull();
    expect(h.registry.entries()).toEqual([]);
  });

  it('refuses to forget an open folder that still has working or waiting sessions', async () => {
    const h = createHarness();
    await h.registry.open(alpha);
    hostAt(h.hosts, 0).state.snapshot = snapshotWith({ sessions: ['busy'] });

    await expect(h.registry.forget(alphaReal)).rejects.toMatchObject({ code: 'workspace_busy' });

    expect(hostAt(h.hosts, 0).state.disposeCalls).toBe(0);
    expect(h.registry.activePath()).toBe(alphaReal);
  });

  it('refuses a forget the recent list cannot save, and keeps the folder', async () => {
    const h = createHarness({ recents: [betaReal], recentsWritable: false });

    await expect(h.registry.forget(betaReal)).rejects.toMatchObject({
      code: 'company_command_failed',
    });
    expect(h.recents).toEqual([betaReal]);
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
      {
        path: alphaReal,
        active: true,
        open: true,
        working: 1,
        waiting: 0,
        sessions: [sessionOf('PA-S0001', 'busy')],
      },
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

  it('republishes the folder list when a background folder sessions change, and only then', async () => {
    const h = createHarness();
    await h.registry.open(alpha);
    await h.registry.open(beta);
    const alphaHost = hostAt(h.hosts, 0);
    const listsBefore = workspaceLists(h.broadcasts).length;

    vi.useFakeTimers();
    alphaHost.state.snapshot = snapshotOfSessions([sessionOf('PA-S0001', 'waiting_input')]);
    alphaHost.emit(marker('a'));
    await vi.advanceTimersByTimeAsync(250);

    const lists = workspaceLists(h.broadcasts);
    expect(lists).toHaveLength(listsBefore + 1);
    expect(lists.at(-1)).toEqual([
      {
        path: alphaReal,
        active: false,
        open: true,
        working: 0,
        waiting: 1,
        sessions: [sessionOf('PA-S0001', 'waiting_input')],
      },
      { path: betaReal, active: true, open: true, working: 0, waiting: 0, sessions: [] },
    ]);

    alphaHost.emit(marker('b'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(workspaceLists(h.broadcasts)).toHaveLength(listsBefore + 1);
  });

  it('lists a folder whose state cannot be read yet by its counts alone, without sessions', async () => {
    const h = createHarness();
    await h.registry.open(alpha);
    hostAt(h.hosts, 0).state.snapshot = snapshotOfSessions([sessionOf('PA-S0001', 'busy')]);
    hostAt(h.hosts, 0).state.unreadable = true;

    const [entry] = h.registry.entries();
    expect(entry).toEqual({ path: alphaReal, active: true, open: true, working: 0, waiting: 0 });
    expect(entry).not.toHaveProperty('sessions');
  });

  it('carries a display name on an open folder and on a recent one', async () => {
    const h = createHarness({ recents: [betaReal] });
    h.names[toPathKey(alphaReal)] = 'Mốc A';
    h.names[toPathKey(betaReal)] = 'Mốc B';
    await h.registry.open(alpha);

    expect(h.registry.entries()).toEqual([
      {
        path: alphaReal,
        name: 'Mốc A',
        active: true,
        open: true,
        working: 0,
        waiting: 0,
        sessions: [],
      },
      { path: betaReal, name: 'Mốc B', active: false, open: false, working: 0, waiting: 0 },
    ]);
  });

  it('republishes the folder list when a display name is set or cleared', async () => {
    const h = createHarness();
    await h.registry.open(alpha);
    const before = workspaceLists(h.broadcasts).length;

    h.registry.setFolderName(alphaReal, 'Mốc A');
    expect(workspaceLists(h.broadcasts)).toHaveLength(before + 1);
    expect(workspaceLists(h.broadcasts).at(-1)?.[0]).toMatchObject({
      path: alphaReal,
      name: 'Mốc A',
    });

    h.registry.setFolderName(alphaReal, null);
    expect(workspaceLists(h.broadcasts)).toHaveLength(before + 2);
    expect(h.registry.entries()[0]).not.toHaveProperty('name');
  });

  it('refuses a display name the store could not save, and keeps the folder list as it was', async () => {
    const h = createHarness({ namesWritable: false });
    await h.registry.open(alpha);
    const before = workspaceLists(h.broadcasts).length;

    expect(() => h.registry.setFolderName(alphaReal, 'Mốc A')).toThrow(
      'Không lưu được tên thư mục.',
    );
    expect(workspaceLists(h.broadcasts)).toHaveLength(before);
    expect(h.registry.entries()[0]).not.toHaveProperty('name');
  });
});
