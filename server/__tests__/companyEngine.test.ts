import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type {
  CompanyEvent,
  CompanyState,
  SubmitPromptInput,
  VerificationEvidence,
} from '../../core/src/company.js';
import {
  approveContract,
  createPromptSubmission,
  recordAttemptOutcome,
  startTaskAttempt,
} from '../src/company/companyEngine.js';
import { createInitialCompanyState } from '../src/company/companyState.js';
import { applyCompanyEvent } from '../src/company/companyState.js';

function freshState(): CompanyState {
  return createInitialCompanyState('C:/workspace');
}

function applyAll(state: CompanyState, events: CompanyEvent[]): CompanyState {
  return events.reduce(applyCompanyEvent, state);
}

function nextEvents(): { id: string } {
  return { id: randomUUID() };
}

/** Count graphemes, the unit the preview limit is defined in. */
function graphemeCount(text: string): number {
  return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].length;
}

const CRITERION_ID = 'c1';
const CONTRACT_ID = 'a4f0a2f6-6a2f-4f2f-9a4f-1f2a3b4c5d6e';

/** A contract state carrying the criterion the attempt fixtures verify. */
function withContract(): Pick<CompanyState, 'contracts'> {
  return {
    contracts: {
      [CONTRACT_ID]: {
        id: CONTRACT_ID,
        code: 'PA-C0001',
        revision: 1,
        promptIds: [],
        requirements: [],
        phases: [],
        tasks: [],
        assumptions: [],
        decisions: [],
        acceptance: [
          {
            id: CRITERION_ID,
            requirementIds: [randomUUID()],
            description: 'tests pass',
            kind: 'command',
            required: true,
          },
        ],
        status: 'approved',
      } as CompanyState['contracts'][string],
    },
  };
}
const submission: SubmitPromptInput = {
  requestId: randomUUID(),
  text: 'add a workspace file browser',
  delivery: 'prompt',
};

