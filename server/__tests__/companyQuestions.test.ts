import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { CompanyState, Question, QuestionAnswerInput } from '../../core/src/company.js';
import { answerQuestion, controlSession } from '../src/company/companyEngine.js';
import { createInitialCompanyState } from '../src/company/companyState.js';
import { applyCompanyEvent } from '../src/company/companyState.js';

const SESSION_ID = '33333333-3333-4333-8333-333333333333';

function question(overrides: Partial<Question> = {}): Question {
  return {
    id: randomUUID(),
    sessionId: SESSION_ID,
    runEpoch: 2,
    kind: 'approval',
    title: 'Approve writing src/app.ts?',
    questions: [
      {
        id: 'q1',
        question: 'Approve?',
        options: [
          { id: 'o1', label: 'Approve once', description: 'write the file' },
          { id: 'o2', label: 'Reject' },
        ],
        recommended: 'o1',
      },
    ],
    actionDigest: 'digest-abc',
    status: 'pending',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as unknown as Question;
}

function answerInput(
  overrides: Partial<QuestionAnswerInput> = {},
): QuestionAnswerInput & { now: string } {
  return {
    requestId: randomUUID(),
    questionId: '',
    runEpoch: 2,
    answers: { q1: { selectedIndices: [0], isOther: false } },
    decision: 'approve_once',
    now: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as QuestionAnswerInput & { now: string };
}

function stateWithQuestion(q: Question): CompanyState {
  return { ...createInitialCompanyState('C:/w'), questions: { [q.id]: q } };
}

describe('question lifecycle', () => {
  it('uses the caller timestamp for the answer and journal event', () => {
    const q = question();
    const state = stateWithQuestion(q);
    const now = '2030-07-08T09:10:11.000Z';

    const { events } = answerQuestion(state, {
      ...answerInput({ questionId: q.id }),
      now,
      newEvent: { id: randomUUID() },
    });
    const next = applyCompanyEvent(state, events[0]);
    const stored = Object.values(next.questions)[0];

    expect(stored.resolvedAt).toBe(now);
    expect(events[0].at).toBe(now);
    expect(stored.status).toBe('answered');
    expect(stored.answer?.decision).toBe('approve_once');
  });

  it('refuses a second answer to the same question', () => {
    const q = question();
    const answered = applyCompanyEvent(
      stateWithQuestion(q),
      answerQuestion(stateWithQuestion(q), {
        ...answerInput({ questionId: q.id }),
        newEvent: { id: randomUUID() },
      }).events[0],
    );

    expect(() =>
      answerQuestion(answered, {
        ...answerInput({ questionId: q.id }),
        newEvent: { id: randomUUID() },
      }),
    ).toThrowError(expect.objectContaining({ code: 'question_not_pending' }));
  });

  it('refuses an answer aimed at a stale run epoch', () => {
    const q = question();
    const state = stateWithQuestion(q);

    expect(() =>
      answerQuestion(state, {
        ...answerInput({ questionId: q.id, runEpoch: 1 }),
        newEvent: { id: randomUUID() },
      }),
    ).toThrowError(expect.objectContaining({ code: 'stale_run_epoch' }));
  });

  it('refuses an approval whose payload digest no longer matches', () => {
    const q = question();
    const state = stateWithQuestion(q);

    expect(() =>
      answerQuestion(state, {
        ...answerInput({ questionId: q.id, actionDigest: 'a-different-action' }),
        newEvent: { id: randomUUID() },
      }),
    ).toThrowError(expect.objectContaining({ code: 'approval_stale' }));
  });

  it('marks a rejected approval as rejected, not answered', () => {
    const q = question();
    const state = stateWithQuestion(q);

    const next = applyCompanyEvent(
      state,
      answerQuestion(state, {
        ...answerInput({ questionId: q.id, decision: 'reject' }),
        newEvent: { id: randomUUID() },
      }).events[0],
    );

    expect(Object.values(next.questions)[0].status).toBe('rejected');
  });
});

describe('session control', () => {
  function sessionState(status: string, runEpoch = 2): CompanyState {
    return {
      ...createInitialCompanyState('C:/w'),
      sessions: {
        [SESSION_ID]: {
          id: SESSION_ID,
          code: 'PA-S0001',
          name: 'worker-1',
          role: 'worker',
          workstreamId: 'w1',
          workspaceKey: 'c:/w',
          requestedModel: 'p/m',
          runEpoch,
          status,
          lastUsedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    } as CompanyState;
  }

  it('bumps the epoch on restart so old answers cannot land', () => {
    const state = sessionState('busy');

    const next = applyCompanyEvent(
      state,
      controlSession(state, SESSION_ID, 'restart', 2, '2026-01-01T00:00:00.000Z', {
        id: randomUUID(),
      }).events[0],
    );

    expect(Object.values(next.sessions)[0].runEpoch).toBe(3);
    expect(Object.values(next.sessions)[0].status).toBe('stopping');
  });

  it('refuses a control aimed at a stale epoch', () => {
    const state = sessionState('busy', 5);

    expect(() =>
      controlSession(state, SESSION_ID, 'pause', 4, '2026-01-01T00:00:00.000Z', {
        id: randomUUID(),
      }),
    ).toThrowError(expect.objectContaining({ code: 'stale_run_epoch' }));
  });

  it('pauses and resumes an idle session without changing its epoch', () => {
    const paused = applyCompanyEvent(
      sessionState('idle'),
      controlSession(sessionState('idle'), SESSION_ID, 'pause', 2, '2026-01-01T00:00:00.000Z', {
        id: randomUUID(),
      }).events[0],
    );

    expect(Object.values(paused.sessions)[0].status).toBe('pausing');
    expect(Object.values(paused.sessions)[0].runEpoch).toBe(2);

    const resumed = applyCompanyEvent(
      paused,
      controlSession(paused, SESSION_ID, 'resume', 2, '2026-01-01T00:00:00.000Z', {
        id: randomUUID(),
      }).events[0],
    );
    // Resume re-arms the process, so the session is `starting` until the native
    // run reports ready — claiming `idle` here would report a live process as
    // one that was never launched.
    expect(Object.values(resumed.sessions)[0].status).toBe('starting');
    expect(Object.values(resumed.sessions)[0].runEpoch).toBe(2);
  });

  it('archives a session and keeps its record', () => {
    const state = sessionState('idle');

    const next = applyCompanyEvent(
      state,
      controlSession(state, SESSION_ID, 'archive', 2, '2026-01-01T00:00:00.000Z', {
        id: randomUUID(),
      }).events[0],
    );

    // Archive frees a pool slot; it never deletes the session or its transcript.
    expect(Object.values(next.sessions)).toHaveLength(1);
    expect(Object.values(next.sessions)[0].status).toBe('archived');
  });

  it('refuses an unknown session', () => {
    expect(() =>
      controlSession(sessionState('idle'), randomUUID(), 'pause', 2, '2026-01-01T00:00:00.000Z', {
        id: randomUUID(),
      }),
    ).toThrowError(expect.objectContaining({ code: 'session_not_found' }));
  });
});
