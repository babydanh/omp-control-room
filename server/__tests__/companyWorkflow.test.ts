import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type {
  AcceptanceCriterion,
  Contract,
  Task,
  VerificationEvidence,
} from '../../core/src/company.js';
import {
  detectDependencyCycles,
  evaluateVerification,
  nextAttemptOutcome,
  selectReadyTasks,
  validateContract,
  writeScopesOverlap,
} from '../src/company/companyWorkflow.js';

function task(overrides: Partial<Task> & { code: string }): Task {
  return {
    id: randomUUID(),
    contractId: randomUUID(),
    phaseId: randomUUID(),
    title: overrides.code,
    requirementIds: [],
    dependsOn: [],
    workstreamId: randomUUID(),
    readScopes: [],
    writeScopes: [],
    sharedResources: [],
    acceptance: ['built and reviewed'],
    executionMode: 'session',
    status: 'planned',
    attemptIds: [],
    routeReason: 'test',
    ...overrides,
  } as Task;
}

function contract(tasks: Task[], overrides: Partial<Contract> = {}): Contract {
  return {
    id: randomUUID(),
    code: 'PA-C0001',
    revision: 1,
    promptIds: [],
    requirements: [],
    phases: [],
    tasks,
    assumptions: [],
    decisions: [],
    acceptance: [],
    status: 'awaiting_approval',
    ...overrides,
  } as Contract;
}

function criterion(overrides: Partial<AcceptanceCriterion> & { id: string }): AcceptanceCriterion {
  return {
    requirementIds: [randomUUID()],
    description: 'verification passes',
    kind: 'command',
    required: true,
    ...overrides,
  } as AcceptanceCriterion;
}