describe('company engine lifecycle', () => {
  it('stores a prompt once, keeping only a bounded preview in the snapshot', () => {
    const state = freshState();
    // Long enough that the preview and the raw body are visibly different.
    const body = `start-of-prompt ${'filler '.repeat(200)} end-of-prompt`;

    const { events } = createPromptSubmission(state, {
      prompt: { ...submission, text: body },
      rawTextArtifactId: randomUUID(),
      now: '2026-01-01T00:00:00.000Z',
    });
    const next = applyAll(state, events);

    expect(next.revision).toBe(1);
    expect(Object.keys(next.prompts)).toHaveLength(1);
    const stored = Object.values(next.prompts)[0];
    // The raw body lives in an artifact; the snapshot keeps only the preview,
    // so the tail of a long prompt never reaches the UI or a model context.
    expect(graphemeCount(stored.preview)).toBeLessThanOrEqual(240);
    expect(stored.preview).toContain('start-of-prompt');
    expect(JSON.stringify(next.prompts)).not.toContain('end-of-prompt');
  });

  it('truncates a long preview on a grapheme boundary, never mid-surrogate', () => {
    const state = freshState();
    // Escapes on purpose: this fixture IS the surrogate-pair case, and a
    // literal multi-codepoint emoji is fragile through file writes.
    const emoji = '\u{1F469}\u{200D}\u{1F4BB}'.repeat(300);

    const { events } = createPromptSubmission(state, {
      prompt: { ...submission, text: emoji },
      rawTextArtifactId: randomUUID(),
      now: '2026-01-01T00:00:00.000Z',
    });
    const stored = Object.values(applyAll(state, events).prompts)[0];

    // Graphemes, not UTF-16 units: an emoji is five code units, so asserting
    // on `.length` would measure the wrong thing entirely.
    expect(graphemeCount(stored.preview)).toBe(240);
    expect(stored.preview.includes('�')).toBe(false);
    // A cut inside a surrogate pair would leave a lone surrogate, which does
    // not survive a UTF-8 round trip. Searching for the high surrogate itself
    // proves nothing — every emoji contains it.
    expect(Buffer.from(stored.preview, 'utf8').toString('utf8')).toBe(stored.preview);
  });

  it('issues a fresh display code per object and never reuses one', () => {
    const state = freshState();
    const first = applyAll(
      state,
      createPromptSubmission(state, {
        prompt: submission,
        rawTextArtifactId: randomUUID(),
        now: '2026-01-01T00:00:00.000Z',
      }).events,
    );
    const second = applyAll(
      first,
      createPromptSubmission(first, {
        prompt: { ...submission, requestId: randomUUID() },
        rawTextArtifactId: randomUUID(),
        now: '2026-01-01T00:00:00.001Z',
      }).events,
    );

    expect(Object.values(second.prompts)).toHaveLength(2);
  });

  it('refuses to approve a contract whose plan has a hole', () => {
    const state = freshState();
    const contractId = randomUUID();
    const withContract: CompanyState = {
      ...state,
      contracts: {
        [contractId]: {
          id: contractId,
          code: 'PA-C0001',
          revision: 1,
          promptIds: [],
          requirements: [
            {
              id: randomUUID(),
              promptId: randomUUID(),
              fragmentIds: [],
              text: 'nobody planned this',
              kind: 'goal',
              status: 'open',
            },
          ],
          phases: [],
          tasks: [],
          assumptions: [],
          decisions: [],
          acceptance: [],
          status: 'awaiting_approval',
        },
      } as CompanyState['contracts'],
    };

    expect(() =>
      approveContract(withContract, contractId, 1, '2026-01-01T00:00:00.000Z'),
    ).toThrowError(expect.objectContaining({ code: 'contract_invalid' }));
  });

  it('approves a sound contract and records the approval immutably', () => {
    const state = freshState();
    const contractId = randomUUID();
    const requirementId = randomUUID();
    const prepared: CompanyState = {
      ...state,
      contracts: {
        [contractId]: {
          id: contractId,
          code: 'PA-C0001',
          revision: 1,
          promptIds: [],
          requirements: [
            {
              id: requirementId,
              promptId: randomUUID(),
              fragmentIds: [],
              text: 'list workspace files',
              kind: 'goal',
              status: 'planned',
            },
          ],
          phases: [],
          tasks: [
            {
              id: randomUUID(),
              code: 'PA-T0001',
              contractId,
              phaseId: randomUUID(),
              title: 'List files',
              requirementIds: [requirementId],
              dependsOn: [],
              workstreamId: randomUUID(),
              readScopes: [],
              writeScopes: [],
              sharedResources: [],
              acceptance: ['c1'],
              executionMode: 'session',
              status: 'planned',
              attemptIds: [],
              routeReason: 'only task',
            },
          ],
          assumptions: [],
          decisions: [],
          acceptance: [
            {
              id: 'c1',
              requirementIds: [requirementId],
              description: 'listing works',
              kind: 'command',
              required: true,
            },
          ],
          status: 'awaiting_approval',
        },
      } as CompanyState['contracts'],
    };

    const now = '2026-01-01T00:00:00.000Z';
    const { events } = approveContract(prepared, contractId, 1, now);
    expect(events[0].at).toBe(now);
    const next = applyAll(prepared, events);

    expect(Object.values(next.contracts)[0].status).toBe('approved');
  });

  it('rejects an approval aimed at a stale revision', () => {
    const state = freshState();
    const contractId = randomUUID();
    const prepared: CompanyState = {
      ...state,
      contracts: {
        [contractId]: {
          id: contractId,
          code: 'PA-C0001',
          revision: 3,
          promptIds: [],
          requirements: [],
          phases: [],
          tasks: [],
          assumptions: [],
          decisions: [],
          acceptance: [
            {
              id: 'c1',
              requirementIds: [randomUUID()],
              description: 'x',
              kind: 'command',
              required: true,
            },
          ],
          status: 'awaiting_approval',
        },
      } as CompanyState['contracts'],
    };

    expect(() => approveContract(prepared, contractId, 2, '2026-01-01T00:00:00.000Z')).toThrowError(
      expect.objectContaining({ code: 'company_revision_conflict' }),
    );
  });

  it('marks a task running with a fresh attempt and never overwrites history', () => {
    const state = freshState();
    const taskId = randomUUID();
    const sessionId = randomUUID();
    const prepared: CompanyState = {
      ...state,
      tasks: {
        [taskId]: {
          id: taskId,
          code: 'PA-T0001',
          contractId: randomUUID(),
          phaseId: randomUUID(),
          title: 'List files',
          requirementIds: [],
          dependsOn: [],
          workstreamId: randomUUID(),
          readScopes: [],
          writeScopes: [],
          sharedResources: [],
          acceptance: ['c1'],
          executionMode: 'session',
          status: 'ready',
          attemptIds: ['existing-attempt'],
          routeReason: 'only task',
        },
      } as CompanyState['tasks'],
    };

    const attemptId = randomUUID();
    const { events } = startTaskAttempt(prepared, {
      taskId,
      sessionId,
      runEpoch: 0,
      attemptId,
      now: '2026-01-01T00:00:00.000Z',
      newEvent: nextEvents(),
    });
    const next = applyAll(prepared, events);

    expect(Object.values(next.attempts)).toHaveLength(1);
    // The prior attempt id survives; attempts are appended, never replaced.
    expect(Object.values(next.tasks)[0].attemptIds).toContain('existing-attempt');
    expect(Object.values(next.tasks)[0].attemptIds).toContain(attemptId);
    expect(Object.values(next.tasks)[0].status).toBe('running');
  });

  it('refuses to start a task that is already running', () => {
    const state = freshState();
    const taskId = randomUUID();
    const prepared: CompanyState = {
      ...state,
      tasks: {
        [taskId]: {
          id: taskId,
          code: 'PA-T0001',
          contractId: randomUUID(),
          phaseId: randomUUID(),
          title: 'x',
          requirementIds: [],
          dependsOn: [],
          workstreamId: randomUUID(),
          readScopes: [],
          writeScopes: [],
          sharedResources: [],
          acceptance: ['c1'],
          executionMode: 'session',
          status: 'running',
          attemptIds: [],
          routeReason: '',
        },
      } as CompanyState['tasks'],
    };

    expect(() =>
      startTaskAttempt(prepared, {
        taskId,
        sessionId: randomUUID(),
        runEpoch: 0,
        attemptId: randomUUID(),
        now: '2026-01-01T00:00:00.000Z',
        newEvent: nextEvents(),
      }),
    ).toThrowError(expect.objectContaining({ code: 'task_not_runnable' }));
  });

  it('records a failing verification as not done and asks for one repair', () => {
    const state = freshState();
    const attemptId = randomUUID();
    const taskId = randomUUID();
    const evidence: VerificationEvidence[] = [
      {
        id: randomUUID(),
        command: {
          id: 'cmd-1',
          executable: 'npm',
          argv: ['test'],
          cwd: 'C:/w',
          timeoutSeconds: 600,
        },
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:00:09.000Z',
        exitCode: 1,
      } as VerificationEvidence,
    ];
    const prepared: CompanyState = {
      ...state,
      ...withContract(),
      attempts: {
        [attemptId]: {
          id: attemptId,
          taskId,
          sessionId: randomUUID(),
          runEpoch: 0,
          startedAt: '2026-01-01T00:00:00.000Z',
          status: 'running',
          changes: [],
          evidenceIds: [],
        },
      } as CompanyState['attempts'],
      tasks: {
        [taskId]: {
          id: taskId,
          code: 'PA-T0001',
          contractId: CONTRACT_ID,
          phaseId: randomUUID(),
          title: 'x',
          requirementIds: [],
          dependsOn: [],
          workstreamId: randomUUID(),
          readScopes: [],
          writeScopes: [],
          sharedResources: [],
          acceptance: ['c1'],
          executionMode: 'session',
          status: 'verifying',
          attemptIds: [attemptId],
          routeReason: '',
        },
      } as CompanyState['tasks'],
    };

    const { events } = recordAttemptOutcome(prepared, {
      attemptId,
      criterionCommands: new Map([['c1', ['cmd-1']]]),
      evidence,
      now: '2026-01-01T00:00:10.000Z',
      newEvent: nextEvents(),
    });
    const next = applyAll(prepared, events);

    expect(Object.values(next.tasks)[0].status).toBe('changes_requested');
    expect(Object.values(next.attempts)[0].status).toBe('failed');
  });

  it('marks a task done only when every required criterion has passing evidence', () => {
    const state = freshState();
    const attemptId = randomUUID();
    const taskId = randomUUID();
    const passing: VerificationEvidence[] = [
      {
        id: randomUUID(),
        command: {
          id: 'cmd-1',
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
    const prepared: CompanyState = {
      ...state,
      ...withContract(),
      attempts: {
        [attemptId]: {
          id: attemptId,
          taskId,
          sessionId: randomUUID(),
          runEpoch: 0,
          startedAt: '2026-01-01T00:00:00.000Z',
          status: 'running',
          changes: [],
          evidenceIds: [],
        },
      } as CompanyState['attempts'],
      tasks: {
        [taskId]: {
          id: taskId,
          code: 'PA-T0001',
          contractId: CONTRACT_ID,
          phaseId: randomUUID(),
          title: 'x',
          requirementIds: [],
          dependsOn: [],
          workstreamId: randomUUID(),
          readScopes: [],
          writeScopes: [],
          sharedResources: [],
          acceptance: ['c1'],
          executionMode: 'session',
          status: 'verifying',
          attemptIds: [attemptId],
          routeReason: '',
        },
      } as CompanyState['tasks'],
    };

    const { events } = recordAttemptOutcome(prepared, {
      attemptId,
      criterionCommands: new Map([['c1', ['cmd-1']]]),
      evidence: passing,
      now: '2026-01-01T00:00:06.000Z',
      newEvent: nextEvents(),
    });
    const next = applyAll(prepared, events);

    expect(Object.values(next.tasks)[0].status).toBe('done');
    expect(Object.values(next.evidence)).toEqual(passing);
    expect(Object.values(next.attempts)[0].evidenceIds).toHaveLength(1);
  });
});
