import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CompanySession, Contract, Phase, Task, WriteScope } from '../../core/src/company.js';
import { Scheduler } from '../src/company/scheduler.js';
import { WorkspaceLockTable } from '../src/company/workspaceLocks.js';

let tempHome: string;
let workspace: string;

beforeEach(async () => {
  tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pxl-company-sched-'));
  workspace = path.join(tempHome, 'workspace');
  await fs.promises.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.promises.mkdir(path.join(workspace, 'lib'), { recursive: true });
  for (const name of ['a', 'b', 'c', 'd', 'e']) {
    await fs.promises.writeFile(path.join(workspace, 'src', `${name}.ts`), 'export {};\n');
  }
});

afterEach(async () => {
  await fs.promises.rm(tempHome, { recursive: true, force: true });
});

function scope(p: string): WriteScope[] {
  return [{ path: p, kind: 'file', operations: ['modify'] }];
}

function task(overrides: Partial<Task> & { code: string; phaseId: string }): Task {
  return {
    id: randomUUID(),
    contractId: randomUUID(),
    title: overrides.code,
    requirementIds: [],
    dependsOn: [],
    workstreamId: randomUUID(),
    readScopes: [],
    writeScopes: [],
    sharedResources: [],
    acceptance: ['build passes'],
    executionMode: 'session',
    status: 'planned',
    attemptIds: [],
    routeReason: 'test',
    ...overrides,
  } as Task;
}

function contract(tasks: Task[], overrides: Partial<Contract> = {}): Contract {
  const phases: Phase[] = [
    { id: 'phase-1', title: 'Foundation', ordinal: 1, taskIds: [], acceptanceIds: [] },
    { id: 'phase-2', title: 'Features', ordinal: 2, taskIds: [], acceptanceIds: [] },
  ];
  return {
    id: randomUUID(),
    code: 'PA-C0001',
    revision: 1,
    promptIds: [],
    requirements: [],
    phases,
    tasks,
    assumptions: [],
    decisions: [],
    acceptance: [],
    status: 'running',
    ...overrides,
  } as Contract;
}

function scheduler(limits?: {
  maxWorkers?: number;
  maxConcurrentModelCalls?: number;
  maxLiveRunners?: number;
}) {
  const locks = new WorkspaceLockTable({ workspaceRoot: workspace, caseInsensitive: true });
  return { locks, scheduler: new Scheduler({ locks, ...(limits ? { limits } : {}) }) };
}

describe('dispatch order', () => {
  it('starts the lowest phase first, and creation order inside a phase', () => {
    const first = task({ code: 'PA-T0001', phaseId: 'phase-1' });
    const second = task({ code: 'PA-T0002', phaseId: 'phase-1' });
    const later = task({ code: 'PA-T0003', phaseId: 'phase-2' });
    const { scheduler: engine } = scheduler();
    const input = contract([later, first, second]);

    const plan = engine.plan({ contract: input, sessions: [] });

    expect(plan.dispatch.map((entry) => entry.code)).toEqual(['PA-T0001', 'PA-T0002', 'PA-T0003']);
  });

  it('starts nothing until the Contract revision is approved', () => {
    const pending = task({ code: 'PA-T0001', phaseId: 'phase-1' });
    const { scheduler: engine } = scheduler();

    const plan = engine.plan({
      contract: contract([pending], { status: 'awaiting_approval' }),
      sessions: [],
    });

    expect(plan.dispatch).toEqual([]);
    expect(plan.waiting[0].reason).toBe('contract_not_approved');
  });
});

