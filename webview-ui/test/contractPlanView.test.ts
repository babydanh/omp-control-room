import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { Contract, Requirement, Task, VerificationEvidence } from '../../core/src/company.js';
import { buildContractPlanView } from '../src/company/contractPlanView.js';

function requirement(overrides: Partial<Requirement> = {}): Requirement {
  return {
    id: randomUUID(),
    promptId: randomUUID(),
    fragmentIds: [],
    text: 'ship the feature',
    kind: 'goal',
    status: 'open',
    ...overrides,
  } as Requirement;
}

function task(overrides: Partial<Task> & { code: string }): Task {
  return {
    id: randomUUID(),
    contractId: randomUUID(),
    phaseId: randomUUID(),
    title: 'Do the thing',
    requirementIds: [],
    dependsOn: [],
    workstreamId: randomUUID(),
    readScopes: [],
    writeScopes: [{ path: 'src', kind: 'directory', operations: ['modify'] }],
    sharedResources: [],
    acceptance: [],
    executionMode: 'session',
    status: 'planned',
    attemptIds: [],
    routeReason: '',
    ...overrides,
  } as Task;
}

function contract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: randomUUID(),
    code: 'PA-C0001',
    revision: 2,
    promptIds: [],
    requirements: [],
    phases: [],
    tasks: [],
    assumptions: [],
    decisions: [],
    acceptance: [],
    status: 'awaiting_approval',
    ...overrides,
  } as Contract;
}

describe('contract plan view', () => {
  it('explains what will run, in phase order, before anyone approves', () => {
    const requirementId = randomUUID();
    const phaseId = randomUUID();
    const view = buildContractPlanView(
      contract({
        requirements: [requirement({ id: requirementId, text: 'add the file browser' })],
        phases: [
          { id: phaseId, title: 'Build', ordinal: 1, taskIds: [], acceptanceIds: [] },
          { id: randomUUID(), title: 'Verify', ordinal: 2, taskIds: [], acceptanceIds: [] },
        ],
        tasks: [
          task({ code: 'PA-T0001', phaseId, requirementIds: [requirementId], title: 'List files' }),
          task({ code: 'PA-T0002', phaseId: phaseId, title: 'Read a file' }),
        ],
      }),
    );

    expect(view.code).toBe('PA-C0001');
    expect(view.revision).toBe(2);
    // Two phases, ordered, with their tasks attached.
    expect(view.phases.map((phase) => phase.title)).toEqual(['Build', 'Verify']);
    expect(view.phases[0].tasks.map((entry) => entry.code)).toEqual(['PA-T0001', 'PA-T0002']);
    expect(view.goals[0]).toMatchObject({ text: 'add the file browser', covered: true });
  });

  it('blocks approval while a requirement has no task covering it', () => {
    const covered = requirement({ id: randomUUID() });
    const orphan = requirement({ id: randomUUID(), text: 'nobody planned this' });
    const view = buildContractPlanView(
      contract({
        requirements: [covered, orphan],
        tasks: [task({ code: 'PA-T0001', requirementIds: [covered.id] })],
      }),
    );

    expect(view.gaps.map((gap) => gap.code)).toContain('requirement_without_task');
    expect(view.canApprove).toBe(false);
    expect(view.approvalBlockers.join(' ')).toContain('nobody planned this');
  });

  it('blocks approval when a task declares no acceptance criterion', () => {
    const view = buildContractPlanView(contract({ tasks: [task({ code: 'PA-T0001' })] }));

    expect(view.gaps.map((gap) => gap.code)).toContain('task_without_acceptance');
    expect(view.canApprove).toBe(false);
  });

  it('blocks approval when the contract declares no acceptance criteria at all', () => {
    const withTask = task({ code: 'PA-T0001', acceptance: ['ship it'] });
    const view = buildContractPlanView(contract({ tasks: [withTask] }));

    expect(view.gaps.map((gap) => gap.code)).toContain('contract_without_acceptance');
    expect(view.canApprove).toBe(false);
  });

  it('shows write scope so the user sees what will be touched before approving', () => {
    const view = buildContractPlanView(
      contract({
        acceptance: [
          {
            id: 'c1',
            requirementIds: [],
            description: 'tests pass',
            kind: 'command',
            required: true,
          },
        ],
        tasks: [
          task({
            code: 'PA-T0001',
            acceptance: ['c1'],
            writeScopes: [{ path: 'src/components', kind: 'directory', operations: ['modify'] }],
          }),
        ],
      }),
    );

    // A trailing slash marks a whole-directory scope: the user must be able to
    // see they are approving a subtree, not a single file.
    expect(view.phases[0].tasks[0].writeScopes).toEqual(['src/components/']);
    expect(view.summary.scopeCount).toBe(1);
  });

  it('reports which acceptance criteria have already passed and which have not', () => {
    const passingCommand = 'cmd-1';
    const evidence = [
      {
        id: randomUUID(),
        command: {
          id: passingCommand,
          executable: 'npm',
          argv: ['test'],
          cwd: 'C:/w',
          timeoutSeconds: 600,
        },
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:00:05.000Z',
        exitCode: 0,
      } as VerificationEvidence,
    ];

    const view = buildContractPlanView(
      contract({
        acceptance: [
          {
            id: 'c1',
            requirementIds: [],
            description: 'tests pass',
            kind: 'command',
            required: true,
          },
          {
            id: 'c2',
            requirementIds: [],
            description: 'lint clean',
            kind: 'command',
            required: true,
          },
        ],
        tasks: [task({ code: 'PA-T0001', acceptance: ['c1', 'c2'] })],
      }),
      // The criterion -> command mapping is supplied by the caller, exactly as
      // the workflow gate requires.
      new Map([
        ['c1', ['cmd-1']],
        ['c2', ['cmd-2']],
      ]),
      evidence,
    );

    const states = view.acceptance.map((criterion) => [criterion.id, criterion.state]);
    expect(states).toContainEqual(['c1', 'passed']);
    expect(states).toContainEqual(['c2', 'not_run']);
  });
});
