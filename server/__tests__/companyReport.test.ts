import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { CompanyState, Contract, Task, VerificationEvidence } from '../../core/src/company.js';
import { buildCompanyReport } from '../src/company/companyReport.js';
import { createInitialCompanyState } from '../src/company/companyState.js';

const CRITERION_OK = 'c-ok';
const CRITERION_FAIL = 'c-fail';
const CONTRACT_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const COMMAND_OK = 'cmd-ok';
const COMMAND_FAIL = 'cmd-fail';

function evidence(commandId: string, exitCode: number): VerificationEvidence {
  return {
    id: randomUUID(),
    command: { id: commandId, executable: 'npm', argv: ['test'], cwd: 'C:/w', timeoutSeconds: 600 },
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:04.000Z',
    exitCode,
  } as VerificationEvidence;
}

interface ReportFixture {
  state: CompanyState;
  doneTask: Task;
  failedTask: Task;
  failingEvidenceId: string;
}

function fixture(): ReportFixture {
  const requirementOk = randomUUID();
  const requirementFail = randomUUID();
  const contract: Contract = {
    id: CONTRACT_ID,
    code: 'PA-C0001',
    revision: 2,
    promptIds: [randomUUID()],
    requirements: [
      {
        id: requirementOk,
        promptId: randomUUID(),
        fragmentIds: [],
        text: 'list workspace files',
        kind: 'goal',
        status: 'satisfied',
      },
      {
        id: requirementFail,
        promptId: randomUUID(),
        fragmentIds: [],
        text: 'read a file safely',
        kind: 'goal',
        status: 'blocked',
      },
    ] as Contract['requirements'],
    phases: [
      {
        id: 'p1',
        title: 'Build',
        ordinal: 1,
        taskIds: [],
        acceptanceIds: [CRITERION_OK, CRITERION_FAIL],
      },
    ],
    tasks: [],
    assumptions: ['npm scripts already exist'],
    decisions: [],
    acceptance: [
      {
        id: CRITERION_OK,
        requirementIds: [requirementOk],
        description: 'listing works',
        kind: 'command',
        required: true,
      },
      {
        id: CRITERION_FAIL,
        requirementIds: [requirementFail],
        description: 'traversal refused',
        kind: 'command',
        required: true,
      },
    ],
    status: 'running',
  } as Contract;

  const attemptOk = randomUUID();
  const attemptFail = randomUUID();
  const doneTask: Task = {
    id: randomUUID(),
    code: 'PA-T0001',
    contractId: CONTRACT_ID,
    phaseId: 'p1',
    title: 'List files',
    requirementIds: [requirementOk],
    dependsOn: [],
    workstreamId: 'w1',
    readScopes: [],
    writeScopes: [{ path: 'src', kind: 'directory', operations: ['modify'] }],
    sharedResources: [],
    acceptance: [CRITERION_OK],
    executionMode: 'session',
    sessionId: SESSION_ID,
    status: 'done',
    attemptIds: [attemptOk],
    routeReason: 'first worker',
  } as Task;
  const failedTask: Task = {
    id: randomUUID(),
    code: 'PA-T0002',
    contractId: CONTRACT_ID,
    phaseId: 'p1',
    title: 'Read a file',
    requirementIds: [requirementFail],
    dependsOn: [doneTask.id],
    workstreamId: 'w2',
    readScopes: [],
    writeScopes: [],
    sharedResources: [],
    acceptance: [CRITERION_FAIL],
    executionMode: 'session',
    sessionId: SESSION_ID,
    status: 'changes_requested',
    attemptIds: [attemptFail],
    routeReason: 'second worker',
  } as Task;

  const okEvidence = evidence(COMMAND_OK, 0);
  const failEvidence = evidence(COMMAND_FAIL, 1);

  const state: CompanyState = {
    ...createInitialCompanyState('C:/workspace'),
    contracts: { [CONTRACT_ID]: { ...contract, tasks: [doneTask, failedTask] } },
    tasks: { [doneTask.id]: doneTask, [failedTask.id]: failedTask },
    attempts: {
      [attemptOk]: {
        id: attemptOk,
        taskId: doneTask.id,
        sessionId: SESSION_ID,
        runEpoch: 0,
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:00:04.000Z',
        status: 'passed',
        changes: [
          { path: 'src/companyFiles.ts', kind: 'create', summary: 'workspace file listing' },
        ],
        evidenceIds: [okEvidence.id],
      },
      [attemptFail]: {
        id: attemptFail,
        taskId: failedTask.id,
        sessionId: SESSION_ID,
        runEpoch: 0,
        startedAt: '2026-01-01T00:00:05.000Z',
        endedAt: '2026-01-01T00:00:09.000Z',
        status: 'failed',
        changes: [],
        evidenceIds: [failEvidence.id],
      },
    } as CompanyState['attempts'],
    evidence: {
      [okEvidence.id]: okEvidence,
      [failEvidence.id]: failEvidence,
    } as CompanyState['evidence'],
    sessions: {
      [SESSION_ID]: {
        id: SESSION_ID,
        code: 'PA-S0001',
        name: 'worker-1',
        role: 'worker',
        workstreamId: 'w1',
        workspaceKey: 'c:/workspace',
        requestedModel: 'p/m',
        runEpoch: 0,
        status: 'idle',
        lastUsedAt: '2026-01-01T00:00:09.000Z',
      },
    } as CompanyState['sessions'],
  };

  return { state, doneTask, failedTask, failingEvidenceId: failEvidence.id };
}