describe('dependency gating', () => {
  it('holds a task whose dependency is not done', () => {
    const first = task({ code: 'PA-T0001', phaseId: 'phase-1', status: 'planned' });
    const second = task({ code: 'PA-T0002', phaseId: 'phase-1', dependsOn: [first.id] });
    const { scheduler: engine } = scheduler();

    const plan = engine.plan({ contract: contract([first, second]), sessions: [] });

    expect(plan.dispatch.map((entry) => entry.code)).toEqual(['PA-T0001']);
    expect(plan.waiting[0]).toMatchObject({ code: 'PA-T0002', reason: 'dependency_not_done' });
  });

  it('does not treat a verifying task as a finished dependency', () => {
    const first = task({ code: 'PA-T0001', phaseId: 'phase-1', status: 'verifying' });
    const second = task({ code: 'PA-T0002', phaseId: 'phase-1', dependsOn: [first.id] });
    const { scheduler: engine } = scheduler();

    const plan = engine.plan({ contract: contract([first, second]), sessions: [] });

    expect(plan.dispatch.map((entry) => entry.code)).toEqual([]);
    expect(plan.waiting.map((entry) => entry.reason)).toEqual([
      'status_not_runnable',
      'dependency_not_done',
    ]);
  });

  it('refuses a dependency that is not in the Contract at all', () => {
    const orphan = task({ code: 'PA-T0001', phaseId: 'phase-1', dependsOn: [randomUUID()] });
    const { scheduler: engine } = scheduler();

    const plan = engine.plan({ contract: contract([orphan]), sessions: [] });

    expect(plan.dispatch).toEqual([]);
    expect(plan.waiting[0].reason).toBe('dependency_unknown');
  });

  it('reports a dependency cycle instead of waiting forever', () => {
    const a = task({ code: 'PA-T0001', phaseId: 'phase-1' });
    const b = task({ code: 'PA-T0002', phaseId: 'phase-1', dependsOn: [a.id] });
    a.dependsOn = [b.id];
    const { scheduler: engine } = scheduler();

    const plan = engine.plan({ contract: contract([a, b]), sessions: [] });

    expect(plan.dispatch).toEqual([]);
    expect(plan.waiting.map((entry) => entry.reason)).toEqual([
      'dependency_cycle',
      'dependency_cycle',
    ]);
  });

  it('holds a task assigned to a session that is already busy', () => {
    const session = {
      id: randomUUID(),
      code: 'PA-S0001',
      status: 'busy',
    } as CompanySession;
    const assigned = task({ code: 'PA-T0001', phaseId: 'phase-1', sessionId: session.id });
    const { scheduler: engine } = scheduler();

    const plan = engine.plan({ contract: contract([assigned]), sessions: [session] });

    expect(plan.dispatch).toEqual([]);
    expect(plan.waiting[0].reason).toBe('session_busy');
  });
});

describe('scope and resource gating', () => {
  it('holds a task whose write scope is inside a running task directory', () => {
    const broad = task({
      code: 'PA-T0001',
      phaseId: 'phase-1',
      writeScopes: [{ path: 'src', kind: 'directory', operations: ['modify'] }],
    });
    const narrow = task({ code: 'PA-T0002', phaseId: 'phase-1', writeScopes: scope('src/a.ts') });
    const { scheduler: engine } = scheduler();

    const plan = engine.plan({ contract: contract([broad, narrow]), sessions: [] });

    expect(plan.dispatch.map((entry) => entry.code)).toEqual(['PA-T0001']);
    expect(plan.waiting[0]).toMatchObject({ code: 'PA-T0002', reason: 'scope_conflict' });
    expect(plan.waiting[0].detail).toContain('PA-T0001');
  });

  it('holds a task that declares a resource another task holds', () => {
    const first = task({
      code: 'PA-T0001',
      phaseId: 'phase-1',
      writeScopes: scope('src/a.ts'),
      sharedResources: ['package-lock.json'],
    });
    const second = task({
      code: 'PA-T0002',
      phaseId: 'phase-1',
      writeScopes: scope('src/b.ts'),
      sharedResources: ['package-lock.json'],
    });
    const { scheduler: engine } = scheduler();

    const plan = engine.plan({ contract: contract([first, second]), sessions: [] });

    expect(plan.dispatch.map((entry) => entry.code)).toEqual(['PA-T0001']);
    expect(plan.waiting[0].reason).toBe('resource_conflict');
  });

  it('flags a task whose scope could not be resolved as workspace-wide', () => {
    const escaping = task({
      code: 'PA-T0001',
      phaseId: 'phase-1',
      writeScopes: scope('../outside.ts'),
    });
    const { scheduler: engine } = scheduler();

    const plan = engine.plan({ contract: contract([escaping]), sessions: [] });

    expect(plan.dispatch[0].workspaceWide).toBe(true);
  });
});