describe('contract validation', () => {
  it('rejects a dependency cycle instead of scheduling it', () => {
    // Two independent 2-cycles: a <-> cyclicB and b <-> cyclicA.
    const a = task({ code: 'PA-T0001' });
    const b = task({ code: 'PA-T0002' });
    const cyclicA = task({ code: 'PA-T0003', dependsOn: [b.id] });
    const cyclicB = task({ code: 'PA-T0004', dependsOn: [a.id] });
    a.dependsOn = [cyclicB.id];
    b.dependsOn = [cyclicA.id];
    const tasks = [a, b, cyclicA, cyclicB];

    const result = validateContract(contract(tasks));

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('contract_dependency_cycle');
    expect(detectDependencyCycles(tasks).sort()).toEqual([
      'PA-T0001',
      'PA-T0002',
      'PA-T0003',
      'PA-T0004',
    ]);
  });

  it('reports a task whose dependency is not in the contract', () => {
    const orphan = task({ code: 'PA-T0001', dependsOn: [randomUUID()] });

    const result = validateContract(contract([orphan]));

    expect(result.issues.map((issue) => issue.code)).toContain('task_dependency_unknown');
  });

  it('rejects a task whose acceptance is empty and a criterion with no requirement', () => {
    const result = validateContract(
      contract([task({ code: 'PA-T0001', acceptance: [] })], {
        acceptance: [criterion({ id: randomUUID(), requirementIds: [] })],
      }),
    );

    expect(result.ok).toBe(false);
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toContain('task_acceptance_empty');
    expect(codes).toContain('criterion_without_requirement');
  });

  it('accepts a contract whose tasks form a DAG with covered criteria', () => {
    const requirementId = randomUUID();
    const first = task({ code: 'PA-T0001', requirementIds: [requirementId] });
    const second = task({
      code: 'PA-T0002',
      dependsOn: [first.id],
      requirementIds: [requirementId],
    });

    const result = validateContract(
      contract([first, second], {
        requirements: [
          {
            id: requirementId,
            promptId: randomUUID(),
            fragmentIds: [],
            text: 'do it',
            kind: 'goal',
            status: 'planned',
          },
        ],
        acceptance: [criterion({ id: randomUUID(), requirementIds: [requirementId] })],
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });
});

describe('scheduling', () => {
  it('never exceeds the worker bound no matter how many tasks are ready', () => {
    const tasks = Array.from({ length: 12 }, (_, index) =>
      task({ code: `PA-T${String(index + 1).padStart(4, '0')}`, status: 'ready' }),
    );

    const plan = selectReadyTasks(tasks, { maxWorkers: 4 });

    expect(plan.runnable).toHaveLength(4);
    expect(plan.queued).toHaveLength(8);
  });

  it('holds a task whose dependency is not done', () => {
    const first = task({ code: 'PA-T0001' });
    const second = task({ code: 'PA-T0002', dependsOn: [first.id] });

    const plan = selectReadyTasks([first, second], { maxWorkers: 4 });

    expect(plan.runnable.map((entry) => entry.code)).toEqual(['PA-T0001']);
    expect(plan.held.map((entry) => entry.reason)).toEqual(['dependency_not_done']);
  });

  it('serializes tasks that write overlapping paths, including case variants', () => {
    const first = task({
      code: 'PA-T0001',
      status: 'ready',
      writeScopes: [{ path: 'src/App.tsx', kind: 'file', operations: ['modify'] }],
    });
    const clash = task({
      code: 'PA-T0002',
      status: 'ready',
      writeScopes: [{ path: 'src/app.TSX', kind: 'file', operations: ['modify'] }],
    });
    const disjoint = task({
      code: 'PA-T0003',
      status: 'ready',
      writeScopes: [{ path: 'src/other.ts', kind: 'file', operations: ['modify'] }],
    });

    const plan = selectReadyTasks([first, clash, disjoint], { maxWorkers: 4 });

    expect(plan.runnable.map((entry) => entry.code)).toEqual(['PA-T0001', 'PA-T0003']);
    expect(plan.held.find((entry) => entry.code === 'PA-T0002')?.reason).toBe('scope_conflict');
    expect(writeScopesOverlap(first.writeScopes, clash.writeScopes)).toBe(true);
    expect(writeScopesOverlap(first.writeScopes, disjoint.writeScopes)).toBe(false);
  });

  it('treats a directory scope as conflicting with a file inside it', () => {
    const directory = task({
      code: 'PA-T0001',
      status: 'ready',
      writeScopes: [{ path: 'src', kind: 'directory', operations: ['modify'] }],
    });
    const nested = task({
      code: 'PA-T0002',
      status: 'ready',
      writeScopes: [{ path: 'src/feature/file.ts', kind: 'file', operations: ['modify'] }],
    });

    const plan = selectReadyTasks([directory, nested], { maxWorkers: 4 });

    expect(plan.runnable.map((entry) => entry.code)).toEqual(['PA-T0001']);
    expect(plan.held.find((entry) => entry.code === 'PA-T0002')?.reason).toBe('scope_conflict');
  });
});

describe('verification gate', () => {
  function evidenceFor(commandId: string, overrides: Partial<VerificationEvidence> = {}) {
    return {
      id: randomUUID(),
      command: {
        id: commandId,
        executable: 'npm',
        argv: ['test'],
        cwd: 'C:/w',
        timeoutSeconds: 600,
      },
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:10.000Z',
      exitCode: 0,
      ...overrides,
    } as VerificationEvidence;
  }

  it('refuses to pass a required criterion whose command exited non-zero', () => {
    const required = criterion({ id: 'c1' });
    const commands = new Map([['c1', ['cmd-1']]]);

    const verdict = evaluateVerification([required], commands, [
      evidenceFor('cmd-1', { exitCode: 1 }),
    ]);

    expect(verdict.passed).toBe(false);
    expect(verdict.criteria[0]).toMatchObject({ id: 'c1', passed: false });
  });

  it('treats a missing exit code (timeout or kill) as blocked rather than passed', () => {
    const required = criterion({ id: 'c1' });
    const timedOut = evidenceFor('cmd-1');
    delete (timedOut as { exitCode?: number }).exitCode;

    const verdict = evaluateVerification([required], new Map([['c1', ['cmd-1']]]), [timedOut]);

    expect(verdict.passed).toBe(false);
    expect(verdict.issues[0]).toContain('no exit code');
  });

  it('reports a criterion with no recorded evidence at all', () => {
    const required = criterion({ id: 'c1' });

    const verdict = evaluateVerification([required], new Map([['c1', ['cmd-1']]]), []);

    expect(verdict.passed).toBe(false);
    expect(verdict.issues[0]).toContain('No verification evidence');
  });

  it('passes only when every required criterion has successful evidence', () => {
    const lint = criterion({ id: 'c1' });
    const build = criterion({ id: 'c2' });
    const optional = criterion({ id: 'c3', required: false });
    const commands = new Map([
      ['c1', ['cmd-1']],
      ['c2', ['cmd-2']],
      ['c3', ['cmd-3']],
    ]);

    const verdict = evaluateVerification([lint, build, optional], commands, [
      evidenceFor('cmd-1'),
      evidenceFor('cmd-2'),
      // The optional criterion failed; it must not block the verdict.
      evidenceFor('cmd-3', { exitCode: 1 }),
    ]);

    expect(verdict.passed).toBe(true);
    expect(verdict.criteria.find((entry) => entry.id === 'c3')?.passed).toBe(false);
  });

  it('never passes a task held only to optional criteria, even with no evidence', () => {
    const note = criterion({ id: 'c1', required: false });

    expect(evaluateVerification([note], new Map(), []).passed).toBe(false);
  });
});

describe('repair bound', () => {
  it('asks for changes twice before giving up, then stops asking', () => {
    expect(nextAttemptOutcome(1)).toEqual({ status: 'changes_requested', repairCycles: 1 });
    expect(nextAttemptOutcome(2)).toEqual({ status: 'changes_requested', repairCycles: 2 });
    expect(nextAttemptOutcome(3)).toEqual({ status: 'failed', repairCycles: 2 });
  });
});