const commands = new Map([
  [CRITERION_OK, [COMMAND_OK]],
  [CRITERION_FAIL, [COMMAND_FAIL]],
]);

describe('company report', () => {
  it('maps every requirement to its tasks, attempts and evidence', () => {
    const { state, doneTask, failedTask } = fixture();

    const report = buildCompanyReport(state, CONTRACT_ID, commands);

    expect(report.contractId).toBe(CONTRACT_ID);
    expect(report.revision).toBe(2);
    expect(report.requirements).toHaveLength(2);
    const [ok, fail] = report.requirements;
    expect(ok.taskIds).toEqual([doneTask.id]);
    expect(ok.result).toBe('satisfied');
    expect(fail.taskIds).toEqual([failedTask.id]);
    expect(fail.evidenceIds.length).toBeGreaterThan(0);
  });

  it('never marks a requirement satisfied while its evidence failed', () => {
    const { state, failingEvidenceId } = fixture();

    const report = buildCompanyReport(state, CONTRACT_ID, commands);
    const failed = report.requirements.find((entry) => entry.result !== 'satisfied');

    expect(failed).toBeDefined();
    expect(failed?.evidenceIds).toContain(failingEvidenceId);
    // Nothing may claim the whole run is done while one requirement is not.
    expect(report.requirements.every((entry) => entry.result === 'satisfied')).toBe(false);
  });

  it('lists the files the run actually changed', () => {
    const { state } = fixture();

    const report = buildCompanyReport(state, CONTRACT_ID, commands);

    expect(report.relatedChanges.map((change) => change.path)).toContain('src/companyFiles.ts');
    expect(report.relatedChanges[0].kind).toBe('create');
  });

  it('carries every evidence id and the sessions behind the result', () => {
    const { state } = fixture();

    const report = buildCompanyReport(state, CONTRACT_ID, commands);

    expect(report.verificationEvidenceIds).toHaveLength(2);
    expect(report.sessions).toHaveLength(1);
    expect(report.sessions[0]).toMatchObject({
      sessionId: SESSION_ID,
      role: 'worker',
      requestedModel: 'p/m',
    });
  });

  it('reports a missing contract rather than inventing an empty report', () => {
    const { state } = fixture();

    expect(() => buildCompanyReport(state, randomUUID(), commands)).toThrowError(
      expect.objectContaining({ code: 'contract_not_found' }),
    );
  });
});