describe('capacity', () => {
  it('never runs more tasks at once than the worker bound allows', () => {
    const tasks = Array.from({ length: 12 }, (_, index) =>
      task({
        code: `PA-T${index + 1}`,
        phaseId: 'phase-1',
        writeScopes: scope(`src/${'abcde'[index]}.ts`),
      }),
    );
    const { scheduler: engine } = scheduler({ maxWorkers: 4, maxConcurrentModelCalls: 4 });

    const plan = engine.plan({ contract: contract(tasks), sessions: [] });

    expect(plan.dispatch).toHaveLength(4);
    expect(plan.waiting).toHaveLength(8);
    expect(plan.capacity.workers).toBe(4);
    expect(plan.capacity.modelCalls).toBe(4);
    expect(new Set(plan.waiting.map((entry) => entry.reason))).toEqual(new Set(['worker_limit']));
  });

  it('bounds concurrent provider calls independently of the worker bound', () => {
    const tasks = Array.from({ length: 6 }, (_, index) =>
      task({
        code: `PA-T${index + 1}`,
        phaseId: 'phase-1',
        writeScopes: scope(`src/${'abcde'[index]}.ts`),
      }),
    );
    const { scheduler: engine } = scheduler({ maxWorkers: 6, maxConcurrentModelCalls: 2 });

    const plan = engine.plan({ contract: contract(tasks), sessions: [] });

    expect(plan.dispatch).toHaveLength(2);
    expect(new Set(plan.waiting.map((entry) => entry.reason))).toEqual(
      new Set(['model_call_limit']),
    );
  });

  it('only counts a runner for work that needs its own session', () => {
    const inline = Array.from({ length: 3 }, (_, index) =>
      task({
        code: `PA-T${index + 1}`,
        phaseId: 'phase-1',
        executionMode: 'inline',
        writeScopes: scope(`src/${'abc'[index]}.ts`),
      }),
    );
    const { scheduler: engine } = scheduler({ maxLiveRunners: 1 });

    const plan = engine.plan({ contract: contract(inline), sessions: [] });

    expect(plan.dispatch).toHaveLength(3);
    expect(plan.capacity.liveRunners).toBe(0);
  });

  it('holds a session task once every runner is taken', () => {
    const tasks = Array.from({ length: 3 }, (_, index) =>
      task({
        code: `PA-T${index + 1}`,
        phaseId: 'phase-1',
        writeScopes: scope(`src/${'abc'[index]}.ts`),
      }),
    );
    const { scheduler: engine } = scheduler({ maxLiveRunners: 2, maxWorkers: 4 });

    const plan = engine.plan({ contract: contract(tasks), sessions: [] });

    expect(plan.dispatch).toHaveLength(2);
    expect(plan.waiting[0].reason).toBe('live_runner_limit');
  });

  it('counts live managed sessions against the runner bound before dispatching', () => {
    const busy = Array.from(
      { length: 4 },
      () => ({ id: randomUUID(), status: 'busy' }) as CompanySession,
    );
    const { scheduler: engine } = scheduler({ maxLiveRunners: 4, maxWorkers: 4 });

    const plan = engine.plan({
      contract: contract([task({ code: 'PA-T0001', phaseId: 'phase-1' })]),
      sessions: busy,
    });

    expect(plan.dispatch).toEqual([]);
    expect(plan.waiting[0].reason).toBe('live_runner_limit');
  });
});

describe('lock and lease ownership', () => {
  it('releases the scopes of a task whose lease was refused', () => {
    const first = task({ code: 'PA-T0001', phaseId: 'phase-1', writeScopes: scope('src/a.ts') });
    const second = task({ code: 'PA-T0002', phaseId: 'phase-1', writeScopes: scope('src/b.ts') });
    const { locks, scheduler: engine } = scheduler({ maxWorkers: 1 });

    const plan = engine.plan({ contract: contract([first, second]), sessions: [] });

    expect(plan.dispatch.map((entry) => entry.code)).toEqual(['PA-T0001']);
    expect(plan.waiting[0].reason).toBe('worker_limit');
    // The refused task must not leave `src/b.ts` locked against everyone else.
    expect(locks.acquire({ ownerId: 'other', scopes: scope('src/b.ts') }).granted).toBe(true);
  });

  it('holds the scopes of every task it did dispatch', () => {
    const first = task({ code: 'PA-T0001', phaseId: 'phase-1', writeScopes: scope('src/a.ts') });
    const { locks, scheduler: engine } = scheduler();

    engine.plan({ contract: contract([first]), sessions: [] });

    expect(locks.acquire({ ownerId: 'other', scopes: scope('src/a.ts') }).granted).toBe(false);
  });

  it('does not dispatch the same task twice from two consecutive plans', () => {
    const only = task({ code: 'PA-T0001', phaseId: 'phase-1' });
    const { scheduler: engine } = scheduler();
    const input = contract([only]);

    expect(engine.plan({ contract: input, sessions: [] }).dispatch).toHaveLength(1);
    expect(engine.plan({ contract: input, sessions: [] }).waiting[0].reason).toBe(
      'already_dispatched',
    );
  });

  it('frees the lock and the leases when a task is released', () => {
    const only = task({ code: 'PA-T0001', phaseId: 'phase-1', writeScopes: scope('src/a.ts') });
    const { locks, scheduler: engine } = scheduler();
    engine.plan({ contract: contract([only]), sessions: [] });

    engine.release(only.id);

    expect(locks.acquire({ ownerId: 'other', scopes: scope('src/a.ts') }).granted).toBe(true);
    expect(engine.capacitySnapshot()).toMatchObject({ workers: 0, modelCalls: 0, liveRunners: 0 });
  });
});
