import { describe, expect, it } from 'vitest';

import type { CompanyViewState } from '../src/company/companyState.js';
import {
  type DrawerSubject,
  drawerSubjectFor,
  drawerSubjectKey,
} from '../src/company/selection.js';
import { session, stateFrom, task } from './companyFixtures.js';

describe('drawerSubjectFor', () => {
  it('shows what the user opened, over the shared selection', () => {
    const work = task();
    const worker = session();
    const base = stateFrom({ tasks: [work], sessions: [worker] });
    const state: CompanyViewState = {
      ...base,
      selection: { sessionId: worker.id, taskId: work.id, tab: null },
    };

    expect(drawerSubjectFor(state, { kind: 'contract' })).toEqual({ kind: 'contract' });
  });

  it('shows the selected task first, then the selected session, else nothing', () => {
    const work = task();
    const worker = session();
    const base = stateFrom({ tasks: [work], sessions: [worker] });

    expect(
      drawerSubjectFor(
        { ...base, selection: { sessionId: worker.id, taskId: work.id, tab: null } },
        null,
      ),
    ).toEqual({ kind: 'task', taskId: work.id });
    expect(
      drawerSubjectFor(
        { ...base, selection: { sessionId: worker.id, taskId: null, tab: null } },
        null,
      ),
    ).toEqual({ kind: 'session', sessionId: worker.id });
    expect(drawerSubjectFor(base, null)).toBeNull();
  });

  it('falls past a task the server no longer holds to the selected session', () => {
    const worker = session();
    const base = stateFrom({ sessions: [worker] });

    expect(
      drawerSubjectFor(
        { ...base, selection: { sessionId: worker.id, taskId: 'gone', tab: null } },
        null,
      ),
    ).toEqual({ kind: 'session', sessionId: worker.id });
  });

  it('ignores a selection the server no longer holds at all', () => {
    const base = stateFrom();

    expect(
      drawerSubjectFor(
        { ...base, selection: { sessionId: 'gone', taskId: 'gone', tab: null } },
        null,
      ),
    ).toBeNull();
  });
});

describe('drawerSubjectKey', () => {
  it('keys each subject distinctly, so a retained subject is recognised by identity', () => {
    const subjects: DrawerSubject[] = [
      { kind: 'task', taskId: 't1' },
      { kind: 'session', sessionId: 's1' },
      { kind: 'herdr', paneId: 'p1' },
      { kind: 'question', questionId: 'q1' },
      { kind: 'contract' },
      { kind: 'files' },
    ];

    const keys = subjects.map((subject) => drawerSubjectKey(subject));

    expect(new Set(keys).size).toBe(subjects.length);
  });

  it('does not confuse a task with a session that shares its id', () => {
    expect(drawerSubjectKey({ kind: 'task', taskId: 'same' })).not.toBe(
      drawerSubjectKey({ kind: 'session', sessionId: 'same' }),
    );
    expect(drawerSubjectKey({ kind: 'task', taskId: 't1' })).toBe('task:t1');
  });
});
